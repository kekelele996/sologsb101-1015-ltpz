/**
 * 加固件（Support）——档案室加固件台账
 * 支撑杆、拉纤、避雷设施的登记信息：只管安装日期与检查周期。
 * 最近检查日期 / 下次检查日期 / 超期判定不落在本台账上，
 * 一律由巡查班组的现场记录（SupportCheck，按 treeId + type 对账）最新一条计算。
 */

/** 加固件类型 */
export type SupportType = '支撑杆' | '拉纤' | '避雷'

export const SUPPORT_TYPE_OPTIONS: SupportType[] = ['支撑杆', '拉纤', '避雷']

export interface Support {
  id: string
  /** 所属古树（对账键之一） */
  treeId: string
  /** 类型（对账键之二） */
  type: SupportType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /** 检查周期（月） */
  checkCycleMon: number
  /**
   * 旧数据升级时若无法按安装日期 / 周期补出首条巡查记录，则标记原因，
   * 在台账与对账差异中单列（如安装日期缺失）。正常为空字符串。
   */
  backfillIssue: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑加固件的表单草稿（档案室侧：只录周期信息，不录检查结果） */
export interface SupportDraft {
  treeId: string
  type: SupportType
  installDate: string
  checkCycleMon: number
}
