/**
 * 加固件台账（Support）与现场巡查记录（SupportCheck）对账、超期派生工具（纯函数）。
 *
 * 职责边界：
 * - 台账 Support 只管安装日期与检查周期；
 * - 最近检查 / 下次检查 / 超期一律按巡查侧「最新一条现场记录」计算，
 *   尚无现场记录时退回用安装日期作为周期起算点。
 * 两侧按「古树 treeId + 加固件类型」对账，对不上的归为差异条目。
 */
import type { Support, SupportType } from '../types/support'
import type { SupportCheck } from '../types/supportCheck'
import { addMonths, daysBetween, isSupportOverdue, nextCheckDate, overdueDays } from './dimension'

/** 台账与巡查两侧的对账键：古树 + 类型 */
export function supportKey(treeId: string, type: SupportType): string {
  return `${treeId}${type}`
}

export interface SupportCheckStatus {
  /** 最新一条现场巡查记录（无则 null） */
  latest: SupportCheck | null
  /** 是否曾有现场记录 */
  checked: boolean
  /** 周期起算基准日期：最新巡查日期；无记录时退回安装日期 */
  baseDate: string
  /** 下次检查日期（基准 + 检查周期），无法计算时为空串 */
  nextDate: string
  /** 是否超期 */
  overdue: boolean
  /** 超期天数 */
  overdueDays: number
}

/**
 * 计算一件加固件的检查状态。
 * @param today 参照日（默认今天），测试可注入
 */
export function supportCheckStatus(
  support: Support,
  checks: SupportCheck[],
  reference: string = latestDateRef()
): SupportCheckStatus {
  const mine = checks
    .filter((row) => row.treeId === support.treeId && row.type === support.type)
    .sort((a, b) => a.date.localeCompare(b.date))
  const latest = mine.length > 0 ? mine[mine.length - 1] : null
  const baseDate = latest !== null ? latest.date : support.installDate
  return {
    latest,
    checked: latest !== null,
    baseDate,
    nextDate: nextCheckDate(baseDate, support.checkCycleMon),
    overdue: isSupportOverdue(baseDate, support.checkCycleMon, reference),
    overdueDays: overdueDays(baseDate, support.checkCycleMon, reference),
  }
}

/** 默认参照日：今天（延迟取值，避免模块加载时固化） */
function latestDateRef(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 取某古树 + 类型下的最新一条现场记录 */
export function latestCheckOf(checks: SupportCheck[], treeId: string, type: SupportType): SupportCheck | null {
  const mine = checks
    .filter((row) => row.treeId === treeId && row.type === type)
    .sort((a, b) => a.date.localeCompare(b.date))
  return mine.length > 0 ? mine[mine.length - 1] : null
}

/** 台账某键对应的全部现场记录（按日期升序） */
export function checksOfKey(checks: SupportCheck[], treeId: string, type: SupportType): SupportCheck[] {
  return checks
    .filter((row) => row.treeId === treeId && row.type === type)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 差异类型：仅有台账（巡查从未上树）/ 仅有巡查（台账缺登记）/ 旧数据补录失败 */
export type ReconKind = 'ledger-only' | 'check-only' | 'backfill-failed'

export interface SupportReconItem {
  key: string
  treeId: string
  type: SupportType
  kind: ReconKind
  /** ledger-only / backfill-failed 时对应的台账行（可能多件同键） */
  supports: Support[]
  /** check-only 时对应的现场记录 */
  checks: SupportCheck[]
  /** 说明文案 */
  message: string
}

/**
 * 按「古树 + 类型」对账台账与现场记录。
 * @returns 只返回对不上的差异；键两侧都在则视为已对上（不返回）。
 */
export function reconcileSupports(supports: Support[], checks: SupportCheck[]): SupportReconItem[] {
  const diffs: SupportReconItem[] = []
  const supportByKey = new Map<string, Support[]>()
  const checkByKey = new Map<string, SupportCheck[]>()

  for (const support of supports) {
    const k = supportKey(support.treeId, support.type)
    supportByKey.set(k, [...(supportByKey.get(k) ?? []), support])
  }
  for (const check of checks) {
    const k = supportKey(check.treeId, check.type)
    checkByKey.set(k, [...(checkByKey.get(k) ?? []), check])
  }

  // 旧数据补不出首条记录的，优先单列
  for (const [key, list] of supportByKey) {
    const bad = list.filter((row) => row.backfillIssue !== '')
    if (bad.length === 0) continue
    const [{ treeId, type }] = bad
    diffs.push({
      key,
      treeId,
      type,
      kind: 'backfill-failed',
      supports: bad,
      checks: checkByKey.get(key) ?? [],
      message: `旧数据升级时无法补出首条巡查记录：${bad[0].backfillIssue}`,
    })
  }

  // 有台账、无任何现场记录
  for (const [key, list] of supportByKey) {
    if (list.some((row) => row.backfillIssue !== '')) continue
    if ((checkByKey.get(key) ?? []).length > 0) continue
    const [{ treeId, type }] = list
    diffs.push({
      key,
      treeId,
      type,
      kind: 'ledger-only',
      supports: list,
      checks: [],
      message: `台账登记 ${list.length} 件，但巡查侧没有任何现场记录`,
    })
  }

  // 有现场记录、台账查无此件（或古树档案已删除）
  for (const [key, list] of checkByKey) {
    if (supportByKey.has(key)) continue
    const [{ treeId, type }] = list
    diffs.push({
      key,
      treeId,
      type,
      kind: 'check-only',
      supports: [],
      checks: list,
      message: `巡查侧有 ${list.length} 条现场记录，但台账查无此「古树 + 类型」加固件`,
    })
  }

  return diffs.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.type.localeCompare(b.type, 'zh-Hans-CN'))
}

/** 无现场记录时以安装日期作为首次周期起算点给出的下次检查日期（供台账空态展示） */
export function firstDueDate(support: Support): string {
  return addMonths(support.installDate, support.checkCycleMon)
}

/** 距下次检查的天数（负数表示已超期天数） */
export function daysToNext(status: SupportCheckStatus, reference = latestDateRef()): number {
  if (status.nextDate === '') return 0
  return daysBetween(reference, status.nextDate)
}

/** 是否合法 YYYY-MM-DD 日期 */
export function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

/** 旧加固件行（v2 及以前可能带 lastCheckDate） */
export interface LegacySupportShape {
  installDate?: unknown
  lastCheckDate?: unknown
  checkCycleMon?: unknown
}

/**
 * 旧数据升级：按安装日期与周期推导首条巡查记录的日期。
 * 优先沿用原台账的最近检查日期（那是真实历史）；没有时以安装日期作为安装即首检。
 * 安装日期也缺失 / 非法时补不出，返回原因，调用方把该件单列。
 */
export function deriveLegacyBackfill(
  raw: LegacySupportShape
): { ok: true; date: string; usedLastCheck: boolean } | { ok: false; issue: string } {
  if (isValidDateString(raw.lastCheckDate)) {
    return { ok: true, date: raw.lastCheckDate, usedLastCheck: true }
  }
  if (isValidDateString(raw.installDate)) {
    return { ok: true, date: raw.installDate, usedLastCheck: false }
  }
  return { ok: false, issue: '安装日期缺失或无法识别，不能按安装日期与周期补出首条巡查记录' }
}
