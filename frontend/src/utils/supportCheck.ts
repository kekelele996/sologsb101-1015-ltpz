/**
 * 加固件台账 ↔ 现场巡查记录 对账与派生工具
 * - 两边按「古树编号 + 加固件类型」对账，对不上的分三类单列：
 *   ledgerMissing：台账有件、巡查侧没有记录挂上来（含旧数据补不出首条的）
 *   orphanChecks：巡查记录在台账里找不到同古树同类型的件
 *   ambiguousChecks：同古树同类型台账有多件，空挂接巡查无法确定归哪件
 * - 下次检查日期 / 超期一律以最新一条现场巡查日期为准，无巡查时回退安装日期
 */
import type { Support } from '../types/support'
import type { SupportCheck, SupportCheckResult } from '../types/supportCheck'
import { addMonths, isSupportOverdue, nextCheckDate, overdueDays } from './dimension'

/** 古树 + 类型 复合对账键 */
export function supportKey(treeId: string, type: string): string {
  return `${treeId}#@#${type}`
}

/** 合法 YYYY-MM-DD 日期 */
export function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

/** 同一加固件的巡查记录，按检查日期升序（同日按创建时间兜底） */
export function sortChecksByDate(list: SupportCheck[]): SupportCheck[] {
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
}

/** 巡查记录的对账归属状态 */
export type CheckLinkStatus = 'linked' | 'orphan' | 'ambiguous'

export interface CheckLink {
  status: CheckLinkStatus
  /** linked 时挂到的台账件 */
  support: Support | null
}

/**
 * 唯一权威的归属解析：一条巡查最多挂到一件台账。
 * - supportId 有效：直接挂该件（台账改了古树 / 类型也以 supportId 为准）
 * - supportId 为空或指向已删除件，且古树+类型恰好对应一件：兜底挂那件
 * - 古树+类型对应多件、无法确定是哪件：ambiguous（保守不归属，避免一条巡查重复计入多件）
 * - 古树+类型在台账里没有件：orphan（「台账无此件」）
 */
export function resolveCheckLinks(supports: Support[], checks: SupportCheck[]): Map<string, CheckLink> {
  const supportById = new Map(supports.map((row) => [row.id, row]))
  const supportsByKey = new Map<string, Support[]>()
  supports.forEach((row) => {
    const key = supportKey(row.treeId, row.type)
    supportsByKey.set(key, [...(supportsByKey.get(key) ?? []), row])
  })

  const result = new Map<string, CheckLink>()
  for (const check of checks) {
    if (check.supportId !== '') {
      const exact = supportById.get(check.supportId)
      if (exact !== undefined) {
        result.set(check.id, { status: 'linked', support: exact })
        continue
      }
    }
    const candidates = supportsByKey.get(supportKey(check.treeId, check.type)) ?? []
    if (candidates.length === 1) {
      result.set(check.id, { status: 'linked', support: candidates[0] })
    } else if (candidates.length > 1) {
      result.set(check.id, { status: 'ambiguous', support: null })
    } else {
      result.set(check.id, { status: 'orphan', support: null })
    }
  }
  return result
}

/** 挂到某件台账上的全部巡查记录（按日期升序）；一条巡查不会同时挂到多件 */
export function checksForSupport(
  support: Support,
  checks: SupportCheck[],
  links?: Map<string, CheckLink>
): SupportCheck[] {
  const resolved = links ?? resolveCheckLinks([support], checks)
  const own = checks.filter((row) => resolved.get(row.id)?.support?.id === support.id)
  return sortChecksByDate(own)
}

/** 取一件加固件最新一条现场巡查记录（没有返回 null） */
export function latestCheckOf(support: Support, checks: SupportCheck[]): SupportCheck | null {
  const own = checksForSupport(support, checks)
  if (own.length === 0) return null
  return own[own.length - 1]
}

/** 超期判定基准日期：最新巡查日期，没有巡查记录时回退安装日期 */
export function supportBaseDate(support: Support, checks: SupportCheck[]): string {
  return latestCheckOf(support, checks)?.date ?? support.installDate
}

export interface SupportCheckView {
  support: Support
  latest: SupportCheck | null
  baseDate: string
  nextDate: string
  overdue: boolean
  overdueDays: number
  checkCount: number
}

/** 把台账与巡查合成台账视图（下次检查 / 超期均按最新巡查算；一次解析共用） */
export function buildSupportViews(supports: Support[], checks: SupportCheck[]): SupportCheckView[] {
  const links = resolveCheckLinks(supports, checks)
  return supports.map((support) => {
    const own = checksForSupport(support, checks, links)
    const latest = own.length > 0 ? own[own.length - 1] : null
    const baseDate = latest?.date ?? (isValidDate(support.installDate) ? support.installDate : '')
    return {
      support,
      latest,
      baseDate,
      nextDate: nextCheckDate(baseDate, support.checkCycleMon),
      overdue: isSupportOverdue(baseDate, support.checkCycleMon),
      overdueDays: overdueDays(baseDate, support.checkCycleMon),
      checkCount: own.length,
    }
  })
}

export interface ReconcileResult {
  /** 台账有件、却没有任何巡查记录挂上来（含旧数据补不出首条的） */
  ledgerMissing: Support[]
  /** 巡查侧有记录、台账里完全没有同古树同类型的件（「台账无此件」） */
  orphanChecks: SupportCheck[]
  /** 古树 + 类型在台账里有多件，空挂接的巡查无法确定归属哪一件 */
  ambiguousChecks: SupportCheck[]
}

/** 两边按古树编号 + 类型对账，对不上的分类单列。 */
export function reconcile(supports: Support[], checks: SupportCheck[]): ReconcileResult {
  const links = resolveCheckLinks(supports, checks)
  const linkedSupportIds = new Set<string>()
  const orphanChecks: SupportCheck[] = []
  const ambiguousChecks: SupportCheck[] = []
  checks.forEach((check) => {
    const link = links.get(check.id)
    if (link === undefined) return
    if (link.status === 'linked' && link.support !== null) {
      linkedSupportIds.add(link.support.id)
    } else if (link.status === 'ambiguous') {
      ambiguousChecks.push(check)
    } else {
      orphanChecks.push(check)
    }
  })
  const ledgerMissing = supports.filter((row) => !linkedSupportIds.has(row.id))
  return { ledgerMissing, orphanChecks, ambiguousChecks }
}

/** 现场结论对应的标签色调 */
export function checkResultTagType(result: SupportCheckResult): 'success' | 'warning' | 'danger' {
  if (result === '异常') return 'danger'
  if (result === '需关注') return 'warning'
  return 'success'
}

/**
 * 旧数据升级：按安装日期 + 周期给加固件补出首条现场巡查记录。
 * - 旧台账留有最近检查日期且日期合法：沿用该日期（与升级前的超期判定保持一致）
 * - 没有最近检查日期、安装日期合法：首检日期取安装日期 + 一个周期
 * - 两个日期都不合法：补不出，交由调用方计入对账异常名单
 * 返回补录巡查（id 固定为 `mig-${supportId}`，便于幂等）；时间戳由调用方补齐。
 */
export function buildMigratedFirstChecks(
  supports: Array<Pick<Support, 'id' | 'treeId' | 'type' | 'installDate' | 'checkCycleMon'> & { lastCheckDate?: unknown }>
): { checks: SupportCheck[]; failed: string[] } {
  const planned: Array<{ supportId: string; treeId: string; type: Support['type']; date: string }> = []
  const failed: string[] = []
  for (const row of supports) {
    const legacy = row.lastCheckDate
    if (isValidDate(legacy)) {
      planned.push({ supportId: row.id, treeId: row.treeId, type: row.type, date: legacy })
      continue
    }
    if (isValidDate(row.installDate)) {
      const firstDate = addMonths(row.installDate, row.checkCycleMon)
      if (firstDate !== '') {
        planned.push({ supportId: row.id, treeId: row.treeId, type: row.type, date: firstDate })
        continue
      }
    }
    failed.push(row.id)
  }
  return {
    checks: planned.map((item) => ({
      id: `mig-${item.supportId}`,
      supportId: item.supportId,
      treeId: item.treeId,
      type: item.type,
      date: item.date,
      inspector: '旧档补录',
      result: '正常' as SupportCheckResult,
      conclusion: '由旧版加固件台账迁移补出的首条检查记录，请巡查班组现场复核。',
      createdAt: '',
      updatedAt: '',
      revision: 0,
    })),
    failed,
  }
}
