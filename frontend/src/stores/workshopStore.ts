/**
 * 馆外工坊 store（Pinia setup store）
 * 维护工坊、送修登记（本室那本）、回件单（工坊那本）；
 * 负责两侧叶号逐一对账、认领、补做送修登记、登记失败按本侧重试、逾期提醒。
 * 页面只读 store，跨页状态不留组件内部 ref。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import type { Workshop, WorkshopDraft } from '@/types/workshop'
import {
  deriveSendStatus,
  generateBatchNo,
  type SendRegistration,
  type SendRegistrationDraft,
  type SendStatus
} from '@/types/sendRegistration'
import {
  reconcileLeafIds,
  type ReconcileDiff,
  type ReturnSlip,
  type ReturnSlipDraft
} from '@/types/returnSlip'

/** 回件单登记结果：是否重试了第二遍 */
export interface ReturnSlipResult {
  slip: ReturnSlip
  /** 工坊那本登记失败后按本侧重试了一遍 */
  retried: boolean
  /** 对账差异（一致时为空） */
  diff: ReconcileDiff
}

export const useWorkshopStore = defineStore('workshop', () => {
  const workshops = ref<Workshop[]>([])
  const sendRegistrations = ref<SendRegistration[]>([])
  const returnSlips = ref<ReturnSlip[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  const today = computed(() => new Date().toISOString().slice(0, 10))

  /* ------------------------------ 派生查询 ------------------------------ */

  function workshopById(id: string): Workshop | undefined {
    return workshops.value.find((w) => w.id === id)
  }

  function sendById(id: string): SendRegistration | undefined {
    return sendRegistrations.value.find((s) => s.id === id)
  }

  function slipById(id: string): ReturnSlip | undefined {
    return returnSlips.value.find((s) => s.id === id)
  }

  function slipsOfBatch(batchId: string | null): ReturnSlip[] {
    if (!batchId) return []
    return returnSlips.value
      .filter((s) => s.batchId === batchId)
      .sort((a, b) => a.returnDate.localeCompare(b.returnDate))
  }

  /** 某批次累计已交回的叶号（两侧对账用） */
  function returnedLeafIdsOfBatch(batchId: string): string[] {
    const set = new Set<string>()
    slipsOfBatch(batchId).forEach((s) => s.leafIds.forEach((id) => set.add(id)))
    return [...set]
  }

  /** 批次状态（含逾期派生） */
  function sendStatusOf(send: SendRegistration): SendStatus {
    return deriveSendStatus(send, returnedLeafIdsOfBatch(send.id), today.value)
  }

  /** 逾期批次：过了约定交期还没交回，书叶仍留在修复中 */
  const overdueSends = computed<SendRegistration[]>(() =>
    sendRegistrations.value.filter((s) => sendStatusOf(s) === 'overdue')
  )

  /** 对账不一致的回件单（等人认领） */
  const unmatchedSlips = computed<ReturnSlip[]>(() =>
    returnSlips.value.filter((s) => s.reconcileStatus === 'unmatched')
  )

  /** 对账：把批次两侧登记的叶号逐一比对 */
  function reconcileOfSend(send: SendRegistration): ReconcileDiff {
    return reconcileLeafIds(send.leafIds, returnedLeafIdsOfBatch(send.id))
  }

  /* ------------------------------ 载入 ------------------------------ */

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [w, s, r] = await Promise.all([
        db.workshops.toArray(),
        db.sendRegistrations.toArray(),
        db.returnSlips.toArray()
      ])
      w.sort((a, b) => b.updatedAt - a.updatedAt)
      s.sort((a, b) => b.updatedAt - a.updatedAt)
      r.sort((a, b) => b.updatedAt - a.updatedAt)
      workshops.value = w
      sendRegistrations.value = s
      returnSlips.value = r
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '馆外工坊数据读取失败'
    } finally {
      loading.value = false
    }
  }

  /* ------------------------------ 工坊 CRUD ------------------------------ */

  async function createWorkshop(draft: WorkshopDraft): Promise<Workshop> {
    const now = Date.now()
    const row: Workshop = { ...draft, id: createId('workshop'), createdAt: now, updatedAt: now }
    await db.workshops.put(row)
    await loadAll()
    return row
  }

  async function updateWorkshop(id: string, patch: Partial<Workshop>): Promise<void> {
    await db.workshops.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function removeWorkshop(id: string): Promise<void> {
    await db.workshops.delete(id)
    await loadAll()
  }

  /* ------------------------------ 送修登记（本室那本） ------------------------------ */

  async function createSendRegistration(draft: SendRegistrationDraft): Promise<SendRegistration> {
    const now = Date.now()
    const row: SendRegistration = { ...draft, id: createId('send'), createdAt: now, updatedAt: now }
    await db.sendRegistrations.put(row)
    await loadAll()
    return row
  }

  async function updateSendRegistration(id: string, patch: Partial<SendRegistration>): Promise<void> {
    await db.sendRegistrations.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function removeSendRegistration(id: string): Promise<void> {
    await db.sendRegistrations.delete(id)
    await loadAll()
  }

  /** 生成下一个批次号 */
  function nextBatchNo(): string {
    return generateBatchNo(sendRegistrations.value, new Date().getFullYear())
  }

  /* ------------------------------ 回件单（工坊那本） ------------------------------ */

  /**
   * 登记回件单。
   * 工坊那本的登记失败后按本侧重试一遍，本室那本照旧（不动送修登记）。
   * 登记成功后立即与本室送修登记逐一对账。
   */
  async function createReturnSlip(draft: ReturnSlipDraft): Promise<ReturnSlipResult> {
    const now = Date.now()
    let retried = false
    let slip: ReturnSlip

    try {
      slip = await putReturnSlip(draft, now)
    } catch {
      // 工坊那本登记失败 → 按本侧重试一遍：用本室送修登记补全工坊与叶号
      retried = true
      const enriched = enrichDraftFromSend(draft)
      slip = await putReturnSlip(enriched, now)
    }

    // 逐一对账
    const diff = reconcileSlip(slip)
    slip.reconcileStatus = diff.missing.length === 0 && diff.extra.length === 0 ? 'matched' : 'unmatched'
    slip.updatedAt = Date.now()
    await db.returnSlips.put(slip)
    await loadAll()

    return { slip, retried, diff }
  }

  async function putReturnSlip(draft: ReturnSlipDraft, now: number): Promise<ReturnSlip> {
    const row: ReturnSlip = {
      ...draft,
      id: createId('return'),
      reconcileStatus: 'pending',
      claimNote: '',
      claimedBy: '',
      claimedAt: null,
      createdAt: now,
      updatedAt: now
    }
    await db.returnSlips.put(row)
    return row
  }

  /** 按本室送修登记补全回件单草稿（工坊那本登记失败时重试使用） */
  function enrichDraftFromSend(draft: ReturnSlipDraft): ReturnSlipDraft {
    if (!draft.batchId) return draft
    const send = sendById(draft.batchId)
    if (!send) return draft
    return {
      ...draft,
      workshopId: draft.workshopId || send.workshopId,
      leafIds: draft.leafIds.length > 0 ? draft.leafIds : [...send.leafIds]
    }
  }

  /** 对账：回件单叶号 vs 本室送修登记叶号 */
  function reconcileSlip(slip: ReturnSlip): ReconcileDiff {
    if (!slip.batchId) {
      return { missing: [], extra: [...slip.leafIds], matched: [] }
    }
    const send = sendById(slip.batchId)
    if (!send) {
      return { missing: [], extra: [...slip.leafIds], matched: [] }
    }
    return reconcileLeafIds(send.leafIds, returnedLeafIdsOfBatch(slip.batchId))
  }

  /**
   * 补做送修登记（本室补做送修登记，不动工坊那本）。
   * 对不上的回件单（工坊交了但本室没登记），按工坊那本的叶号与工坊补一本送修登记；
   * 工坊那本照旧，不修改回件单内容。
   */
  async function makeupSendRegistration(slip: ReturnSlipDraft): Promise<SendRegistration> {
    const now = Date.now()
    const batchNo = nextBatchNo()
    const row: SendRegistration = {
      id: createId('send'),
      batchNo,
      workshopId: slip.workshopId,
      leafIds: [...slip.leafIds],
      sendDate: slip.returnDate,
      agreedReturnDate: new Date(new Date(slip.returnDate).getTime() + 30 * 86400000)
        .toISOString()
        .slice(0, 10),
      note: '按工坊回件单补做送修登记',
      createdAt: now,
      updatedAt: now
    }
    await db.sendRegistrations.put(row)
    await loadAll()
    return row
  }

  /** 认领：对不上的批次和叶号摆出来后，有人认领并记录 */
  async function claimSlip(slipId: string, claimNote: string, claimedBy: string): Promise<void> {
    const slip = slipById(slipId)
    if (!slip) return
    slip.reconcileStatus = 'claimed'
    slip.claimNote = claimNote
    slip.claimedBy = claimedBy
    slip.claimedAt = Date.now()
    slip.updatedAt = Date.now()
    await db.returnSlips.put(slip)
    await loadAll()
  }

  async function updateReturnSlip(id: string, patch: Partial<ReturnSlip>): Promise<void> {
    await db.returnSlips.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function removeReturnSlip(id: string): Promise<void> {
    await db.returnSlips.delete(id)
    await loadAll()
  }

  return {
    // state
    workshops,
    sendRegistrations,
    returnSlips,
    loading,
    ready,
    error,
    today,
    // derived
    overdueSends,
    unmatchedSlips,
    // queries
    workshopById,
    sendById,
    slipById,
    slipsOfBatch,
    returnedLeafIdsOfBatch,
    sendStatusOf,
    reconcileOfSend,
    // actions
    loadAll,
    createWorkshop,
    updateWorkshop,
    removeWorkshop,
    createSendRegistration,
    updateSendRegistration,
    removeSendRegistration,
    nextBatchNo,
    createReturnSlip,
    makeupSendRegistration,
    claimSlip,
    updateReturnSlip,
    removeReturnSlip
  }
})
