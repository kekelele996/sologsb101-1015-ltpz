/**
 * 加固件现场巡查记录（SupportCheck）
 * 巡查班组每次上树巡检留一条：检查日期、检查人、现场结论。
 * 加固件台账（Support）只管安装信息、检查周期与下次检查日期；
 * 一件加固件对应多条巡查记录，按 supportId 关联，全部判定以最新一条为准。
 */
import type { SupportType } from './support'

/** 现场结论选项 */
export type SupportCheckResult = '正常' | '需关注' | '异常'

export const SUPPORT_CHECK_RESULT_OPTIONS: SupportCheckResult[] = ['正常', '需关注', '异常']

export interface SupportCheck {
  id: string
  /**
   * 关联加固件。
   * 能与台账按古树编号 + 类型对上时回填；对不上的现场记录留空并进入对账异常名单。
   */
  supportId: string
  /** 所属古树（对账键之一） */
  treeId: string
  /** 加固件类型（对账键之二） */
  type: SupportType
  /** 检查日期 YYYY-MM-DD */
  date: string
  /** 检查人（巡查班组 / 巡查人姓名） */
  inspector: string
  /** 现场结论：正常 / 需关注 / 异常 */
  result: SupportCheckResult
  /** 现场情况说明 */
  conclusion: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑现场巡查记录的表单草稿 */
export interface SupportCheckDraft {
  supportId: string
  treeId: string
  type: SupportType
  date: string
  inspector: string
  result: SupportCheckResult
  conclusion: string
}
