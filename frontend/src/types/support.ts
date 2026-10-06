/**
 * 加固件台账（Support）
 * 支撑杆、拉纤、避雷设施。档案室这本台账只管安装信息、检查周期与下次检查日期；
 * 谁去查的、现场看出什么，写到「现场巡查记录」（SupportCheck）里，一件加固件对应多条巡查。
 */

/** 加固件类型 */
export type SupportType = '支撑杆' | '拉纤' | '避雷'

export const SUPPORT_TYPE_OPTIONS: SupportType[] = ['支撑杆', '拉纤', '避雷']

export interface Support {
  id: string
  /** 所属古树 */
  treeId: string
  /** 类型 */
  type: SupportType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /** 检查周期（月） */
  checkCycleMon: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑加固件台账的表单草稿（台账不含检查日期，检查记录在巡查侧另录） */
export interface SupportDraft {
  treeId: string
  type: SupportType
  installDate: string
  checkCycleMon: number
}
