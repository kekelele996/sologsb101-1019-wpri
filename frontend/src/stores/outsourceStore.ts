/**
 * 馆外送修 store（Pinia setup store）
 * 本室送修登记与工坊回件单两边各记各的：
 * - 每批交回把两侧登记的叶号逐一对账，对不上的摆出来等人认领；
 *   认领只补本室送修登记，不动工坊那本。
 * - 工坊那本登记失败后按本侧重试，本室那本照旧。
 * - 过约定交期未交回标逾期提醒，书叶仍留在修复中。
 * 书叶在外标记（Leaf.outsource）随登记与对账同步；老档案只读记录永不改动。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import {
  isBatchOverdue,
  reconcileBatch,
  type BatchRecon,
  type OutsourceBatch,
  type OutsourceBatchDraft
} from '@/types/outsourceBatch'
import { validateSlipDraft, type ReturnSlip, type ReturnSlipDraft } from '@/types/returnSlip'
import type { Leaf } from '@/types/leaf'
import { useLeafStore } from './leafStore'

/** 待认领条目：对不上的批次与叶号 */
export interface ClaimEntry {
  batchId: string
  leafNo: number
}

const EMPTY_RECON: BatchRecon = { returnedLeafNos: [], missingLeafNos: [], extraLeafNos: [], state: 'out' }

export const useOutsourceStore = defineStore('outsource', () => {
  const batches = ref<OutsourceBatch[]>([])
  const slips = ref<ReturnSlip[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [batchRows, slipRows] = await Promise.all([db.outsourceBatches.toArray(), db.returnSlips.toArray()])
      batchRows.sort((a, b) => b.updatedAt - a.updatedAt)
      slipRows.sort((a, b) => b.updatedAt - a.updatedAt)
      batches.value = batchRows
      slips.value = slipRows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '送修登记读取失败'
    } finally {
      loading.value = false
    }
  }

  function batchById(id: string): OutsourceBatch | undefined {
    return batches.value.find((batch) => batch.id === id)
  }

  /** 仅登记成功的回件单参与对账 */
  function registeredSlipsOf(batchId: string): ReturnSlip[] {
    return slips.value.filter((slip) => slip.batchId === batchId && slip.registerState === 'registered')
  }

  function reconOf(batchId: string): BatchRecon {
    const batch = batchById(batchId)
    if (!batch) return EMPTY_RECON
    return reconcileBatch(batch, registeredSlipsOf(batchId))
  }

  /** 对不上的叶号：连批次一起摆出来等人认领 */
  const claims = computed<ClaimEntry[]>(() =>
    batches.value.flatMap((batch) =>
      reconcileBatch(batch, registeredSlipsOf(batch.id)).extraLeafNos.map((leafNo) => ({
        batchId: batch.id,
        leafNo
      }))
    )
  )

  const failedSlips = computed<ReturnSlip[]>(() => slips.value.filter((slip) => slip.registerState === 'failed'))

  const overdueBatchIds = computed<string[]>(() =>
    batches.value.filter((batch) => isBatchOverdue(batch, reconOf(batch.id))).map((batch) => batch.id)
  )

  /** 未结清批次数（导航徽标） */
  const openBatchCount = computed<number>(
    () => batches.value.filter((batch) => reconOf(batch.id).state !== 'returned').length
  )

  /**
   * 同步书叶在外标记：登记送出且未交回的打标（置修复中），交回或移出登记的清除；
   * 老档案只读记录与归属其他批次的标记一律不动。
   */
  async function syncBatchLeaves(batchId: string): Promise<void> {
    const batch = batchById(batchId)
    if (!batch) return
    const leafStore = useLeafStore()
    const returned = new Set(registeredSlipsOf(batchId).flatMap((slip) => slip.leafNos))
    const now = Date.now()
    const changed: Leaf[] = []
    leafStore.leaves.forEach((leaf) => {
      if (leaf.volumeId !== batch.volumeId) return
      const mark = leaf.outsource
      if (mark?.readonly) return
      const shouldMark = batch.leafNos.includes(leaf.leafNo) && !returned.has(leaf.leafNo)
      if (shouldMark) {
        if (mark) return
        changed.push({
          ...leaf,
          outsource: { workshop: batch.workshop, sentDate: batch.sentDate, batchId, readonly: false },
          state: leaf.state === 'pending' ? 'repairing' : leaf.state,
          updatedAt: now
        })
      } else if (mark && mark.batchId === batchId) {
        changed.push({ ...leaf, outsource: null, updatedAt: now })
      }
    })
    if (changed.length > 0) {
      await db.leaves.bulkPut(changed)
      await leafStore.loadLeaves()
    }
  }

  async function createBatch(draft: OutsourceBatchDraft): Promise<OutsourceBatch> {
    const now = Date.now()
    const row: OutsourceBatch = {
      ...draft,
      leafNos: [...draft.leafNos].sort((a, b) => a - b),
      id: createId('batch'),
      createdAt: now,
      updatedAt: now
    }
    await db.outsourceBatches.put(row)
    await loadAll()
    await syncBatchLeaves(row.id)
    return row
  }

  async function updateBatch(id: string, patch: Partial<OutsourceBatch>): Promise<void> {
    await db.outsourceBatches.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
    await syncBatchLeaves(id)
  }

  /** 删除本室登记：工坊回件单不动（两边各记各的），书叶在外标记解除 */
  async function removeBatch(id: string): Promise<void> {
    const leafStore = useLeafStore()
    const now = Date.now()
    const freed = leafStore.leaves
      .filter((leaf) => {
        const mark = leaf.outsource
        return mark != null && mark.batchId === id && !mark.readonly
      })
      .map((leaf) => ({ ...leaf, outsource: null, updatedAt: now }))
    await db.outsourceBatches.delete(id)
    if (freed.length > 0) await db.leaves.bulkPut(freed)
    await loadAll()
    if (freed.length > 0) await leafStore.loadLeaves()
  }

  /** 登记回件单（工坊那本）：校验失败留痕为登记失败，可补全后按本侧重试 */
  async function createSlip(draft: ReturnSlipDraft): Promise<{ slip: ReturnSlip; problem: string }> {
    const problem = validateSlipDraft(draft)
    const now = Date.now()
    const slip: ReturnSlip = {
      ...draft,
      leafNos: [...draft.leafNos].sort((a, b) => a - b),
      registerState: problem ? 'failed' : 'registered',
      id: createId('slip'),
      createdAt: now,
      updatedAt: now
    }
    await db.returnSlips.put(slip)
    await loadAll()
    if (slip.registerState === 'registered') await syncBatchLeaves(slip.batchId)
    return { slip, problem }
  }

  async function updateSlip(id: string, patch: Partial<ReturnSlipDraft>): Promise<void> {
    const slip = slips.value.find((item) => item.id === id)
    await db.returnSlips.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
    if (slip && slip.registerState === 'registered') await syncBatchLeaves(slip.batchId)
  }

  /** 工坊那本登记失败 → 按本侧重试一遍；本室送修登记照旧不动 */
  async function retrySlip(id: string): Promise<string> {
    const slip = slips.value.find((item) => item.id === id)
    if (!slip) return '回件单不存在'
    const problem = validateSlipDraft(slip)
    if (problem) return problem
    await db.returnSlips.update(id, { registerState: 'registered', updatedAt: Date.now() } as never)
    await loadAll()
    await syncBatchLeaves(slip.batchId)
    return ''
  }

  /** 删除回件单：已登记的删除后对应书叶重新计为在外 */
  async function removeSlip(id: string): Promise<void> {
    const slip = slips.value.find((item) => item.id === id)
    await db.returnSlips.delete(id)
    await loadAll()
    if (slip && slip.registerState === 'registered') await syncBatchLeaves(slip.batchId)
  }

  /** 认领对不上的叶号：本室补做送修登记（补记叶号），工坊回件单不动 */
  async function claimLeaf(batchId: string, leafNo: number): Promise<void> {
    const batch = batchById(batchId)
    if (!batch || batch.leafNos.includes(leafNo)) return
    await updateBatch(batchId, { leafNos: [...batch.leafNos, leafNo] })
  }

  return {
    batches,
    slips,
    loading,
    ready,
    error,
    claims,
    failedSlips,
    overdueBatchIds,
    openBatchCount,
    loadAll,
    batchById,
    registeredSlipsOf,
    reconOf,
    createBatch,
    updateBatch,
    removeBatch,
    createSlip,
    updateSlip,
    retrySlip,
    removeSlip,
    claimLeaf
  }
})
