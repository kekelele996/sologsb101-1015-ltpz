/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3：把「现场巡查记录」从加固件台账拆出（supportChecks 表）；
 *   台账 Support 只管安装日期与检查周期，最近 / 下次检查日期按最新巡查记录计算。
 * - 提供各表增删改查、巡查记录批量并入、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type {
  SupportCheck,
  SupportCheckMergeItem,
  SupportCheckMergeOutcome,
} from '../types/supportCheck'
import { CHECK_RESULT_OPTIONS } from '../types/supportCheck'
import { nowIso } from './id'
import { seedDatabase } from './seed'
import { deriveLegacyBackfill } from './supportCheck'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  supportChecks!: Table<SupportCheck, string>
  reviews!: Table<Review, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
      // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
      surveys: 'id, treeId, [treeId+date], date, siteNote',
      measures: 'id, treeId, type, state, date, operator',
      supports: 'id, treeId, type, installDate, lastCheckDate',
      reviews: 'id, treeId, date, vigor, trend',
    })

    // ---------- v3：台账与现场巡查记录分表 ----------
    // - supports 去掉 lastCheckDate 索引（字段本身在 upgrade 中删除）；
    // - 新增 supportChecks：按 supportId、[treeId+type]、date 建索引；
    // - 旧台账按安装日期 / 周期补出首条巡查记录，补不出的标 backfillIssue 单列。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate',
        supportChecks: 'id, supportId, treeId, [treeId+type], date, inspector',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // v1→v2 的字段补齐（全新库不会执行 upgrade；升级路径上统一兜底）
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.revision !== 'number') row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })

        // v3：加固件台账去掉最近检查日期、补 backfillIssue；按安装日期补首条巡查记录
        const legacyChecks: SupportCheck[] = []
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
          const derived = deriveLegacyBackfill(row)
          if (derived.ok) {
            row.backfillIssue = ''
            const stamp = typeof row.updatedAt === 'string' ? row.updatedAt : nowIso()
            legacyChecks.push({
              id: `supportcheck-legacy-${String(row.id)}`,
              treeId: String(row.treeId),
              type: row.type as SupportCheck['type'],
              date: derived.date,
              inspector: '',
              result: '正常',
              note: derived.usedLastCheck
                ? '旧数据升级：按台账最近检查日期补出的首条现场记录'
                : '旧数据升级：按加固件安装日期补出的首条现场记录（安装即首检）',
              supportId: String(row.id),
              source: 'legacy-backfill',
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            })
          } else {
            row.backfillIssue = derived.issue
          }
          delete row.lastCheckDate
          row.revision = ROW_REVISION
        })
        if (legacyChecks.length > 0) {
          await tx.table('supportChecks').bulkPut(legacyChecks)
        }
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除古树并级联清理其检查、措施、加固、巡查与复评记录 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.supportChecks, db.reviews],
    async () => {
      await db.surveys.where('treeId').equals(id).delete()
      await db.measures.where('treeId').equals(id).delete()
      await db.supports.where('treeId').equals(id).delete()
      await db.supportChecks.where('treeId').equals(id).delete()
      await db.reviews.where('treeId').equals(id).delete()
      await db.trees.delete(id)
    }
  )
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/* ------------------------------ 复壮措施 ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------------------ 加固件台账 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除加固件台账行；同时清理其名下已关联的现场巡查记录（对不上的巡查记录保留） */
export async function removeSupport(id: string): Promise<void> {
  await db.transaction('rw', db.supports, db.supportChecks, async () => {
    await db.supportChecks.where('supportId').equals(id).delete()
    await db.supports.delete(id)
  })
}

/* ---------------------------- 加固件现场巡查 ---------------------------- */

export async function listSupportChecks(): Promise<SupportCheck[]> {
  const rows = await db.supportChecks.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.treeId.localeCompare(b.treeId))
}

export async function listSupportChecksByTree(treeId: string): Promise<SupportCheck[]> {
  const rows = await db.supportChecks.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSupportCheck(row: SupportCheck): Promise<void> {
  await db.supportChecks.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSupportCheck(id: string): Promise<void> {
  await db.supportChecks.delete(id)
}

/** 台账某件是否已有完全相同的现场记录（古树+类型+日期+检查人+结论），用于并入幂等 */
async function findDuplicateSupportCheck(item: SupportCheckMergeItem, treeId: string): Promise<SupportCheck | undefined> {
  const sameTree = await db.supportChecks.where('treeId').equals(treeId).toArray()
  return sameTree.find(
    (row) =>
      row.type === item.type &&
      row.date === item.date &&
      row.inspector === item.inspector.trim() &&
      row.result === item.result &&
      row.note === item.note.trim()
  )
}

/**
 * 巡查班组现场记录并入（按条独立提交，幂等）。
 * - 每条用各自的事务写入：成功的照留，失败的只影响本条；
 * - 返回 failed / reasons，调用方重试时只需重发 failed（巡查这一侧），台账侧不动；
 * - 已并入过（古树+类型+日期+检查人+结论完全一致）的直接判为成功，不重复写。
 */
export async function mergeSupportChecks(items: SupportCheckMergeItem[]): Promise<SupportCheckMergeOutcome> {
  const merged: number[] = []
  const failed: SupportCheckMergeItem[] = []
  const reasons: string[] = []

  for (const item of items) {
    try {
      const code = item.treeCode?.trim() ?? ''
      if (code === '') throw new Error('古树编号为空')
      if (!isValidDate(item.date)) throw new Error(`检查日期非法：${String(item.date)}`)
      if (item.inspector.trim() === '') throw new Error('检查人为空')
      if (!CHECK_RESULT_OPTIONS.includes(item.result)) throw new Error(`现场结论非法：${String(item.result)}`)
      if (item.note.trim() === '') throw new Error('现场结论备注为空')

      const tree = await db.trees.where('code').equals(code).first()
      if (!tree) throw new Error(`古树编号「${code}」在档案中查不到`)

      const dup = await findDuplicateSupportCheck(item, tree.id)
      if (dup !== undefined) {
        merged.push(1)
        continue
      }

      // 按古树 + 类型核对台账：唯一对得上才回填 supportId；同类型多件无法唯一确定时留空
      const matches = (await db.supports.where('treeId').equals(tree.id).toArray()).filter(
        (support) => support.type === item.type && support.backfillIssue === ''
      )
      const supportId = matches.length === 1 ? matches[0].id : ''
      const stamp = nowIso()
      await db.supportChecks.put({
        id: `supportcheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        treeId: tree.id,
        type: item.type,
        date: item.date,
        inspector: item.inspector.trim(),
        result: item.result,
        note: item.note.trim(),
        supportId,
        source: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      })
      merged.push(1)
    } catch (error) {
      failed.push(item)
      reasons.push(error instanceof Error ? error.message : '并入失败')
    }
  }

  return { merged: merged.length, failed, reasons }
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  /** v3 新增；旧版存档没有时按台账安装日期补首条 */
  supportChecks?: SupportCheck[]
  reviews: Review[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, supportChecks, reviews] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.supportChecks.toArray(),
    db.reviews.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    supportChecks,
    reviews,
  }
}

/** 用快照覆盖整库（导入存档）；旧版（无 supportChecks）按台账安装日期补首条巡查记录 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const checks = normalizeImportedChecks(snapshot)
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.supportChecks, db.reviews],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.supportChecks.clear(),
        db.reviews.clear(),
      ])
      await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.supports.bulkPut(snapshot.supports.map(normalizeImportedSupport))
      await db.supportChecks.bulkPut(checks)
      await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
    }
  )
}

/** 规范化导入的台账行：去掉旧字段 lastCheckDate，补 backfillIssue */
function normalizeImportedSupport(row: Support): Support {
  const { lastCheckDate: _drop, ...rest } = (row ?? {}) as Support & { lastCheckDate?: string }
  void _drop
  return {
    ...rest,
    backfillIssue: typeof rest.backfillIssue === 'string' ? rest.backfillIssue : '',
    revision: ROW_REVISION,
  } as Support
}

/**
 * 规范化导入的现场巡查记录。
 * 存档自带 supportChecks（v3）时采用并规范化；旧版存档缺该数组时，
 * 按每条台账的安装日期 / 周期补出首条记录，补不出的在台账上标 backfillIssue。
 */
function normalizeImportedChecks(snapshot: DatabaseSnapshot): SupportCheck[] {
  const raw = snapshot.supportChecks
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((row) => ({
      ...row,
      supportId: typeof row.supportId === 'string' ? row.supportId : '',
      source: row.source === 'legacy-backfill' ? 'legacy-backfill' : '',
      revision: ROW_REVISION,
    }))
  }
  // 旧版存档：从台账补首条
  const checks: SupportCheck[] = []
  snapshot.supports.forEach((support) => {
    const legacy = support as Support & { lastCheckDate?: string }
    const derived = deriveLegacyBackfill({
      installDate: support.installDate,
      lastCheckDate: legacy.lastCheckDate,
      checkCycleMon: support.checkCycleMon,
    })
    if (derived.ok) {
      checks.push({
        id: `supportcheck-legacy-${support.id}`,
        treeId: support.treeId,
        type: support.type,
        date: derived.date,
        inspector: '',
        result: '正常',
        note: derived.usedLastCheck
          ? '旧存档导入：按台账最近检查日期补出的首条现场记录'
          : '旧存档导入：按加固件安装日期补出的首条现场记录（安装即首检）',
        supportId: support.id,
        source: 'legacy-backfill',
        createdAt: support.createdAt ?? nowIso(),
        updatedAt: support.updatedAt ?? nowIso(),
        revision: ROW_REVISION,
      })
      support.backfillIssue = ''
    } else {
      support.backfillIssue = derived.issue
    }
  })
  return checks
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.supportChecks, db.reviews],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.supportChecks.clear(),
        db.reviews.clear(),
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, supportChecks, reviews] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.supportChecks.count(),
    db.reviews.count(),
  ])
  return { trees, surveys, measures, supports, supportChecks, reviews }
}
