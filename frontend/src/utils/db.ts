/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { SupportCheck } from '../types/supportCheck'
import type { Review } from '../types/review'
import { nowIso } from './id'
import { buildMigratedFirstChecks } from './supportCheck'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/**
 * 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移）
 * v3：加固件台账与现场巡查记录拆分，新增 supportChecks 表，supports 去掉 lastCheckDate。
 */
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
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」（v3 起该字段迁去现场巡查记录）
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：台账（周期）与现场巡查记录（检查人 / 现场结论）拆分 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        // lastCheckDate 索引随字段一并移除，检查日期改由 supportChecks 提供
        supports: 'id, treeId, type, installDate',
        // [treeId+type]：台账与巡查按古树编号 + 类型对账
        supportChecks: 'id, supportId, treeId, [treeId+type], date',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso()
        const supportRows = (await tx.table('supports').toArray()) as Array<
          Support & { lastCheckDate?: unknown }
        >
        // 旧数据升级：优先沿用旧最近检查日期，没有则按安装日期 + 一个周期补出首条巡查；
        // 两个日期都不合法时补不出，不建记录，升级后自然落入「台账有件 / 巡查无记录」对账名单。
        const { checks } = buildMigratedFirstChecks(supportRows)
        if (checks.length > 0) {
          await tx
            .table('supportChecks')
            .bulkPut(checks.map((row) => ({ ...row, createdAt: stamp, updatedAt: stamp, revision: ROW_REVISION })))
        }
        // 台账侧彻底去掉最近检查日期
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          delete row.lastCheckDate
          row.updatedAt = stamp
          row.revision = ROW_REVISION
        })
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

/** 删除古树并级联清理其检查、措施、加固件、现场巡查与复评记录 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.supportChecks, db.reviews],
    async () => {
      await db.surveys.where('treeId').equals(id).delete()
      await db.measures.where('treeId').equals(id).delete()
      await db.supportChecks.where('treeId').equals(id).delete()
      await db.supports.where('treeId').equals(id).delete()
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

/* ------------------------------ 加固件 ------------------------------ */

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

/**
 * 删除加固件台账。
 * 现场巡查记录照留（巡查是班组已完成的事实记录），台账删掉后这些记录因对不上件进入对账名单。
 */
export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
}

/* ---------------------------- 加固件现场巡查 ---------------------------- */

export async function listSupportChecks(): Promise<SupportCheck[]> {
  return db.supportChecks.toArray()
}

export async function listSupportChecksByTree(treeId: string): Promise<SupportCheck[]> {
  return db.supportChecks.where('treeId').equals(treeId).toArray()
}

/** 写入单条现场巡查记录（不触碰台账，巡查侧失败不影响台账） */
export async function putSupportCheck(row: SupportCheck): Promise<void> {
  await db.supportChecks.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSupportCheck(id: string): Promise<void> {
  await db.supportChecks.delete(id)
}

export interface MergeSupportChecksResult {
  /** 成功并入的巡查记录 id */
  merged: string[]
  /** 并入失败的巡查记录 id（重试时只重试这一侧） */
  failed: Array<{ id: string; message: string }>
}

/**
 * 巡查记录并入台账后的回写。
 * 台账与巡查两边拆开，并入只发生在巡查这一侧：逐条写入，某条失败只记到 failed，
 * 已经并进去的照留、不回滚，重试时由调用方只重发失败条目。
 */
export async function mergeSupportChecks(rows: SupportCheck[]): Promise<MergeSupportChecksResult> {
  const merged: string[] = []
  const failed: Array<{ id: string; message: string }> = []
  for (const row of rows) {
    try {
      await putSupportCheck(row)
      merged.push(row.id)
    } catch (error) {
      failed.push({ id: row.id, message: error instanceof Error ? error.message : '巡查记录并入失败' })
    }
  }
  return { merged, failed }
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
  supportChecks: SupportCheck[]
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

/**
 * 规范化旧版（v1 / v2）快照：
 * - supports 去掉遗留 lastCheckDate（台账只管周期与下次检查日期）
 * - 旧快照没有 supportChecks 时，按安装日期 + 周期补出首条巡查（补不出的交对账名单）
 */
function normalizeSnapshot(snapshot: DatabaseSnapshot): { supports: Support[]; supportChecks: SupportCheck[] } {
  const stamp = nowIso()
  const legacySupports = snapshot.supports as Array<Support & { lastCheckDate?: unknown }>
  const supports: Support[] = legacySupports.map(({ lastCheckDate: _lastCheckDate, ...row }) => ({
    ...row,
    revision: ROW_REVISION,
  }))
  const rawChecks = Array.isArray(snapshot.supportChecks) ? snapshot.supportChecks : []
  const supportChecks: SupportCheck[] =
    rawChecks.length > 0
      ? rawChecks
      : buildMigratedFirstChecks(legacySupports).checks.map((row) => ({
          ...row,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        }))
  return { supports, supportChecks }
}

/** 用快照覆盖整库（导入存档，兼容 v1 / v2 旧档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const { supports, supportChecks } = normalizeSnapshot(snapshot)
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
      await db.supports.bulkPut(supports)
      await db.supportChecks.bulkPut(supportChecks)
      await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
    }
  )
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
