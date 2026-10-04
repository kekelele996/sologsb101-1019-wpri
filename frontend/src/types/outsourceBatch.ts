/**
 * 送修登记（OutsourceBatch）数据模型 —— 本室那本
 * 修复室做不完的册送去馆外修书工坊做整册托裱：
 * 登记送去哪几叶、交给哪家工坊、约定哪天交回。
 * 批次状态不落地，由本室登记叶号与工坊回件单逐叶对账后派生。
 */
import type { ReturnSlip } from './returnSlip';

/** 批次对账状态（派生）：在外 / 部分交回 / 已交回 */
export type OutsourceBatchState = 'out' | 'partial' | 'returned';

export interface OutsourceBatch {
  id: string;
  /** 所属册次 id */
  volumeId: string;
  /** 交给哪家工坊 */
  workshop: string;
  /** 送修日期 yyyy-MM-dd */
  sentDate: string;
  /** 约定交回日期 yyyy-MM-dd */
  dueDate: string;
  /** 登记送去的叶号 */
  leafNos: number[];
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type OutsourceBatchDraft = Omit<OutsourceBatch, 'id' | 'createdAt' | 'updatedAt'>;

/** 批次对账结果：本室登记与工坊回件单逐叶比对 */
export interface BatchRecon {
  /** 工坊已交回的叶号（仅统计登记成功的回件单） */
  returnedLeafNos: number[];
  /** 登记送出但尚未交回 */
  missingLeafNos: number[];
  /** 交回了但本室登记没送出：对不上，摆出来等人认领 */
  extraLeafNos: number[];
  /** 派生状态 */
  state: OutsourceBatchState;
}

export const OUTSOURCE_STATE_LABEL: Record<OutsourceBatchState, string> = {
  out: '在外',
  partial: '部分交回',
  returned: '已交回',
};

export const OUTSOURCE_STATE_COLOR: Record<OutsourceBatchState, string> = {
  out: '#3a6ea5',
  partial: '#d68910',
  returned: '#1e8449',
};

export const OUTSOURCE_STATE_OPTIONS: ReadonlyArray<{ value: OutsourceBatchState; label: string }> = [
  { value: 'out', label: '在外' },
  { value: 'partial', label: '部分交回' },
  { value: 'returned', label: '已交回' },
];

/** 馆外修书工坊候选（可自由录入新名字） */
export const WORKSHOP_OPTIONS: readonly string[] = [
  '文津阁装池坊',
  '松雪斋修复工坊',
  '古籀斋装池',
  '汲古阁裱背铺',
];

/** 本地日期 yyyy-MM-dd，与工序、装订记录的日期格式一致 */
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 逐叶对账：只统计登记成功的回件单；对不上的叶号进 extraLeafNos 等认领 */
export function reconcileBatch(batch: OutsourceBatch, registeredSlips: ReturnSlip[]): BatchRecon {
  const returnedLeafNos = Array.from(new Set(registeredSlips.flatMap((slip) => slip.leafNos))).sort((a, b) => a - b);
  const returnedSet = new Set(returnedLeafNos);
  const registeredSet = new Set(batch.leafNos);
  const missingLeafNos = batch.leafNos.filter((leafNo) => !returnedSet.has(leafNo)).sort((a, b) => a - b);
  const extraLeafNos = returnedLeafNos.filter((leafNo) => !registeredSet.has(leafNo));
  const hitCount = batch.leafNos.filter((leafNo) => returnedSet.has(leafNo)).length;
  const state: OutsourceBatchState =
    missingLeafNos.length === 0 && extraLeafNos.length === 0
      ? 'returned'
      : hitCount === 0 && extraLeafNos.length === 0
        ? 'out'
        : 'partial';
  return { returnedLeafNos, missingLeafNos, extraLeafNos, state };
}

/** 过了约定交期还没交回 → 逾期提醒（书叶仍留在修复中，不改书叶状态） */
export function isBatchOverdue(batch: OutsourceBatch, recon: BatchRecon, today: string = todayStr()): boolean {
  return recon.state !== 'returned' && batch.dueDate.length > 0 && batch.dueDate < today;
}

export function createEmptyBatchDraft(volumeId: string): OutsourceBatchDraft {
  return {
    volumeId,
    workshop: WORKSHOP_OPTIONS[0] as string,
    sentDate: todayStr(),
    dueDate: '',
    leafNos: [],
    note: '',
  };
}
