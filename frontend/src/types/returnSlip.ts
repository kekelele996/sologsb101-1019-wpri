/**
 * 回件单（ReturnSlip）数据模型 —— 工坊那本
 * 工坊交回书叶时记的回件单：交回日期、实际交了哪几叶、返工说明。
 * 每批交回时与本室送修登记逐一对账；对不上就把批次和叶号摆出来等人认领。
 */

/** 对账状态：待对账 / 一致 / 不一致（认领后标记已认领） */
export type ReconcileStatus = 'pending' | 'matched' | 'unmatched' | 'claimed';

export interface ReturnSlip {
  id: string;
  /** 关联送修批次 id；补做或老档案可能为空 */
  batchId: string | null;
  /** 工坊 id */
  workshopId: string;
  /** 交回日期 yyyy-MM-dd */
  returnDate: string;
  /** 实际交了哪几叶（书叶 id 列表） */
  leafIds: string[];
  /** 返工说明 */
  reworkNote: string;
  /** 对账状态 */
  reconcileStatus: ReconcileStatus;
  /** 认领说明（对不上时等人认领后填写） */
  claimNote: string;
  /** 认领人 */
  claimedBy: string;
  /** 认领时间 */
  claimedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ReturnSlipDraft = Omit<
  ReturnSlip,
  'id' | 'reconcileStatus' | 'claimNote' | 'claimedBy' | 'claimedAt' | 'createdAt' | 'updatedAt'
>;

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  pending: '待对账',
  matched: '一致',
  unmatched: '不一致',
  claimed: '已认领'
};

export const RECONCILE_STATUS_COLOR: Record<ReconcileStatus, string> = {
  pending: '#8c8c8c',
  matched: '#1e8449',
  unmatched: '#b03a2e',
  claimed: '#3a6ea5'
};

/** 对账结果：两侧叶号逐一比对后的差异 */
export interface ReconcileDiff {
  /** 本室登记送出但工坊未交回的叶号 */
  missing: string[];
  /** 工坊交回但本室未登记送出的叶号 */
  extra: string[];
  /** 两侧都有的叶号 */
  matched: string[];
}

/**
 * 逐一对账：把本室送修登记的叶号与工坊回件单的叶号做差集。
 * 对不上就把批次和叶号摆出来等人认领。
 */
export function reconcileLeafIds(sentLeafIds: string[], returnedLeafIds: string[]): ReconcileDiff {
  const sent = new Set(sentLeafIds);
  const returned = new Set(returnedLeafIds);
  const missing = sentLeafIds.filter((id) => !returned.has(id));
  const extra = returnedLeafIds.filter((id) => !sent.has(id));
  const matched = sentLeafIds.filter((id) => returned.has(id));
  return { missing, extra, matched };
}

export function createEmptyReturnDraft(
  workshopId: string,
  batchId: string | null,
  leafIds: string[]
): ReturnSlipDraft {
  return {
    batchId,
    workshopId,
    returnDate: new Date().toISOString().slice(0, 10),
    leafIds,
    reworkNote: ''
  };
}
