<script setup lang="ts">
/**
 * /workshop 馆外托裱跟踪
 * 修复室做不完的册送去馆外工坊做整册托裱，两边各记各的：
 * - 本室那本：送修登记（送去哪几叶、交给哪家工坊、约定哪天交回）
 * - 工坊那本：回件单（交回日期、实际交了哪几叶、返工说明）
 * 每批交回逐一对账，对不上把批次和叶号摆出来等人认领；
 * 本室补做送修登记不动工坊那本；工坊那本登记失败按本侧重试一遍；
 * 过了约定交期标逾期提醒，书叶仍留在修复中。
 * 消费 Workshop / SendRegistration / ReturnSlip；复用 <StatBadge>、<EmptyPanel>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Link,
  Plus,
  RefreshRight,
  Shop,
  Warning
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useWorkshopStore } from '@/stores/workshopStore'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import type { WorkshopDraft } from '@/types/workshop'
import {
  SEND_STATUS_COLOR,
  SEND_STATUS_LABEL,
  createEmptySendDraft,
  type SendRegistration,
  type SendRegistrationDraft
} from '@/types/sendRegistration'
import {
  RECONCILE_STATUS_COLOR,
  RECONCILE_STATUS_LABEL,
  createEmptyReturnDraft,
  type ReconcileDiff,
  type ReturnSlip,
  type ReturnSlipDraft
} from '@/types/returnSlip'
import type { Leaf } from '@/types/leaf'

const workshopStore = useWorkshopStore()
const bookStore = useBookStore()
const leafStore = useLeafStore()

onMounted(async () => {
  await Promise.all([workshopStore.loadAll(), bookStore.loadBooks(), bookStore.loadVolumes(), leafStore.loadLeaves()])
})

/* ------------------------------ 统计 ------------------------------ */

const stat = computed(() => {
  const sends = workshopStore.sendRegistrations
  const active = sends.filter((s) => workshopStore.sendStatusOf(s) === 'active').length
  const overdue = workshopStore.overdueSends.length
  const returned = sends.filter((s) => workshopStore.sendStatusOf(s) === 'returned').length
  const unmatched = workshopStore.unmatchedSlips.length
  return { active, overdue, returned, unmatched }
})

/* ------------------------------ 书叶展示 ------------------------------ */

interface LeafOption {
  value: string
  label: string
  volumeLabel: string
  leafNo: number
  disabled: boolean
}

/** 可送修的书叶：非只读、未归档册次的叶 */
const leafOptions = computed<LeafOption[]>(() => {
  const result: LeafOption[] = []
  bookStore.books.forEach((book) => {
    bookStore.volumesOfBook(book.id).forEach((volume) => {
      const volLabel = `《${book.title}》第 ${volume.volumeNo} 册`
      leafStore.leavesOfVolume(volume.id).forEach((leaf) => {
        result.push({
          value: leaf.id,
          label: `${volLabel} · 第 ${leaf.leafNo} 叶`,
          volumeLabel: volLabel,
          leafNo: leaf.leafNo,
          disabled: leaf.readOnly
        })
      })
    })
  })
  return result
})

function leafLabel(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '书叶已删除'
  const volume = bookStore.volumeById(leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : null
  return `${book ? `《${book.title}》` : ''}第 ${leaf.leafNo} 叶`
}

function leavesOfSend(send: SendRegistration): Leaf[] {
  return send.leafIds.map((id) => leafStore.leafById(id)).filter((l): l is Leaf => !!l)
}

/* ------------------------------ 送修登记表单 ------------------------------ */

const sendDialog = ref(false)
const sendForm = reactive<SendRegistrationDraft>(createEmptySendDraft('', ''))
const sendFormBatchNo = ref('')

function openSendDialog(): void {
  if (workshopStore.workshops.length === 0) {
    ElMessage.warning('请先登记工坊')
    return
  }
  sendFormBatchNo.value = workshopStore.nextBatchNo()
  Object.assign(sendForm, createEmptySendDraft(workshopStore.workshops[0]?.id ?? '', sendFormBatchNo.value))
  sendForm.leafIds = []
  sendDialog.value = true
}

async function submitSend(): Promise<void> {
  if (!sendForm.workshopId) {
    ElMessage.warning('请选择工坊')
    return
  }
  if (sendForm.leafIds.length === 0) {
    ElMessage.warning('请选择送去的书叶')
    return
  }
  await workshopStore.createSendRegistration({ ...sendForm, batchNo: sendFormBatchNo.value })
  // 书叶仍留在修复中：送出的叶标记为修复中
  await leafStore.batchUpdate(sendForm.leafIds, { state: 'repairing' })
  ElMessage.success(`送修登记 ${sendFormBatchNo.value} 已建立`)
  sendDialog.value = false
}

/* ------------------------------ 回件单表单 ------------------------------ */

const returnDialog = ref(false)
const returnForm = reactive<ReturnSlipDraft>(createEmptyReturnDraft('', null, []))
const returnDiff = ref<ReconcileDiff | null>(null)

function openReturnDialog(send?: SendRegistration): void {
  if (send) {
    Object.assign(returnForm, createEmptyReturnDraft(send.workshopId, send.id, [...send.leafIds]))
  } else {
    const first = workshopStore.sendRegistrations[0]
    if (!first) {
      ElMessage.warning('请先建立送修登记')
      return
    }
    Object.assign(returnForm, createEmptyReturnDraft(first.workshopId, first.id, [...first.leafIds]))
  }
  returnDiff.value = null
  returnDialog.value = true
}

/** 选择批次后带出工坊与叶号（本室那本数据） */
function onBatchChange(batchId: string): void {
  const send = workshopStore.sendById(batchId)
  if (!send) return
  returnForm.workshopId = send.workshopId
  returnForm.leafIds = [...send.leafIds]
}

async function submitReturn(): Promise<void> {
  if (!returnForm.batchId) {
    ElMessage.warning('请选择批次')
    return
  }
  if (returnForm.leafIds.length === 0) {
    ElMessage.warning('请选择交回的书叶')
    return
  }
  const result = await workshopStore.createReturnSlip({ ...returnForm })
  returnDiff.value = result.diff
  if (result.retried) {
    ElMessage.warning('工坊那本登记失败，已按本室送修登记重试一遍')
  }
  if (result.diff.missing.length === 0 && result.diff.extra.length === 0) {
    ElMessage.success('回件单已登记，两侧叶号一致')
  } else {
    ElMessage.warning('两侧叶号对不上，请认领')
  }
}

/* ------------------------------ 认领 ------------------------------ */

const claimDialog = ref(false)
const claimTarget = ref<ReturnSlip | null>(null)
const claimForm = reactive({ claimNote: '', claimedBy: '' })

/** 认领目标批次号 */
const claimBatchNo = computed(() => {
  const slip = claimTarget.value
  if (!slip || !slip.batchId) return '无批次（补做）'
  return workshopStore.sendById(slip.batchId)?.batchNo ?? '批次已删除'
})

/** 认领目标的对账差异 */
const claimDiff = computed<ReconcileDiff | null>(() => {
  const slip = claimTarget.value
  if (!slip || !slip.batchId) return null
  const send = workshopStore.sendById(slip.batchId)
  if (!send) return null
  return workshopStore.reconcileOfSend(send)
})

function openClaim(slip: ReturnSlip): void {
  claimTarget.value = slip
  claimForm.claimNote = ''
  claimForm.claimedBy = ''
  claimDialog.value = true
}

async function submitClaim(): Promise<void> {
  if (!claimTarget.value) return
  if (!claimForm.claimedBy.trim()) {
    ElMessage.warning('请填写认领人')
    return
  }
  await workshopStore.claimSlip(claimTarget.value.id, claimForm.claimNote, claimForm.claimedBy.trim())
  ElMessage.success('已认领')
  claimDialog.value = false
}

/* ------------------------------ 补做送修登记 ------------------------------ */

async function makeupSend(slip: ReturnSlip): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将按工坊回件单（${slip.returnDate}，${slip.leafIds.length} 叶）补做一本送修登记，工坊那本不动。`,
      '补做送修登记',
      { type: 'warning', confirmButtonText: '补做', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await workshopStore.makeupSendRegistration({
    batchId: null,
    workshopId: slip.workshopId,
    returnDate: slip.returnDate,
    leafIds: [...slip.leafIds],
    reworkNote: slip.reworkNote
  })
  ElMessage.success('已补做送修登记，工坊回件单保持不变')
}

/* ------------------------------ 工坊管理 ------------------------------ */

const workshopDialog = ref(false)
const workshopForm = reactive<WorkshopDraft>({ name: '', contact: '', note: '' })

function openWorkshopDialog(): void {
  workshopForm.name = ''
  workshopForm.contact = ''
  workshopForm.note = ''
  workshopDialog.value = true
}

async function submitWorkshop(): Promise<void> {
  if (!workshopForm.name.trim()) {
    ElMessage.warning('请填写工坊名称')
    return
  }
  await workshopStore.createWorkshop({ ...workshopForm })
  ElMessage.success('工坊已登记')
  workshopDialog.value = false
}

/* ------------------------------ 样式辅助 ------------------------------ */

function sendStatusColor(send: SendRegistration): string {
  return SEND_STATUS_COLOR[workshopStore.sendStatusOf(send)] ?? '#8c8c8c'
}

function sendStatusLabel(send: SendRegistration): string {
  return SEND_STATUS_LABEL[workshopStore.sendStatusOf(send)] ?? '在修'
}

function reconcileColor(status: string): string {
  return RECONCILE_STATUS_COLOR[status as keyof typeof RECONCILE_STATUS_COLOR] ?? '#8c8c8c'
}

function reconcileLabel(status: string): string {
  return RECONCILE_STATUS_LABEL[status as keyof typeof RECONCILE_STATUS_LABEL] ?? status
}

function diffSummary(diff: ReconcileDiff): string {
  const parts: string[] = []
  if (diff.missing.length > 0) parts.push(`未交回 ${diff.missing.length} 叶`)
  if (diff.extra.length > 0) parts.push(`多交回 ${diff.extra.length} 叶`)
  if (parts.length === 0) return '两侧一致'
  return parts.join('，')
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>馆外托裱跟踪</h2>
        <p>修复室做不完的册送去馆外工坊做整册托裱，两边各记各的，逐一对账</p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Shop" @click="openWorkshopDialog">登记工坊</el-button>
        <el-button type="primary" :icon="Plus" @click="openSendDialog">新增送修登记</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="在修" :value="stat.active" suffix="批" tone="warning" icon="Tools" />
      <StatBadge label="逾期未交回" :value="stat.overdue" suffix="批" tone="danger" icon="AlarmClock" />
      <StatBadge label="已交回" :value="stat.returned" suffix="批" tone="success" icon="CircleCheck" />
      <StatBadge label="待认领" :value="stat.unmatched" suffix="单" tone="info" icon="WarningFilled" />
    </div>

    <el-alert
      v-if="stat.overdue > 0"
      type="error"
      show-icon
      :closable="false"
      class="overdue-alert"
      title="逾期提醒"
      description="以下批次已过约定交期仍未交回，书叶仍留在修复中，请联系工坊催交。"
    >
      <template #default>
        <div>
          <strong>逾期提醒：</strong>
          <el-tag
            v-for="send in workshopStore.overdueSends"
            :key="send.id"
            type="danger"
            effect="plain"
            round
            style="margin: 2px 6px 2px 0"
          >
            {{ send.batchNo }} · 约定 {{ send.agreedReturnDate }}
          </el-tag>
          书叶仍留在修复中。
        </div>
      </template>
    </el-alert>

    <el-tabs>
      <!-- 本室送修登记 -->
      <el-tab-pane label="送修登记（本室那本）" name="send">
        <el-card shadow="never">
          <EmptyPanel
            v-if="workshopStore.sendRegistrations.length === 0"
            title="还没有送修登记"
            description="登记送去馆外工坊整册托裱的书叶、工坊与约定交回日期。"
            action-text="新增送修登记"
            size="small"
            @action="openSendDialog"
          />
          <el-table v-else :data="workshopStore.sendRegistrations" size="small" border>
            <el-table-column prop="batchNo" label="批次号" width="130" />
            <el-table-column label="工坊" min-width="160">
              <template #default="{ row }">
                {{ workshopStore.workshopById(row.workshopId)?.name ?? '工坊已删除' }}
              </template>
            </el-table-column>
            <el-table-column label="送去书叶" min-width="200">
              <template #default="{ row }">
                <el-tag
                  v-for="leaf in leavesOfSend(row)"
                  :key="leaf.id"
                  size="small"
                  effect="plain"
                  round
                  style="margin: 2px 4px 2px 0"
                >
                  {{ leafLabel(leaf.id) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="sendDate" label="送修日期" width="120" sortable />
            <el-table-column prop="agreedReturnDate" label="约定交回" width="120" sortable />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag
                  :style="{ color: sendStatusColor(row), borderColor: `${sendStatusColor(row)}66` }"
                  effect="plain"
                  round
                >
                  {{ sendStatusLabel(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="160">
              <template #default="{ row }">
                <el-button size="small" type="primary" text :icon="RefreshRight" @click="openReturnDialog(row)">
                  登记回件
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 工坊回件单 -->
      <el-tab-pane label="回件单（工坊那本）" name="return">
        <el-card shadow="never">
          <EmptyPanel
            v-if="workshopStore.returnSlips.length === 0"
            title="还没有回件单"
            description="工坊交回书叶时登记回件单，两侧叶号逐一对账。"
            action-text="登记回件"
            size="small"
            @action="openReturnDialog()"
          />
          <el-table v-else :data="workshopStore.returnSlips" size="small" border>
            <el-table-column label="关联批次" width="130">
              <template #default="{ row }">
                {{ row.batchId ? workshopStore.sendById(row.batchId)?.batchNo ?? '—' : '无批次（补做）' }}
              </template>
            </el-table-column>
            <el-table-column label="工坊" min-width="160">
              <template #default="{ row }">
                {{ workshopStore.workshopById(row.workshopId)?.name ?? '工坊已删除' }}
              </template>
            </el-table-column>
            <el-table-column prop="returnDate" label="交回日期" width="120" sortable />
            <el-table-column label="实际交回叶号" min-width="200">
              <template #default="{ row }">
                <el-tag
                  v-for="leafId in row.leafIds"
                  :key="leafId"
                  size="small"
                  type="success"
                  effect="plain"
                  round
                  style="margin: 2px 4px 2px 0"
                >
                  {{ leafLabel(leafId) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reworkNote" label="返工说明" min-width="140" show-overflow-tooltip />
            <el-table-column label="对账" width="100">
              <template #default="{ row }">
                <el-tag
                  :style="{ color: reconcileColor(row.reconcileStatus), borderColor: `${reconcileColor(row.reconcileStatus)}66` }"
                  effect="plain"
                  round
                >
                  {{ reconcileLabel(row.reconcileStatus) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="{ row }">
                <el-button
                  v-if="row.reconcileStatus === 'unmatched'"
                  size="small"
                  type="warning"
                  text
                  :icon="Warning"
                  @click="openClaim(row)"
                >
                  认领
                </el-button>
                <el-button
                  v-if="!row.batchId"
                  size="small"
                  type="primary"
                  text
                  :icon="Link"
                  @click="makeupSend(row)"
                >
                  补做送修
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 工坊管理 -->
      <el-tab-pane label="工坊管理" name="workshop">
        <el-card shadow="never">
          <EmptyPanel
            v-if="workshopStore.workshops.length === 0"
            title="还没有登记工坊"
            description="登记承接整册托裱的馆外修书工坊。"
            action-text="登记工坊"
            size="small"
            @action="openWorkshopDialog"
          />
          <el-table v-else :data="workshopStore.workshops" size="small" border>
            <el-table-column prop="name" label="工坊名称" min-width="200" />
            <el-table-column prop="contact" label="联系方式" min-width="200" />
            <el-table-column prop="note" label="备注" min-width="160" show-overflow-tooltip />
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 新增送修登记 -->
    <el-dialog v-model="sendDialog" title="新增送修登记（本室那本）" width="600px">
      <el-form label-width="100px">
        <el-form-item label="批次号">
          <el-input :model-value="sendFormBatchNo" disabled />
        </el-form-item>
        <el-form-item label="工坊" required>
          <el-select v-model="sendForm.workshopId" style="width: 100%">
            <el-option v-for="w in workshopStore.workshops" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="送去书叶" required>
          <el-select
            v-model="sendForm.leafIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            filterable
            style="width: 100%"
            placeholder="选择送去托裱的书叶"
          >
            <el-option
              v-for="opt in leafOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
              :disabled="opt.disabled"
            />
          </el-select>
          <p class="gb-muted">只读书叶（老档案无法回填批次）不可选。</p>
        </el-form-item>
        <el-form-item label="送修日期">
          <el-input v-model="sendForm.sendDate" type="date" />
        </el-form-item>
        <el-form-item label="约定交回">
          <el-input v-model="sendForm.agreedReturnDate" type="date" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="sendForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sendDialog = false">取消</el-button>
        <el-button type="primary" @click="submitSend">建立登记</el-button>
      </template>
    </el-dialog>

    <!-- 登记回件单 -->
    <el-dialog v-model="returnDialog" title="登记回件单（工坊那本）" width="600px">
      <el-form label-width="100px">
        <el-form-item label="关联批次" required>
          <el-select v-model="returnForm.batchId" style="width: 100%" @change="onBatchChange">
            <el-option
              v-for="s in workshopStore.sendRegistrations"
              :key="s.id"
              :label="`${s.batchNo} · ${workshopStore.workshopById(s.workshopId)?.name ?? ''}`"
              :value="s.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="工坊">
          <el-input :model-value="workshopStore.workshopById(returnForm.workshopId)?.name ?? ''" disabled />
        </el-form-item>
        <el-form-item label="交回日期">
          <el-input v-model="returnForm.returnDate" type="date" />
        </el-form-item>
        <el-form-item label="实际交回叶号" required>
          <el-select
            v-model="returnForm.leafIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            filterable
            style="width: 100%"
            placeholder="选择实际交回的书叶"
          >
            <el-option
              v-for="opt in leafOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
              :disabled="opt.disabled"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="返工说明">
          <el-input v-model="returnForm.reworkNote" type="textarea" :rows="2" placeholder="如有返工请说明" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="returnDiff"
        :type="returnDiff.missing.length === 0 && returnDiff.extra.length === 0 ? 'success' : 'warning'"
        show-icon
        :closable="false"
        style="margin-top: 10px"
        :title="diffSummary(returnDiff)"
      />
      <template #footer>
        <el-button @click="returnDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReturn">登记回件</el-button>
      </template>
    </el-dialog>

    <!-- 认领 -->
    <el-dialog v-model="claimDialog" title="认领对账差异" width="480px">
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        style="margin-bottom: 12px"
        title="两侧叶号对不上，请认领"
        description="把批次和叶号摆出来后，由认领人确认并记录处理结果。"
      />
      <el-form label-width="100px">
        <el-form-item label="批次">
          <el-input :model-value="claimBatchNo" disabled />
        </el-form-item>
        <el-form-item label="差异说明">
          <el-input :model-value="claimDiff ? diffSummary(claimDiff) : '—'" disabled />
        </el-form-item>
        <el-form-item label="认领人" required>
          <el-input v-model="claimForm.claimedBy" placeholder="如：沈玉" />
        </el-form-item>
        <el-form-item label="认领说明">
          <el-input v-model="claimForm.claimNote" type="textarea" :rows="2" placeholder="处理结果说明" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="claimDialog = false">取消</el-button>
        <el-button type="primary" @click="submitClaim">确认认领</el-button>
      </template>
    </el-dialog>

    <!-- 登记工坊 -->
    <el-dialog v-model="workshopDialog" title="登记工坊" width="480px">
      <el-form label-width="100px">
        <el-form-item label="工坊名称" required>
          <el-input v-model="workshopForm.name" placeholder="如：苏州古籍修复工坊" />
        </el-form-item>
        <el-form-item label="联系方式">
          <el-input v-model="workshopForm.contact" placeholder="如：苏州市姑苏区 · 顾师傅" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="workshopForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="workshopDialog = false">取消</el-button>
        <el-button type="primary" @click="submitWorkshop">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.overdue-alert {
  margin-bottom: 14px;
}
</style>
