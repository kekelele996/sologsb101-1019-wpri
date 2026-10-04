<script setup lang="ts">
/**
 * /outsource 馆外送修与回件对账
 * 本室记送修登记（送去哪几叶、交给哪家工坊、约定哪天交回），
 * 工坊记回件单（交回日期、实际交了哪几叶、返工说明），两边各记各的。
 * 每批交回逐叶对账：对不上的批次与叶号摆出来等人认领，本室补做送修登记、不动工坊那本；
 * 工坊登记失败按本侧重试；过约定交期未交回标逾期提醒，书叶仍留在修复中。
 * 消费 OutsourceBatch、ReturnSlip、Leaf；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Checked, Delete, Edit, Plus, RefreshRight } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useOutsourceStore } from '@/stores/outsourceStore'
import {
  OUTSOURCE_STATE_COLOR,
  OUTSOURCE_STATE_LABEL,
  OUTSOURCE_STATE_OPTIONS,
  WORKSHOP_OPTIONS,
  createEmptyBatchDraft,
  isBatchOverdue,
  todayStr,
  type OutsourceBatch,
  type OutsourceBatchState
} from '@/types/outsourceBatch'
import {
  SLIP_REGISTER_COLOR,
  SLIP_REGISTER_LABEL,
  parseLeafNos,
  type ReturnSlip,
  type SlipRegisterState
} from '@/types/returnSlip'
import { BINDING_TYPE_LABEL, isVolumeLocked } from '@/types/volume'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const outsourceStore = useOutsourceStore()

const FILTER_KEYS = ['state', 'workshop'] as const
const url = useFilterQuery(FILTER_KEYS)

/* ----------------------------- 筛选与统计 ----------------------------- */
const workshopOptions = computed<string[]>(() =>
  Array.from(new Set([...WORKSHOP_OPTIONS, ...outsourceStore.batches.map((batch) => batch.workshop)])).sort()
)

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  state: url.values.value.state ?? [],
  workshop: url.values.value.workshop ?? []
}))

const filterSelects = computed(() => [
  { key: 'state', label: '对账状态', options: OUTSOURCE_STATE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  { key: 'workshop', label: '工坊', options: workshopOptions.value.map((name) => ({ label: name, value: name })) }
])

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    state: (next.state as string[]) ?? [],
    workshop: (next.workshop as string[]) ?? []
  })
}

const filteredBatches = computed<OutsourceBatch[]>(() => {
  const keyword = url.keyword.value.trim()
  const states = url.values.value.state ?? []
  const workshops = url.values.value.workshop ?? []
  return outsourceStore.batches.filter((batch) => {
    if (keyword.length > 0) {
      const haystack = `${batch.workshop}${batch.leafNos.join('、')}${batch.note}${batch.sentDate}${batch.dueDate}`
      if (!haystack.includes(keyword)) return false
    }
    if (states.length > 0 && !states.includes(outsourceStore.reconOf(batch.id).state)) return false
    if (workshops.length > 0 && !workshops.includes(batch.workshop)) return false
    return true
  })
})

const stat = computed(() => {
  let open = 0
  let returned = 0
  let overdue = 0
  outsourceStore.batches.forEach((batch) => {
    const recon = outsourceStore.reconOf(batch.id)
    if (recon.state === 'returned') returned += 1
    else open += 1
    if (isBatchOverdue(batch, recon)) overdue += 1
  })
  return {
    open,
    returned,
    overdue,
    claims: outsourceStore.claims.length,
    failed: outsourceStore.failedSlips.length
  }
})

/* ----------------------------- 展示辅助 ----------------------------- */
function volumeLabel(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
}

function batchLabel(batchId: string): string {
  const batch = outsourceStore.batchById(batchId)
  if (!batch) return '批次已删除'
  return `${volumeLabel(batch.volumeId)} · ${batch.workshop}`
}

function stateLabel(state: OutsourceBatchState): string {
  return OUTSOURCE_STATE_LABEL[state] ?? state
}

function stateColor(state: OutsourceBatchState): string {
  return OUTSOURCE_STATE_COLOR[state] ?? '#8c8c8c'
}

function registerLabel(state: SlipRegisterState): string {
  return SLIP_REGISTER_LABEL[state] ?? state
}

function registerColor(state: SlipRegisterState): string {
  return SLIP_REGISTER_COLOR[state] ?? '#8c8c8c'
}

function overdueOf(batch: OutsourceBatch): boolean {
  return isBatchOverdue(batch, outsourceStore.reconOf(batch.id))
}

/** 已交回叶号中属于本批登记送出的数量（对账进度分子） */
function hitCount(batch: OutsourceBatch): number {
  const recon = outsourceStore.reconOf(batch.id)
  return batch.leafNos.filter((leafNo) => recon.returnedLeafNos.includes(leafNo)).length
}

/* ----------------------------- 送修登记（本室那本） ----------------------------- */
const batchDialog = ref(false)
const editingBatch = ref<OutsourceBatch | null>(null)
const batchForm = reactive(createEmptyBatchDraft(''))

const volumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      value: volume.id,
      label: `《${book.title}》第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]}`,
      disabled: isVolumeLocked(volume.state) && volume.id !== editingBatch.value?.volumeId
    }))
  )
)

/** 可选叶号：该册已登记书叶的叶号；已随其他批次在外的禁用 */
const leafNoOptions = computed(() => {
  if (!batchForm.volumeId) return []
  const leafNos = new Set<number>()
  leafStore.leavesOfVolume(batchForm.volumeId).forEach((leaf) => leafNos.add(leaf.leafNo))
  if (editingBatch.value) editingBatch.value.leafNos.forEach((leafNo) => leafNos.add(leafNo))
  return Array.from(leafNos)
    .sort((a, b) => a - b)
    .map((leafNo) => {
      const outElsewhere = leafStore.leaves.some((leaf) => {
        const mark = leaf.outsource
        return (
          leaf.volumeId === batchForm.volumeId &&
          leaf.leafNo === leafNo &&
          mark != null &&
          mark.batchId !== editingBatch.value?.id
        )
      })
      return { value: leafNo, label: outElsewhere ? `第 ${leafNo} 叶（已在外）` : `第 ${leafNo} 叶`, disabled: outElsewhere }
    })
})

function openBatchCreate(): void {
  const first = volumeOptions.value.find((item) => !item.disabled)
  if (!first) {
    ElMessage.warning('请先在古籍台账登记册次')
    return
  }
  editingBatch.value = null
  Object.assign(batchForm, createEmptyBatchDraft(first.value))
  batchDialog.value = true
}

function openBatchEdit(batch: OutsourceBatch): void {
  editingBatch.value = batch
  Object.assign(batchForm, {
    volumeId: batch.volumeId,
    workshop: batch.workshop,
    sentDate: batch.sentDate,
    dueDate: batch.dueDate,
    leafNos: [...batch.leafNos],
    note: batch.note
  })
  batchDialog.value = true
}

async function submitBatch(): Promise<void> {
  if (!batchForm.volumeId) {
    ElMessage.warning('请选择册次')
    return
  }
  if (batchForm.workshop.trim().length === 0) {
    ElMessage.warning('请填写工坊')
    return
  }
  if (!batchForm.sentDate || !batchForm.dueDate) {
    ElMessage.warning('请填写送修日期与约定交回日期')
    return
  }
  if (batchForm.leafNos.length === 0) {
    ElMessage.warning('请至少选择一片送出的书叶')
    return
  }
  const payload = { ...batchForm, workshop: batchForm.workshop.trim(), leafNos: [...batchForm.leafNos] }
  if (editingBatch.value) {
    await outsourceStore.updateBatch(editingBatch.value.id, payload)
    ElMessage.success('已更新送修登记')
  } else {
    await outsourceStore.createBatch(payload)
    ElMessage.success('已登记送修批次，送出书叶标记为在外')
  }
  batchDialog.value = false
}

async function removeBatch(batch: OutsourceBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '只删除本室送修登记，工坊回件单保留（显示批次已删除）；在外书叶的标记将解除。',
      '删除送修登记',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await outsourceStore.removeBatch(batch.id)
  ElMessage.success('已删除本室送修登记，工坊那本未动')
}

/* ----------------------------- 回件单（工坊那本） ----------------------------- */
const slipDialog = ref(false)
const editingSlip = ref<ReturnSlip | null>(null)
const slipForm = reactive({
  batchId: '',
  workshop: '',
  returnDate: '',
  leafNosText: '',
  reworkNote: ''
})

/** 可登记回件的批次：未结清的 */
const openBatchOptions = computed(() =>
  outsourceStore.batches
    .filter((batch) => outsourceStore.reconOf(batch.id).state !== 'returned')
    .map((batch) => ({ value: batch.id, label: `${batchLabel(batch.id)} · 送修 ${batch.sentDate}` }))
)

function openSlipCreate(batchId = ''): void {
  if (openBatchOptions.value.length === 0) {
    ElMessage.warning('当前没有在外的送修批次')
    return
  }
  editingSlip.value = null
  const target = batchId || (openBatchOptions.value[0]?.value ?? '')
  const batch = outsourceStore.batchById(target)
  Object.assign(slipForm, {
    batchId: target,
    workshop: batch?.workshop ?? '',
    returnDate: todayStr(),
    leafNosText: '',
    reworkNote: ''
  })
  slipDialog.value = true
}

function openSlipEdit(slip: ReturnSlip): void {
  editingSlip.value = slip
  Object.assign(slipForm, {
    batchId: slip.batchId,
    workshop: slip.workshop,
    returnDate: slip.returnDate,
    leafNosText: slip.leafNos.join('、'),
    reworkNote: slip.reworkNote
  })
  slipDialog.value = true
}

function handleSlipBatchChange(batchId: string): void {
  const batch = outsourceStore.batchById(batchId)
  if (batch) slipForm.workshop = batch.workshop
}

async function submitSlip(): Promise<void> {
  const draft = {
    batchId: slipForm.batchId,
    workshop: slipForm.workshop.trim(),
    returnDate: slipForm.returnDate,
    leafNos: parseLeafNos(slipForm.leafNosText),
    reworkNote: slipForm.reworkNote.trim()
  }
  if (editingSlip.value) {
    await outsourceStore.updateSlip(editingSlip.value.id, draft)
    ElMessage.success(
      editingSlip.value.registerState === 'registered' ? '已更新回件单并重新对账' : '已更新回件单（登记仍失败，可补全后重试）'
    )
  } else {
    const { problem } = await outsourceStore.createSlip(draft)
    if (problem) ElMessage.warning(`登记失败：${problem}；已在工坊那本留痕，可补全后重试`)
    else ElMessage.success('回件单已登记，完成逐叶对账')
  }
  slipDialog.value = false
}

/** 工坊那本登记失败 → 按本侧重试一遍，本室送修登记照旧 */
async function retrySlip(slip: ReturnSlip): Promise<void> {
  const problem = await outsourceStore.retrySlip(slip.id)
  if (problem) ElMessage.warning(`重试仍失败：${problem}`)
  else ElMessage.success('重试成功，回件单已登记并完成逐叶对账（本室送修登记未改动）')
}

async function removeSlip(slip: ReturnSlip): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后该批已交回的叶号将重新计为在外。', '删除回件单', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await outsourceStore.removeSlip(slip.id)
  ElMessage.success('已删除回件单')
}

/* ----------------------------- 待认领 ----------------------------- */
const claimRows = computed(() =>
  outsourceStore.claims
    .map((claim) => ({ ...claim, batch: outsourceStore.batchById(claim.batchId) }))
    .filter((row) => row.batch !== undefined)
)

/** 认领：本室补做送修登记（补记叶号），工坊回件单不动 */
async function claim(batchId: string, leafNo: number): Promise<void> {
  await outsourceStore.claimLeaf(batchId, leafNo)
  ElMessage.success(`已在本室送修登记补记第 ${leafNo} 叶，工坊回件单未改动`)
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>馆外送修与回件对账</h2>
        <p>本室记送修登记、工坊记回件单，两边各记各的；每批交回逐叶对账，对不上摆出来等人认领。</p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Plus" @click="openSlipCreate()">登记回件单</el-button>
        <el-button type="primary" :icon="Plus" @click="openBatchCreate">新增送修登记</el-button>
      </div>
    </div>

    <el-alert
      v-if="stat.overdue > 0"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 12px"
      :title="`${stat.overdue} 批已过约定交期未交回`"
      description="书叶仍留在修复中，请向工坊催办；交回后登记回件单即可逐叶对账。"
    />

    <div class="gb-stat-row">
      <StatBadge label="在外批次" :value="stat.open" suffix="批" tone="primary" />
      <StatBadge label="逾期未回" :value="stat.overdue" suffix="批" tone="danger" />
      <StatBadge label="待认领叶号" :value="stat.claims" suffix="叶" tone="warning" />
      <StatBadge label="登记失败回件单" :value="stat.failed" suffix="张" tone="danger" />
      <StatBadge label="已结清批次" :value="stat.returned" suffix="批" tone="success" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索工坊 / 叶号 / 备注…"
      @change="handleFilterChange"
      @reset="url.reset()"
    />

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>送修登记（本室那本）</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openBatchCreate">新增送修登记</el-button>
            </div>
          </template>

          <EmptyPanel
            v-if="filteredBatches.length === 0"
            title="没有送修登记"
            description="修复室做不完的册可登记送馆外工坊整册托裱：送去哪几叶、交给哪家工坊、约定哪天交回。"
            action-text="新增送修登记"
            size="small"
            @action="openBatchCreate"
          />
          <el-table v-else :data="filteredBatches" size="small" border>
            <el-table-column label="册次" min-width="150">
              <template #default="{ row }">{{ volumeLabel(row.volumeId) }}</template>
            </el-table-column>
            <el-table-column prop="workshop" label="工坊" min-width="120" />
            <el-table-column prop="sentDate" label="送修" width="105" sortable />
            <el-table-column prop="dueDate" label="约定交回" width="105" sortable />
            <el-table-column label="送出叶号" min-width="110">
              <template #default="{ row }">{{ row.leafNos.join('、') }}</template>
            </el-table-column>
            <el-table-column label="对账" width="90">
              <template #default="{ row }">{{ hitCount(row) }}/{{ row.leafNos.length }}</template>
            </el-table-column>
            <el-table-column label="状态" width="150">
              <template #default="{ row }">
                <el-tag
                  :style="{ color: stateColor(outsourceStore.reconOf(row.id).state), borderColor: `${stateColor(outsourceStore.reconOf(row.id).state)}66` }"
                  effect="plain"
                  round
                >
                  {{ stateLabel(outsourceStore.reconOf(row.id).state) }}
                </el-tag>
                <el-tag v-if="overdueOf(row)" type="danger" effect="dark" round size="small" style="margin-left: 4px">
                  已逾期
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="210">
              <template #default="{ row }">
                <el-button size="small" text type="primary" @click="openSlipCreate(row.id)">登记回件</el-button>
                <el-button size="small" text :icon="Edit" @click="openBatchEdit(row)">编辑</el-button>
                <el-button size="small" text type="danger" :icon="Delete" @click="removeBatch(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="10">
        <el-card shadow="never" class="outsource-slips-card">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>回件单（工坊那本）</span>
              <el-button size="small" :icon="Plus" @click="openSlipCreate()">登记回件单</el-button>
            </div>
          </template>

          <EmptyPanel
            v-if="outsourceStore.slips.length === 0"
            title="还没有回件单"
            description="工坊交回时登记：交回日期、实际交了哪几叶、返工说明；登记失败留痕后可按本侧重试。"
            action-text="登记回件单"
            size="small"
            @action="openSlipCreate()"
          />
          <el-table v-else :data="outsourceStore.slips" size="small" border>
            <el-table-column label="归属批次" min-width="150">
              <template #default="{ row }">{{ batchLabel(row.batchId) }}</template>
            </el-table-column>
            <el-table-column label="交回日期" width="100">
              <template #default="{ row }">{{ row.returnDate || '未填' }}</template>
            </el-table-column>
            <el-table-column label="交回叶号" min-width="90">
              <template #default="{ row }">{{ row.leafNos.length > 0 ? row.leafNos.join('、') : '未登记' }}</template>
            </el-table-column>
            <el-table-column prop="reworkNote" label="返工说明" min-width="120" show-overflow-tooltip />
            <el-table-column label="登记" width="90">
              <template #default="{ row }">
                <el-tag
                  :style="{ color: registerColor(row.registerState), borderColor: `${registerColor(row.registerState)}66` }"
                  effect="plain"
                  round
                >
                  {{ registerLabel(row.registerState) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="190">
              <template #default="{ row }">
                <el-button
                  v-if="row.registerState === 'failed'"
                  size="small"
                  text
                  type="warning"
                  :icon="RefreshRight"
                  @click="retrySlip(row)"
                >
                  重试
                </el-button>
                <el-button size="small" text :icon="Edit" @click="openSlipEdit(row)">编辑</el-button>
                <el-button size="small" text type="danger" :icon="Delete" @click="removeSlip(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>待认领 · 对不上的批次与叶号</template>
      <EmptyPanel
        v-if="claimRows.length === 0"
        title="没有待认领的叶号"
        description="两侧登记的叶号逐一对账一致；对不上时会连批次一起摆在这里等人认领。"
        size="small"
      />
      <div v-else>
        <div v-for="row in claimRows" :key="`${row.batchId}-${row.leafNo}`" class="gb-step-row">
          <el-tag effect="plain" round>第 {{ row.leafNo }} 叶</el-tag>
          <strong>{{ batchLabel(row.batchId) }}</strong>
          <span class="gb-muted">送修 {{ row.batch?.sentDate }} · 约定 {{ row.batch?.dueDate }}</span>
          <span class="gb-muted">工坊已交回，本室登记未送出</span>
          <el-button style="margin-left: auto" size="small" type="primary" plain :icon="Checked" @click="claim(row.batchId, row.leafNo)">
            补做送修登记
          </el-button>
        </div>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          style="margin-top: 10px"
          title="认领只补本室送修登记，工坊回件单保持原样"
          description="确认是本室漏登的送出叶后点「补做送修登记」，叶号补记进对应批次，工坊那本不作改动。"
        />
      </div>
    </el-card>

    <el-dialog v-model="batchDialog" :title="editingBatch ? '编辑送修登记' : '新增送修登记'" width="560px">
      <el-form label-width="110px">
        <el-form-item label="册次" required>
          <el-select v-model="batchForm.volumeId" style="width: 100%" :disabled="editingBatch !== null">
            <el-option
              v-for="item in volumeOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
              :disabled="item.disabled"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="工坊" required>
          <el-select v-model="batchForm.workshop" filterable allow-create default-first-option style="width: 100%">
            <el-option v-for="name in workshopOptions" :key="name" :label="name" :value="name" />
          </el-select>
        </el-form-item>
        <el-form-item label="送修日期" required>
          <el-input v-model="batchForm.sentDate" type="date" />
        </el-form-item>
        <el-form-item label="约定交回" required>
          <el-input v-model="batchForm.dueDate" type="date" />
        </el-form-item>
        <el-form-item label="送出叶号" required>
          <el-select v-model="batchForm.leafNos" multiple collapse-tags collapse-tags-tooltip style="width: 100%" placeholder="选择送出的书叶">
            <el-option
              v-for="item in leafNoOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
              :disabled="item.disabled"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="batchForm.note" placeholder="如：整册托裱第一批" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="slipDialog" :title="editingSlip ? '编辑回件单' : '登记回件单'" width="560px">
      <el-form label-width="110px">
        <el-form-item label="归属批次" required>
          <el-select
            v-model="slipForm.batchId"
            style="width: 100%"
            :disabled="editingSlip !== null"
            @change="handleSlipBatchChange"
          >
            <el-option v-for="item in openBatchOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="工坊" required>
          <el-input v-model="slipForm.workshop" placeholder="交回的工坊" />
        </el-form-item>
        <el-form-item label="交回日期" required>
          <el-input v-model="slipForm.returnDate" type="date" />
        </el-form-item>
        <el-form-item label="交回叶号" required>
          <el-input v-model="slipForm.leafNosText" placeholder="如：3、8、12（逗号或顿号分隔）" />
        </el-form-item>
        <el-form-item label="返工说明">
          <el-input v-model="slipForm.reworkNote" type="textarea" :rows="2" placeholder="如：第 12 叶托裱后起皱，已返工压平" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="信息不全的回件单会留痕为「登记失败」"
        description="补全后在列表里点「重试」按本侧重登一遍，本室送修登记照旧不动。"
      />
      <template #footer>
        <el-button @click="slipDialog = false">取消</el-button>
        <el-button type="primary" @click="submitSlip">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
@media (max-width: 1200px) {
  .outsource-slips-card {
    margin-top: 16px;
  }
}
</style>
