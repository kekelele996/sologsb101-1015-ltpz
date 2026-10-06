/**
 * 加固件现场巡查记录（SupportCheck）
 * 巡查班组每次上树巡检留一条现场记录：检查日期、检查人、现场结论。
 * 档案室的加固件台账（Support）只管安装日期与检查周期；
 * 最近检查日期、下次检查日期与超期判定全部按本侧最新一条记录计算。
 * 两侧通过「古树编号（treeId）+ 加固件类型」对账。
 */
import type { SupportType } from './support'

/** 现场结论选项 */
export type CheckResult = '正常' | '需关注' | '异常待处理'

export const CHECK_RESULT_OPTIONS: CheckResult[] = ['正常', '需关注', '异常待处理']

export interface SupportCheck {
  id: string
  /** 所属古树（对账键之一，冗余自台账，便于古树删除时级联） */
  treeId: string
  /** 加固件类型（对账键之二） */
  type: SupportType
  /** 现场检查日期 YYYY-MM-DD */
  date: string
  /** 检查人（巡查班组上树人员） */
  inspector: string
  /** 现场结论 */
  result: CheckResult
  /** 现场情况备注（看出什么：锈蚀、松动、连接件状态等） */
  note: string
  /**
   * 关联台账行 id（档案室加固件 Support.id）。
   * 巡查记录并入时若按 古树+类型 能唯一对上台账则回填；
   * 对不上（台账缺登记或同类型多件无法唯一确定）时为空，进对账差异单列。
   */
  supportId: string
  /**
   * 旧数据升级补首条记录的标记：
   * 'legacy-backfill' = 按台账安装日期补出的首条记录；
   * 空字符串 = 巡查班组正常登记。
   */
  source: '' | 'legacy-backfill'
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑现场巡查记录的表单草稿 */
export interface SupportCheckDraft {
  treeId: string
  type: SupportType
  date: string
  inspector: string
  result: CheckResult
  note: string
  supportId: string
}

/** 巡查记录并入（JSON 批量）单条结果 */
export interface SupportCheckMergeItem {
  /** 台账对账键：古树编号（业务 code，如 京-01-0007） */
  treeCode: string
  type: SupportType
  date: string
  inspector: string
  result: CheckResult
  note: string
}

/** 巡查记录并入结果：已并入的照留，失败条目原样返回供只重试验收这侧 */
export interface SupportCheckMergeOutcome {
  /** 成功并入条数 */
  merged: number
  /** 并入失败的原始条目（原样保留，调用方仅重试这些） */
  failed: SupportCheckMergeItem[]
  /** 失败原因（与 failed 按下标对应） */
  reasons: string[]
}
