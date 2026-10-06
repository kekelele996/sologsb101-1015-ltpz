<script setup lang="ts">
/**
 * /supports 加固件：现场巡查记录 与 档案室台账 分开记账
 * - 巡查班组每次上树巡检留一条现场记录（检查日期 / 检查人 / 现场结论），并入失败只重试巡查侧
 * - 台账只管安装日期、检查周期与下次检查日期
 * - 两边按古树编号 + 类型对账，对不上的分「巡查无记录」「台账无此件」单列
 * - 下次检查 / 顶部超期名单 / 超期筛选 / 养护总览均按最新一条现场巡查算
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type TableInstance } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTreeStore } from '@/stores/treeStore'
import { db, mergeSupportChecks, ROW_REVISION } from '@/utils/db'
import {
  SUPPORT_TYPE_OPTIONS,
  type Support,
  type SupportDraft,
  type SupportType,
} from '@/types/support'
import {
  SUPPORT_CHECK_RESULT_OPTIONS,
  type SupportCheck,
  type SupportCheckDraft,
  type SupportCheckResult,
} from '@/types/supportCheck'
import {
  buildSupportViews,
  checkResultTagType,
  checksForSupport,
  reconcile,
  resolveCheckLinks,
  type SupportCheckView,
} from '@/utils/supportCheck'
import { today } from '@/utils/id'

const treeStore = useTreeStore()

const { rows: supports, loading: supportLoading, create, update, remove } = useIdbTable<Support>(db.supports, {
  sortByUpdatedAt: false,
})
const {
  rows: checks,
  loading: checkLoading,
  update: updateCheck,
  remove: removeCheck,
} = useIdbTable<SupportCheck>(db.supportChecks, { sortByUpdatedAt: false })

/* -------------------------------- 筛选状态 -------------------------------- */

const keyword = ref('')
const treeFilter = ref('all')
const typeFilter = ref<SupportType | 'all'>('all')
const overdueOnly = ref(false)

const checkKeyword = ref('')
const checkTreeFilter = ref('all')
const checkTypeFilter = ref<SupportType | 'all'>('all')
const resultFilter = ref<SupportCheckResult | 'all'>('all')

/* -------------------------------- 台账弹窗 -------------------------------- */

const supportDialogVisible = ref(false)
const supportSubmitting = ref(false)
const editingSupportId = ref<string | null>(null)
const supportFormRef = ref<FormInstance>()

const supportForm = reactive<SupportDraft>({
  treeId: '',
  type: '支撑杆',
  installDate: '',
  checkCycleMon: 12,
})

const supportRules: FormRules<SupportDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }],
  checkCycleMon: [{ required: true, message: '请填写检查周期', trigger: 'blur' }],
}

/* -------------------------------- 巡查记录弹窗 -------------------------------- */

const checkDialogVisible = ref(false)
const checkSubmitting = ref(false)
const editingCheckId = ref<string | null>(null)
const checkFormRef = ref<FormInstance>()
const ledgerTableRef = ref<TableInstance>()

const checkForm = reactive<SupportCheckDraft>({
  supportId: '',
  treeId: '',
  type: '支撑杆',
  date: '',
  inspector: '',
  result: '正常',
  conclusion: '',
})

const checkRules: FormRules<SupportCheckDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  date: [{ required: true, message: '请选择检查日期', trigger: 'change' }],
  inspector: [{ required: true, message: '请填写检查人', trigger: 'blur' }],
  result: [{ required: true, message: '请选择现场结论', trigger: 'change' }],
  conclusion: [{ required: true, message: '请填写现场情况说明', trigger: 'blur' }],
}

/* -------------------------------- 派生数据 -------------------------------- */

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const views = computed<SupportCheckView[]>(() => buildSupportViews(supports.value, checks.value))

const checkLinks = computed(() => resolveCheckLinks(supports.value, checks.value))

const reconciliation = computed(() => reconcile(supports.value, checks.value))

const reconcileCount = computed(
  () =>
    reconciliation.value.ledgerMissing.length +
    reconciliation.value.orphanChecks.length +
    reconciliation.value.ambiguousChecks.length
)

/** 巡查记录在对账区的归类标签 */
function checkReconcileTag(row: SupportCheck): '' | 'orphan' | 'ambiguous' {
  const status = checkLinks.value.get(row.id)?.status
  if (status === 'orphan') return 'orphan'
  if (status === 'ambiguous') return 'ambiguous'
  return ''
}

const filteredViews = computed<SupportCheckView[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return views.value
    .filter((view) => {
      const row = view.support
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      if (overdueOnly.value && !view.overdue) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.type.toLowerCase().includes(key) ||
        (view.latest?.inspector ?? '').toLowerCase().includes(key)
      )
    })
    .sort((a, b) => a.support.installDate.localeCompare(b.support.installDate))
})

const overdueViews = computed<SupportCheckView[]>(() => views.value.filter((view) => view.overdue))

const filteredChecks = computed<SupportCheck[]>(() => {
  const key = checkKeyword.value.trim().toLowerCase()
  return checks.value
    .filter((row) => {
      if (checkTreeFilter.value !== 'all' && row.treeId !== checkTreeFilter.value) return false
      if (checkTypeFilter.value !== 'all' && row.type !== checkTypeFilter.value) return false
      if (resultFilter.value !== 'all' && row.result !== resultFilter.value) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.type.toLowerCase().includes(key) ||
        row.inspector.toLowerCase().includes(key) ||
        row.conclusion.toLowerCase().includes(key)
      )
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
})

const coveredTrees = computed<number>(() => new Set(supports.value.map((row) => row.treeId)).size)

onMounted(() => {
  void treeStore.loadAll()
})

function supportRowClass({ row }: { row: SupportCheckView }): string {
  return row.overdue ? 'row-overdue' : ''
}

/* -------------------------------- 台账增删改 -------------------------------- */

function openSupportCreate(): void {
  const treeId =
    treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  editingSupportId.value = null
  Object.assign(supportForm, {
    treeId,
    type: '支撑杆' as SupportType,
    installDate: today(),
    checkCycleMon: 12,
  })
  supportDialogVisible.value = true
}

function openSupportEdit(view: SupportCheckView): void {
  editingSupportId.value = view.support.id
  Object.assign(supportForm, {
    treeId: view.support.treeId,
    type: view.support.type,
    installDate: view.support.installDate,
    checkCycleMon: view.support.checkCycleMon,
  })
  supportDialogVisible.value = true
}

async function handleSupportSubmit(): Promise<void> {
  if (supportFormRef.value === undefined) return
  const valid = await supportFormRef.value.validate().catch(() => false)
  if (!valid) return
  supportSubmitting.value = true
  try {
    if (editingSupportId.value === null) {
      await create({ ...supportForm }, 'support')
      ElMessage.success('加固件已登记，等巡查班组上树后补现场记录')
    } else {
      await update(editingSupportId.value, { ...supportForm })
      ElMessage.success('加固件台账已更新')
    }
    supportDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    supportSubmitting.value = false
  }
}

async function handleSupportDelete(view: SupportCheckView): Promise<void> {
  const row = view.support
  try {
    await ElMessageBox.confirm(
      `确认删除「${treeLabel.value[row.treeId] ?? '该古树'} · ${row.type}」台账？已并入的 ${view.checkCount} 条现场巡查记录会保留，并在对账区单列为「台账无此件」。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await remove(row.id)
  ElMessage.success('台账已删除，现场巡查记录照留')
}

/* -------------------------------- 巡查记录增删改 -------------------------------- */

/** 从台账行直接登记本次检查：古树 / 类型 / 关联件已锁定 */
function openCheckFromSupport(view: SupportCheckView): void {
  editingCheckId.value = null
  Object.assign(checkForm, {
    supportId: view.support.id,
    treeId: view.support.treeId,
    type: view.support.type,
    date: today(),
    inspector: view.latest?.inspector ?? '',
    result: '正常' as SupportCheckResult,
    conclusion: '',
  })
  checkDialogVisible.value = true
}

/** 巡查班组独立录一条：古树 + 类型选择，能不能对上台账由对账区给出 */
function openCheckCreate(): void {
  editingCheckId.value = null
  Object.assign(checkForm, {
    supportId: '',
    treeId:
      checkTreeFilter.value !== 'all' ? checkTreeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? ''),
    type: '支撑杆' as SupportType,
    date: today(),
    inspector: '',
    result: '正常' as SupportCheckResult,
    conclusion: '',
  })
  checkDialogVisible.value = true
}

function openCheckEdit(row: SupportCheck): void {
  editingCheckId.value = row.id
  Object.assign(checkForm, {
    supportId: row.supportId,
    treeId: row.treeId,
    type: row.type,
    date: row.date,
    inspector: row.inspector,
    result: row.result,
    conclusion: row.conclusion,
  })
  checkDialogVisible.value = true
}

/**
 * 巡查记录并入：台账与巡查两边拆开，只写巡查这一侧。
 * 单条录入走 mergeSupportChecks，失败时给出「重试」入口且已并入的照留。
 */
async function handleCheckSubmit(): Promise<void> {
  if (checkFormRef.value === undefined) return
  const valid = await checkFormRef.value.validate().catch(() => false)
  if (!valid) return
  checkSubmitting.value = true
  try {
    const stamp = new Date().toISOString()
    if (editingCheckId.value === null) {
      const id = `check-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const row: SupportCheck = {
        id,
        ...checkForm,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }
      const result = await mergeSupportChecks([row])
      if (result.failed.length > 0) {
        ElMessage.error(`巡查记录并入失败：${result.failed[0].message}，可点本弹窗「重试」`)
        pendingRetryRow.value = row
        return
      }
      ElMessage.success('现场巡查记录已并入')
    } else {
      await updateCheck(editingCheckId.value, { ...checkForm })
      ElMessage.success('现场巡查记录已更新')
    }
    pendingRetryRow.value = null
    checkDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    checkSubmitting.value = false
  }
}

/** 并入失败后待重试的那一条（只重试巡查这一侧，台账不动） */
const pendingRetryRow = ref<SupportCheck | null>(null)

async function retryPendingCheck(): Promise<void> {
  if (pendingRetryRow.value === null) return
  checkSubmitting.value = true
  try {
    const result = await mergeSupportChecks([pendingRetryRow.value])
    if (result.failed.length > 0) {
      ElMessage.error(`仍未成功：${result.failed[0].message}`)
      return
    }
    ElMessage.success('重试成功，现场巡查记录已并入')
    pendingRetryRow.value = null
    checkDialogVisible.value = false
  } finally {
    checkSubmitting.value = false
  }
}

async function handleCheckDelete(row: SupportCheck): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date}「${row.type}」的现场巡查记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await removeCheck(row.id)
  ElMessage.success('现场巡查记录已删除')
}

function historyOf(view: SupportCheckView): SupportCheck[] {
  return [...checksForSupport(view.support, checks.value, checkLinks.value)].reverse()
}

function toggleExpand(view: SupportCheckView): void {
  ledgerTableRef.value?.toggleRowExpansion(view)
}

/* -------------------------------- 筛选联动 -------------------------------- */

function handleSupportFilterChange(key: string, value: string): void {
  if (key === 'treeId') treeFilter.value = value
  if (key === 'type') typeFilter.value = value as SupportType | 'all'
}

function handleCheckFilterChange(key: string, value: string): void {
  if (key === 'treeId') checkTreeFilter.value = value
  if (key === 'type') checkTypeFilter.value = value as SupportType | 'all'
  if (key === 'result') resultFilter.value = value as SupportCheckResult | 'all'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="台账加固件" :value="supports.length" suffix="件" tone="primary" icon="Histogram" />
      <StatBadge label="现场巡查记录" :value="checks.length" suffix="条" tone="info" icon="Document" />
      <StatBadge
        label="超期未检查"
        :value="overdueViews.length"
        suffix="件"
        :tone="overdueViews.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="最新一条现场巡查日期 + 检查周期早于今天"
      />
      <StatBadge label="覆盖古树" :value="coveredTrees" suffix="株" tone="info" icon="DataLine" />
      <StatBadge
        label="对账不符"
        :value="reconcileCount"
        suffix="项"
        :tone="reconcileCount > 0 ? 'warning' : 'success'"
        icon="Refresh"
        size="small"
      />
    </div>

    <!-- 顶部超期名单：按最新一条现场巡查算 -->
    <el-alert
      v-if="overdueViews.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${overdueViews.length} 件加固件超过检查周期未检查`"
    >
      <template #default>
        <div class="overdue-list">
          <div v-for="view in overdueViews" :key="view.support.id">
            {{ treeLabel[view.support.treeId] ?? '（古树已删除）' }} · {{ view.support.type }}：最近巡查
            {{ view.latest?.date ?? '未记录' }}（{{ view.latest?.inspector ?? '无巡查记录' }}），周期
            {{ view.support.checkCycleMon }} 个月，已超期 {{ view.overdueDays }} 天
          </div>
        </div>
      </template>
    </el-alert>

    <!-- 对账区：两边按古树编号 + 类型对，对不上的单列 -->
    <el-alert
      v-if="reconcileCount > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      title="台账与现场巡查对账不符"
    >
      <template #default>
        <div class="recon-list">
          <div v-for="row in reconciliation.ledgerMissing" :key="`missing-${row.id}`" class="recon-item">
            <el-tag type="warning" size="small">巡查无记录</el-tag>
            <span>{{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}（安装 {{ row.installDate }}，周期 {{ row.checkCycleMon }} 个月）</span>
          </div>
          <div v-for="row in reconciliation.orphanChecks" :key="`orphan-${row.id}`" class="recon-item">
            <el-tag type="danger" size="small">台账无此件</el-tag>
            <span>
              {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：{{ row.date }} {{ row.inspector }} 巡查发现「{{ row.result }}」
            </span>
          </div>
          <div v-for="row in reconciliation.ambiguousChecks" :key="`ambiguous-${row.id}`" class="recon-item">
            <el-tag type="warning" size="small">多件待确认</el-tag>
            <span>
              {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：{{ row.date }} {{ row.inspector }} 的巡查无法确定归属哪一件，请在台账中核对
            </span>
          </div>
        </div>
      </template>
    </el-alert>

    <!-- ===================== 上：巡查班组现场记录 ===================== -->
    <el-card shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">加固件现场巡查记录（巡查班组上树巡检）</span>
          <el-button type="primary" @click="openCheckCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记现场巡查</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="checkKeyword"
        :fields="[
          {
            key: 'treeId',
            label: '古树',
            options: treeStore.trees.map((tree) => tree.id),
            optionLabels: treeLabel,
          },
          { key: 'type', label: '类型', options: SUPPORT_TYPE_OPTIONS as unknown as string[] },
          { key: 'result', label: '结论', options: SUPPORT_CHECK_RESULT_OPTIONS as unknown as string[] },
        ]"
        :values="{ treeId: checkTreeFilter, type: checkTypeFilter, result: resultFilter }"
        :result-text="`命中 ${filteredChecks.length} / ${checks.length} 条`"
        @update:keyword="(value: string) => (checkKeyword = value)"
        @change="handleCheckFilterChange"
        @reset="
          () => {
            checkKeyword = ''
            checkTreeFilter = 'all'
            checkTypeFilter = 'all'
            resultFilter = 'all'
          }
        "
      />

      <EmptyPanel
        v-if="checks.length === 0 && !checkLoading"
        title="还没有现场巡查记录"
        description="巡查班组每次上树巡检在此留一条：检查日期、检查人、现场结论。台账只管周期，下次检查日期按最新一条巡查自动算。"
        action-text="登记第一条巡查"
        @action="openCheckCreate"
      />

      <el-table v-else v-loading="checkLoading || !treeStore.ready" :data="filteredChecks" row-key="id" stripe>
        <el-table-column label="古树" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</span>
              <el-tag v-if="checkReconcileTag(row) === 'orphan'" type="danger" size="small" effect="plain">
                台账无此件
              </el-tag>
              <el-tag v-else-if="checkReconcileTag(row) === 'ambiguous'" type="warning" size="small" effect="plain">
                多件待确认
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="row.type === '避雷' ? 'warning' : row.type === '拉纤' ? 'info' : 'success'" size="small">
              {{ row.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="date" label="检查日期" width="110" />
        <el-table-column prop="inspector" label="检查人" width="100" />
        <el-table-column label="现场结论" width="100">
          <template #default="{ row }">
            <el-tag :type="checkResultTagType(row.result)" size="small" effect="dark">{{ row.result }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="conclusion" label="现场情况" min-width="260" show-overflow-tooltip />
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openCheckEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleCheckDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ===================== 下：档案室加固件台账 ===================== -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">加固件台账（档案室：安装信息 · 检查周期 · 下次检查日期）</span>
          <el-button @click="openSupportCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记加固件</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[
          {
            key: 'treeId',
            label: '古树',
            options: treeStore.trees.map((tree) => tree.id),
            optionLabels: treeLabel,
          },
          { key: 'type', label: '类型', options: SUPPORT_TYPE_OPTIONS as unknown as string[] },
        ]"
        :values="{ treeId: treeFilter, type: typeFilter }"
        :result-text="`命中 ${filteredViews.length} / ${supports.length} 件`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleSupportFilterChange"
        @reset="
          () => {
            keyword = ''
            treeFilter = 'all'
            typeFilter = 'all'
            overdueOnly = false
          }
        "
      >
        <template #extra>
          <el-checkbox v-model="overdueOnly" border size="small">只看超期未检查</el-checkbox>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="supports.length === 0 && !supportLoading"
        title="还没有加固件台账"
        description="档案室登记支撑杆、拉纤与避雷件的安装日期与检查周期；巡查班组回来后在上方登记现场记录，系统据此算下次检查日期。"
        action-text="登记第一件加固件"
        @action="openSupportCreate"
      />

      <el-table
        v-else
        ref="ledgerTableRef"
        v-loading="supportLoading || !treeStore.ready"
        :data="filteredViews"
        :row-key="(row: SupportCheckView) => row.support.id"
        stripe
        :row-class-name="supportRowClass"
      >
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="history-panel">
              <div class="history-panel__title">该件现场巡查历史（{{ historyOf(row).length }} 条，最新在最上）</div>
              <el-empty v-if="historyOf(row).length === 0" description="暂无巡查记录" :image-size="60" />
              <el-timeline v-else>
                <el-timeline-item
                  v-for="item in historyOf(row)"
                  :key="item.id"
                  :timestamp="`${item.date} · ${item.inspector}`"
                  placement="top"
                >
                  <el-tag :type="checkResultTagType(item.result)" size="small" effect="dark">{{ item.result }}</el-tag>
                  <span class="history-conclusion">{{ item.conclusion }}</span>
                </el-timeline-item>
              </el-timeline>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="古树" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ treeLabel[row.support.treeId] ?? '（古树已删除）' }}</span>
              <VigorTag
                :vigor="treeStore.statOf(row.support.treeId).latestVigor"
                :trend="treeStore.statOf(row.support.treeId).latestTrend"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="row.support.type === '避雷' ? 'warning' : row.support.type === '拉纤' ? 'info' : 'success'" size="small">
              {{ row.support.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="support.installDate" label="安装日期" width="110" />
        <el-table-column label="检查周期" width="100" align="right">
          <template #default="{ row }">{{ row.support.checkCycleMon }} 个月</template>
        </el-table-column>
        <el-table-column label="最近巡查" min-width="180">
          <template #default="{ row }">
            <span v-if="row.latest === null" class="cell-warn">无巡查记录</span>
            <div v-else class="cell-stack">
              <span>{{ row.latest.date }} · {{ row.latest.inspector }}</span>
              <el-tag :type="checkResultTagType(row.latest.result)" size="small" effect="plain">
                {{ row.latest.result }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="下次检查" width="110">
          <template #default="{ row }">{{ row.nextDate || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查状态" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.overdue" type="danger" effect="dark">超期 {{ row.overdueDays }} 天</el-tag>
            <el-tag v-else type="success" effect="light">周期内</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button link :type="row.overdue ? 'danger' : 'primary'" size="small" @click="openCheckFromSupport(row)">
              登记本次检查
            </el-button>
            <el-button link type="primary" size="small" @click="toggleExpand(row)">巡查历史</el-button>
            <el-button link type="primary" size="small" @click="openSupportEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleSupportDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 台账弹窗：无检查日期字段 -->
    <el-dialog v-model="supportDialogVisible" :title="editingSupportId === null ? '登记加固件' : '编辑加固件台账'" width="600px">
      <el-form ref="supportFormRef" :model="supportForm" :rules="supportRules" label-width="120px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="supportForm.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.location}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="类型" prop="type">
              <el-select v-model="supportForm.type" style="width: 100%">
                <el-option v-for="item in SUPPORT_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="安装日期" prop="installDate">
              <el-date-picker v-model="supportForm.installDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="检查周期（月）" prop="checkCycleMon">
          <el-input-number v-model="supportForm.checkCycleMon" :min="1" :max="120" :step="1" style="width: 100%" />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="台账只登记安装信息与检查周期"
          description="谁去查、现场看出什么由巡查班组在「现场巡查记录」里按次填写；下次检查日期按最新一条巡查日期自动推算。"
        />
      </el-form>
      <template #footer>
        <el-button @click="supportDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="supportSubmitting" @click="handleSupportSubmit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 现场巡查弹窗 -->
    <el-dialog v-model="checkDialogVisible" title="加固件现场巡查记录" width="620px">
      <el-form ref="checkFormRef" :model="checkForm" :rules="checkRules" label-width="110px">
        <el-form-item label="古树" prop="treeId">
          <el-select
            v-model="checkForm.treeId"
            filterable
            style="width: 100%"
            :disabled="checkForm.supportId !== ''"
          >
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.location}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="加固件类型" prop="type">
              <el-select v-model="checkForm.type" style="width: 100%" :disabled="checkForm.supportId !== ''">
                <el-option v-for="item in SUPPORT_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检查日期" prop="date">
              <el-date-picker v-model="checkForm.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检查人" prop="inspector">
              <el-input v-model="checkForm.inspector" placeholder="巡查人 / 班组" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="现场结论" prop="result">
          <el-radio-group v-model="checkForm.result">
            <el-radio-button v-for="item in SUPPORT_CHECK_RESULT_OPTIONS" :key="item" :value="item">
              {{ item }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="现场情况" prop="conclusion">
          <el-input
            v-model="checkForm.conclusion"
            type="textarea"
            :rows="3"
            placeholder="如：南侧支撑杆固定螺栓轻微锈蚀，已做防锈处理。"
          />
        </el-form-item>
        <el-alert
          v-if="checkForm.supportId === ''"
          type="info"
          show-icon
          :closable="false"
          title="按古树编号 + 类型与台账对账"
          description="若档案室台账里没有同古树同类型的件，这条记录会保留下并在顶部对账区单列为「台账无此件」，不会被丢弃。"
        />
      </el-form>
      <template #footer>
        <el-button @click="checkDialogVisible = false">取消</el-button>
        <el-button v-if="pendingRetryRow !== null" type="warning" :loading="checkSubmitting" @click="retryPendingCheck">
          重试并入
        </el-button>
        <el-button type="primary" :loading="checkSubmitting" @click="handleCheckSubmit">
          {{ editingCheckId === null ? '并入巡查记录' : '保存修改' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.overdue-list,
.recon-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.8;
}

.recon-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.history-panel {
  padding: 6px 12px 6px 48px;
}

.history-panel__title {
  font-size: 13px;
  font-weight: 600;
  color: #4a5a30;
  margin-bottom: 8px;
}

.history-conclusion {
  margin-left: 8px;
  font-size: 13px;
  color: #5f574d;
}

.mb-14 {
  margin-bottom: 14px;
}

:deep(.row-overdue) {
  --el-table-tr-bg-color: #fdf3f2;
}
</style>
