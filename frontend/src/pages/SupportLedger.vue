<script setup lang="ts">
/**
 * /supports 加固件台账（档案室侧）
 * 台账只登记古树、类型、安装日期与检查周期；最近 / 下次检查与超期全部按
 * 巡查侧最新一条现场记录（SupportCheck）计算。
 * 顶部超期名单、超期筛选、养护总览口径与现场记录一致；
 * 「台账 ↔ 巡查」按古树编号 + 类型对账，对不上的在差异区单列；
 * 支持把巡查班组交回的现场记录 JSON 并入，失败条目原样保留、仅重试验收这侧。
 * 复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>、<VigorTag>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTreeStore } from '@/stores/treeStore'
import { db, mergeSupportChecks } from '@/utils/db'
import { SUPPORT_TYPE_OPTIONS, type Support, type SupportDraft, type SupportType } from '@/types/support'
import type { SupportCheckMergeItem } from '@/types/supportCheck'
import { reconcileSupports, type SupportReconItem } from '@/utils/supportCheck'
import { today } from '@/utils/id'

const treeStore = useTreeStore()

const { rows, loading, create, update, remove } = useIdbTable<Support>(db.supports, { sortByUpdatedAt: false })

const keyword = ref('')
const treeFilter = ref('all')
const typeFilter = ref<SupportType | 'all'>('all')
const overdueOnly = ref(false)

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<SupportDraft>({
  treeId: '',
  type: '支撑杆',
  installDate: '',
  checkCycleMon: 12,
})

const rules: FormRules<SupportDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }],
  checkCycleMon: [{ required: true, message: '请填写检查周期', trigger: 'blur' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)
const treeCodeOf = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, tree.code]))
)

/** 台账行（排除补录失败件）+ 最新现场记录派生的检查状态 */
const ledgerRows = computed(() =>
  rows.value
    .filter((row) => row.backfillIssue === '')
    .map((support) => ({ support, status: treeStore.supportStatusOf(support) }))
)

type LedgerEntry = (typeof ledgerRows.value)[number]

const backfillFailed = computed(() => rows.value.filter((row) => row.backfillIssue !== ''))

const filtered = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return ledgerRows.value
    .filter((entry) => {
      const row = entry.support
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      if (overdueOnly.value && !entry.status.overdue) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.type.toLowerCase().includes(key) ||
        (entry.status.latest?.inspector ?? '').toLowerCase().includes(key)
      )
    })
    .sort((a, b) => a.support.installDate.localeCompare(b.support.installDate))
})

const overdueRows = computed(() => treeStore.overdueSupports)

const coveredTrees = computed(() => new Set(rows.value.map((row) => row.treeId)).size)

/** 对账差异（有台账无巡查 / 有巡查无台账 / 补录失败） */
const reconDiffs = computed<SupportReconItem[]>(() =>
  reconcileSupports(rows.value, treeStore.supportChecks)
)

/* ----------------------- 巡查记录并入（失败只重试这侧） ----------------------- */

const mergeDialogVisible = ref(false)
const mergeText = ref('')
const mergePending = ref(false)
/** 上轮并入失败、等待重试的条目（巡查这侧）；台账侧已并入的照留 */
const failedItems = ref<SupportCheckMergeItem[]>([])
const failedReasons = ref<string[]>([])
const lastMergedCount = ref(0)

const mergeExample = JSON.stringify(
  [
    {
      treeCode: '京-01-0007',
      type: '支撑杆',
      date: today(),
      inspector: '张勇',
      result: '正常',
      note: '抱箍紧固，柱身无锈蚀。',
    },
  ],
  null,
  2
)

function openMerge(prefillFailed = false): void {
  mergeText.value = prefillFailed && failedItems.value.length > 0 ? JSON.stringify(failedItems.value, null, 2) : ''
  mergeDialogVisible.value = true
}

async function runMerge(items: SupportCheckMergeItem[]): Promise<void> {
  mergePending.value = true
  try {
    const outcome = await mergeSupportChecks(items)
    lastMergedCount.value = outcome.merged
    failedItems.value = outcome.failed
    failedReasons.value = outcome.reasons
    if (outcome.failed.length === 0) {
      ElMessage.success(`现场记录全部并入成功，共 ${outcome.merged} 条`)
      mergeDialogVisible.value = false
    } else {
      // 已并入的照留，只把失败条目留在输入框供重试巡查这侧
      mergeText.value = JSON.stringify(outcome.failed, null, 2)
      ElMessage.warning(`并入 ${outcome.merged} 条，${outcome.failed.length} 条失败，已原样保留待重试`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '并入失败')
  } finally {
    mergePending.value = false
  }
}

async function handleMergeSubmit(): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(mergeText.value)
  } catch {
    ElMessage.error('JSON 解析失败，请确认粘贴内容为现场记录数组。')
    return
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  await runMerge(items as SupportCheckMergeItem[])
}

async function handleMergeFile(uploadFile: UploadFile): Promise<void> {
  const raw = uploadFile.raw
  if (raw === undefined) return
  let parsed: unknown
  try {
    parsed = JSON.parse(await raw.text())
  } catch {
    ElMessage.error('文件不是合法 JSON。')
    return
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  await runMerge(items as SupportCheckMergeItem[])
}

function retryFailed(): void {
  if (failedItems.value.length === 0) {
    ElMessage.info('没有待重试的失败条目')
    return
  }
  mergeText.value = JSON.stringify(failedItems.value, null, 2)
  void handleMergeSubmit()
}

/* ------------------------------ 台账增删改 ------------------------------ */

onMounted(() => {
  void treeStore.loadAll()
})

function rowClassName({ row }: { row: LedgerEntry }): string {
  return row.status.overdue ? 'row-overdue' : ''
}

function openCreate(): void {
  const treeId =
    treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  editingId.value = null
  Object.assign(form, {
    treeId,
    type: '支撑杆' as SupportType,
    installDate: today(),
    checkCycleMon: 12,
  })
  dialogVisible.value = true
}

function openEdit(entry: LedgerEntry): void {
  const row = entry.support
  editingId.value = row.id
  Object.assign(form, {
    treeId: row.treeId,
    type: row.type,
    installDate: row.installDate,
    checkCycleMon: row.checkCycleMon,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await create({ ...form, backfillIssue: '' }, 'support')
      ElMessage.success('加固件已登记，等待巡查班组上交现场记录')
    } else {
      await update(editingId.value, { ...form })
      ElMessage.success('加固件台账已更新')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(entry: LedgerEntry): Promise<void> {
  const row = entry.support
  try {
    await ElMessageBox.confirm(
      `确认删除「${row.type}」加固件台账？其名下已关联的现场巡查记录会一并删除；对不上台账的巡查记录保留并在差异区列出。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await remove(row.id)
  ElMessage.success('加固件台账已删除')
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'treeId') treeFilter.value = value
  if (key === 'type') typeFilter.value = value as SupportType | 'all'
}

const reconKindMeta: Record<SupportReconItem['kind'], { label: string; tone: 'warning' | 'danger' | 'info' }> = {
  'ledger-only': { label: '有台账 · 无巡查', tone: 'warning' },
  'check-only': { label: '有巡查 · 无台账', tone: 'danger' },
  'backfill-failed': { label: '旧数据补录失败', tone: 'info' },
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="台账总数" :value="rows.length" suffix="件" tone="primary" icon="Histogram" />
      <StatBadge
        label="超期未检查"
        :value="overdueRows.length"
        suffix="件"
        :tone="overdueRows.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="最新一条现场巡查日期 + 检查周期早于今天"
      />
      <StatBadge label="现场巡查记录" :value="treeStore.supportChecks.length" suffix="条" tone="info" icon="DataLine" />
      <StatBadge label="覆盖古树" :value="coveredTrees" suffix="株" tone="info" icon="DataLine" />
      <StatBadge
        label="对账不符"
        :value="reconDiffs.length"
        suffix="项"
        :tone="reconDiffs.length > 0 ? 'warning' : 'success'"
        icon="Warning"
        size="small"
      />
    </div>

    <!-- 顶部超期名单：按最新一条现场记录计算 -->
    <el-alert
      v-if="overdueRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${overdueRows.length} 件加固件超过检查周期未检查（按最新一条现场记录）`"
    >
      <template #default>
        <div class="overdue-list">
          <div v-for="entry in overdueRows" :key="entry.support.id">
            {{ treeLabel[entry.support.treeId] ?? '（古树已删除）' }} · {{ entry.support.type }}：最近巡查
            {{ entry.status.latest?.date ?? '从未巡查（自安装起算）' }}
            <template v-if="entry.status.latest">（检查人 {{ entry.status.latest.inspector || '未署名' }}）</template>
            ，下次检查 {{ entry.status.nextDate }}，已超期 {{ entry.status.overdueDays }} 天
          </div>
        </div>
      </template>
    </el-alert>

    <!-- 对账差异：台账与巡查对不上的单列 -->
    <el-card v-if="reconDiffs.length > 0" shadow="never" class="mb-14 recon-card">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">台账 ↔ 巡查 对账差异（按古树编号 + 类型）</span>
          <el-tag type="warning" effect="dark">{{ reconDiffs.length }} 项对不上</el-tag>
        </div>
      </template>
      <el-table :data="reconDiffs" size="small" row-key="key">
        <el-table-column label="类型" width="150">
          <template #default="{ row }">
            <el-tag :type="reconKindMeta[row.kind as SupportReconItem['kind']].tone" size="small">
              {{ reconKindMeta[row.kind as SupportReconItem['kind']].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="古树" min-width="180">
          <template #default="{ row }">
            {{ treeLabel[row.treeId] ?? `（古树已删除 / treeId：${row.treeId}）` }}
            <span class="cell-sub">编号 {{ treeCodeOf[row.treeId] ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="加固件类型" width="100">
          <template #default="{ row }">{{ row.type }}</template>
        </el-table-column>
        <el-table-column label="说明" min-width="260">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.message }}</span>
              <span v-if="row.kind === 'check-only'" class="cell-sub">
                现场记录 {{ row.checks.length }} 条，最新：{{ row.checks[row.checks.length - 1]?.date }}
                {{ row.checks[row.checks.length - 1]?.inspector }}
              </span>
              <span v-else-if="row.kind === 'ledger-only'" class="cell-sub">
                安装 {{ row.supports[0]?.installDate }}，周期 {{ row.supports[0]?.checkCycleMon }} 个月，巡查班组从未上交该件记录
              </span>
              <span v-else class="cell-sub">请补全安装日期后手工补录首条巡查记录</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">加固件台账（档案室：只管周期与下次检查）</span>
          <el-space wrap>
            <el-button @click="openMerge">
              <el-icon><Upload /></el-icon>
              <span>并入巡查记录</span>
            </el-button>
            <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
              <el-icon><Plus /></el-icon>
              <span>登记加固件</span>
            </el-button>
          </el-space>
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
        :result-text="`命中 ${filtered.length} / ${ledgerRows.length} 件`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
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
        v-if="rows.length === 0 && !loading"
        title="还没有加固件台账"
        description="档案室登记支撑杆、拉纤与避雷件的安装日期和检查周期；巡查班组每次上树另留现场记录，系统据最新一条自动算下次检查日期与超期。"
        action-text="登记第一件加固件"
        @action="openCreate"
      />

      <el-table
        v-else
        v-loading="loading || !treeStore.ready"
        :data="filtered"
        row-key="support.id"
        stripe
        :row-class-name="rowClassName"
      >
        <el-table-column label="古树" min-width="190">
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
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="row.support.type === '避雷' ? 'warning' : row.support.type === '拉纤' ? 'info' : 'success'">
              {{ row.support.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="support.installDate" label="安装日期" width="115" />
        <el-table-column label="检查周期" width="100" align="right">
          <template #default="{ row }">{{ row.support.checkCycleMon }} 个月</template>
        </el-table-column>
        <el-table-column label="最近巡查（现场）" min-width="210">
          <template #default="{ row }">
            <div v-if="row.status.latest" class="cell-stack">
              <span>{{ row.status.latest.date }} · {{ row.status.latest.inspector || '未署名' }}</span>
              <span class="cell-sub">
                <el-tag
                  :type="row.status.latest.result === '异常待处理' ? 'danger' : row.status.latest.result === '需关注' ? 'warning' : 'success'"
                  size="small"
                >
                  {{ row.status.latest.result }}
                </el-tag>
                {{ row.status.latest.note }}
              </span>
            </div>
            <span v-else class="cell-warn">巡查班组从未上交记录（自安装起算）</span>
          </template>
        </el-table-column>
        <el-table-column label="下次检查" width="115">
          <template #default="{ row }">{{ row.status.nextDate || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查状态" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.status.overdue" type="danger" effect="dark">
              超期 {{ row.status.overdueDays }} 天
            </el-tag>
            <el-tag v-else type="success" effect="light">周期内</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 旧数据补不出首条记录的，单列提示 -->
      <el-alert
        v-if="backfillFailed.length > 0"
        type="info"
        show-icon
        :closable="false"
        class="mt-14"
        title="以下旧加固件缺少安装日期，无法按安装日期与周期补出首条巡查记录，已单列："
      >
        <template #default>
          <div class="overdue-list">
            <div v-for="row in backfillFailed" :key="row.id">
              {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：{{ row.backfillIssue }}
            </div>
          </div>
        </template>
      </el-alert>
    </el-card>

    <!-- 登记 / 编辑台账（不含检查结果） -->
    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记加固件' : '编辑加固件台账'" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
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
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="item in SUPPORT_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="安装日期" prop="installDate">
              <el-date-picker v-model="form.installDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="检查周期（月）" prop="checkCycleMon">
          <el-input-number v-model="form.checkCycleMon" :min="1" :max="120" :step="1" style="width: 100%" />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="档案室只登记安装日期与检查周期。"
          description="下次检查日期由「最新一条现场巡查日期 + 周期」自动算出；尚无巡查记录时以安装日期作为首次起算点。检查人、现场结论请到「现场巡查」页登记。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 巡查记录并入 -->
    <el-dialog v-model="mergeDialogVisible" title="并入巡查班组现场记录" width="680px">
      <el-alert
        type="info"
        show-icon
        :closable="false"
        :title="`按古树编号 + 类型对台账并入；每条独立提交，成功的照留。上次成功 ${lastMergedCount} 条，待重试 ${failedItems.length} 条。`"
        description="失败条目（编号查无此树、字段缺失等）会原样保留在下方，只需重试巡查这侧，台账与已并入记录不受影响。"
        class="mb-14"
      />
      <el-input
        v-model="mergeText"
        type="textarea"
        :rows="12"
        :placeholder="`粘贴现场记录 JSON 数组，例如：\n${mergeExample}`"
      />
      <div v-if="failedItems.length > 0" class="merge-failed">
        <div v-for="(reason, index) in failedReasons" :key="index" class="merge-failed__item">
          <el-tag type="danger" size="small">失败</el-tag>
          <span class="cell-sub">{{ reason }}</span>
        </div>
      </div>
      <template #footer>
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          accept=".json,application/json"
          :on-change="handleMergeFile"
        >
          <el-button :loading="mergePending">从文件并入</el-button>
        </el-upload>
        <el-button :disabled="failedItems.length === 0" @click="retryFailed">只重试失败的 {{ failedItems.length }} 条</el-button>
        <el-button @click="mergeDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="mergePending" @click="handleMergeSubmit">并入</el-button>
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

.overdue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
  font-size: 12px;
}

.recon-card {
  border-left: 4px solid #d68910;
}

.merge-failed {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.merge-failed__item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mb-14 {
  margin-bottom: 14px;
}

.mt-14 {
  margin-top: 14px;
}

:deep(.row-overdue) {
  --el-table-tr-bg-color: #fdf3f2;
}
</style>
