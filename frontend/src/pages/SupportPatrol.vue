<script setup lang="ts">
/**
 * /supports/checks 加固件现场巡查（巡查班组侧）
 * 每次上树巡检留一条现场记录：检查日期、检查人、现场结论。
 * 最近 / 下次检查日期、超期判定、顶部超期名单与养护总览都按本侧最新一条计算。
 * 录入时按古树 + 类型与档案室台账核对：唯一对得上则自动关联；对不上可照留，
 * 由台账页的对账差异区单列（有巡查无台账）。
 * 复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTreeStore } from '@/stores/treeStore'
import { db } from '@/utils/db'
import { SUPPORT_TYPE_OPTIONS, type SupportType } from '@/types/support'
import {
  CHECK_RESULT_OPTIONS,
  type CheckResult,
  type SupportCheck,
  type SupportCheckDraft,
} from '@/types/supportCheck'
import { reconcileSupports, supportKey } from '@/utils/supportCheck'
import { today } from '@/utils/id'

const treeStore = useTreeStore()

const {
  rows,
  loading,
  create,
  update,
  remove,
} = useIdbTable<SupportCheck>(db.supportChecks, { sortByUpdatedAt: false })

const keyword = ref('')
const treeFilter = ref('all')
const typeFilter = ref<SupportType | 'all'>('all')
const resultFilter = ref<CheckResult | 'all'>('all')

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<SupportCheckDraft>({
  treeId: '',
  type: '支撑杆',
  date: '',
  inspector: '',
  result: '正常',
  note: '',
  supportId: '',
})

const rules: FormRules<SupportCheckDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  date: [{ required: true, message: '请选择检查日期', trigger: 'change' }],
  inspector: [{ required: true, message: '请填写检查人', trigger: 'blur' }],
  result: [{ required: true, message: '请选择现场结论', trigger: 'change' }],
  note: [{ required: true, message: '请写清现场看出什么', trigger: 'blur' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

/** 台账按「古树 + 类型」建索引，录入时核对能否唯一对得上 */
const ledgerByKey = computed(() => {
  const map = new Map<string, { id: string; count: number }>()
  treeStore.supports.forEach((support) => {
    const key = supportKey(support.treeId, support.type)
    const prev = map.get(key)
    map.set(key, prev === undefined ? { id: support.id, count: 1 } : { id: prev.id, count: prev.count + 1 })
  })
  return map
})

/** 选中古树 + 类型时的台账核对结果 */
const ledgerMatch = computed<{ state: 'matched' | 'missing' | 'ambiguous'; supportId: string; message: string }>(() => {
  if (form.treeId === '') return { state: 'missing', supportId: '', message: '请先选择古树' }
  const hit = ledgerByKey.value.get(supportKey(form.treeId, form.type))
  if (hit === undefined) {
    return {
      state: 'missing',
      supportId: '',
      message: `档案室台账查无此「古树 + ${form.type}」，记录可先保存，会在对账差异中列为「有巡查 · 无台账」。`,
    }
  }
  if (hit.count > 1) {
    return {
      state: 'ambiguous',
      supportId: '',
      message: `该古树有 ${hit.count} 件${form.type}，无法唯一关联台账，记录可保存并待档案室核对。`,
    }
  }
  return { state: 'matched', supportId: hit.id, message: `已对上台账（安装日期见档案室台账），保存后自动关联。` }
})

const resultTagType = (result: CheckResult): 'success' | 'warning' | 'danger' =>
  result === '正常' ? 'success' : result === '需关注' ? 'warning' : 'danger'

const filtered = computed<SupportCheck[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      if (resultFilter.value !== 'all' && row.result !== resultFilter.value) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.inspector.toLowerCase().includes(key) ||
        row.note.toLowerCase().includes(key)
      )
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
})

const abnormalCount = computed(
  () => rows.value.filter((row) => row.result === '异常待处理' || row.result === '需关注').length
)
const checkOnlyDiffs = computed(() =>
  reconcileSupports(treeStore.supports, rows.value).filter((item) => item.kind === 'check-only')
)

onMounted(() => {
  void treeStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    treeId:
      treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? ''),
    type: '支撑杆' as SupportType,
    date: today(),
    inspector: '',
    result: '正常' as CheckResult,
    note: '',
    supportId: '',
  })
  dialogVisible.value = true
}

function openEdit(row: SupportCheck): void {
  editingId.value = row.id
  Object.assign(form, {
    treeId: row.treeId,
    type: row.type,
    date: row.date,
    inspector: row.inspector,
    result: row.result,
    note: row.note,
    supportId: row.supportId,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  // 保存瞬间再次核对台账，唯一对得上才写 supportId；否则留空进对账差异
  const hit = ledgerByKey.value.get(supportKey(form.treeId, form.type))
  const supportId = hit !== undefined && hit.count === 1 ? hit.id : ''
  submitting.value = true
  try {
    if (editingId.value === null) {
      await create({ ...form, supportId, source: '' }, 'supportcheck')
      ElMessage.success(supportId ? '现场巡查记录已保存并关联台账' : '现场巡查记录已保存（待台账核对）')
    } else {
      await update(editingId.value, { ...form, supportId })
      ElMessage.success('现场巡查记录已更新')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: SupportCheck): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除 ${row.date}「${row.type}」的现场巡查记录（检查人 ${row.inspector}）？删除后下次检查日期会改按剩余记录里最新一条计算。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await remove(row.id)
  ElMessage.success('现场巡查记录已删除')
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'treeId') treeFilter.value = value
  if (key === 'type') typeFilter.value = value as SupportType | 'all'
  if (key === 'result') resultFilter.value = value as CheckResult | 'all'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="现场巡查记录" :value="rows.length" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge
        label="需关注 / 异常"
        :value="abnormalCount"
        suffix="条"
        :tone="abnormalCount > 0 ? 'warning' : 'success'"
        icon="Warning"
        hint="现场结论为需关注或异常待处理的记录"
      />
      <StatBadge
        label="巡查无台账"
        :value="checkOnlyDiffs.length"
        suffix="项"
        :tone="checkOnlyDiffs.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="现场记录按古树+类型对不上档案室台账"
      />
      <StatBadge label="筛选结果" :value="filtered.length" suffix="条" tone="info" icon="PieChart" size="small" />
    </div>

    <el-alert
      v-if="checkOnlyDiffs.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${checkOnlyDiffs.length} 项现场记录在档案室台账中查无对应加固件`"
    >
      <template #default>
        <div class="overdue-list">
          <div v-for="item in checkOnlyDiffs" :key="item.key">
            {{ treeLabel[item.treeId] ?? '（古树已删除）' }} · {{ item.type }}：{{ item.message }}
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">加固件现场巡查记录（巡查班组：每次上树一条）</span>
          <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记现场记录</span>
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
          { key: 'type', label: '加固件类型', options: SUPPORT_TYPE_OPTIONS as unknown as string[] },
          { key: 'result', label: '现场结论', options: CHECK_RESULT_OPTIONS as unknown as string[] },
        ]"
        :values="{ treeId: treeFilter, type: typeFilter, result: resultFilter }"
        :result-text="`命中 ${filtered.length} / ${rows.length} 条`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
        @reset="
          () => {
            keyword = ''
            treeFilter = 'all'
            typeFilter = 'all'
            resultFilter = 'all'
          }
        "
      />

      <EmptyPanel
        v-if="rows.length === 0 && !loading"
        title="还没有现场巡查记录"
        description="巡查班组每次上树巡检留一条：检查日期、检查人和现场结论。下次检查日期与超期会按最新一条自动计算。"
        action-text="登记第一条现场记录"
        @action="openCreate"
      />

      <el-table v-else v-loading="loading || !treeStore.ready" :data="filtered" row-key="id" stripe>
        <el-table-column label="古树" min-width="180">
          <template #default="{ row }">
            <span>{{ treeLabel[row.treeId] ?? `（古树已删除 / ${row.treeId}）` }}</span>
          </template>
        </el-table-column>
        <el-table-column label="加固件" width="100">
          <template #default="{ row }">
            <el-tag :type="row.type === '避雷' ? 'warning' : row.type === '拉纤' ? 'info' : 'success'" size="small">
              {{ row.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="date" label="检查日期" width="115" />
        <el-table-column prop="inspector" label="检查人" width="110" />
        <el-table-column label="现场结论" width="120">
          <template #default="{ row }">
            <el-tag :type="resultTagType(row.result)" size="small" effect="dark">{{ row.result }}</el-tag>
            <el-tag v-if="row.source === 'legacy-backfill'" type="info" size="small" effect="plain" class="ml-4">
              旧数据补录
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="现场情况" min-width="260">
          <template #default="{ row }">
            <span>{{ row.note }}</span>
          </template>
        </el-table-column>
        <el-table-column label="台账核对" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.supportId !== ''" type="success" size="small" effect="plain">已关联</el-tag>
            <el-tag v-else type="danger" size="small" effect="plain">对不上台账</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记现场巡查记录' : '编辑现场巡查记录'" width="640px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
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
          <el-col :span="8">
            <el-form-item label="加固件类型" prop="type">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="item in SUPPORT_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检查日期" prop="date">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检查人" prop="inspector">
              <el-input v-model="form.inspector" placeholder="上树巡检人" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="现场结论" prop="result">
          <el-radio-group v-model="form.result">
            <el-radio-button v-for="item in CHECK_RESULT_OPTIONS" :key="item" :value="item" :label="item" />
          </el-radio-group>
        </el-form-item>
        <el-form-item label="现场情况" prop="note">
          <el-input
            v-model="form.note"
            type="textarea"
            :rows="3"
            placeholder="写清现场看出什么：抱箍 / 连接件是否松动、锈蚀、钢丝绳断丝、接地电阻、引下线固定等"
          />
        </el-form-item>
        <el-alert
          :type="ledgerMatch.state === 'matched' ? 'success' : 'warning'"
          show-icon
          :closable="false"
          :title="ledgerMatch.state === 'matched' ? '台账核对一致' : '台账核对提示'"
          :description="ledgerMatch.message"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存现场记录</el-button>
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

.mb-14 {
  margin-bottom: 14px;
}

.ml-4 {
  margin-left: 4px;
}
</style>
