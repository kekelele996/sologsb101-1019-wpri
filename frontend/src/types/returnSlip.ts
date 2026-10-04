/**
 * 回件单（ReturnSlip）数据模型 —— 工坊那本
 * 工坊交回时登记：交回日期、实际交了哪几叶、返工说明。
 * 登记失败（信息不全）的记录留在工坊那本，按本侧重试；本室送修登记照旧不动。
 */

/** 工坊侧登记状态：已登记 / 登记失败 */
export type SlipRegisterState = 'registered' | 'failed';

export interface ReturnSlip {
  id: string;
  /** 归属送修批次 id（本室那本）；批次被删后仅作历史留痕 */
  batchId: string;
  /** 交回的工坊 */
  workshop: string;
  /** 交回日期 yyyy-MM-dd */
  returnDate: string;
  /** 实际交回的叶号 */
  leafNos: number[];
  /** 返工说明 */
  reworkNote: string;
  /** 工坊侧登记状态 */
  registerState: SlipRegisterState;
  createdAt: number;
  updatedAt: number;
}

export type ReturnSlipDraft = Omit<ReturnSlip, 'id' | 'createdAt' | 'updatedAt' | 'registerState'>;

export const SLIP_REGISTER_LABEL: Record<SlipRegisterState, string> = {
  registered: '已登记',
  failed: '登记失败',
};

export const SLIP_REGISTER_COLOR: Record<SlipRegisterState, string> = {
  registered: '#1e8449',
  failed: '#b03a2e',
};

/** 登记校验：通过返回空串，否则返回失败原因（留痕后可按本侧重试） */
export function validateSlipDraft(draft: ReturnSlipDraft): string {
  if (!draft.batchId) return '未选择归属批次';
  if (draft.workshop.trim().length === 0) return '未填写工坊';
  if (draft.returnDate.length === 0) return '未填写交回日期';
  if (draft.leafNos.length === 0) return '未登记交回叶号';
  if (draft.leafNos.some((leafNo) => !Number.isInteger(leafNo) || leafNo <= 0)) return '交回叶号必须是正整数';
  if (new Set(draft.leafNos).size !== draft.leafNos.length) return '交回叶号有重复';
  return '';
}

/** 解析叶号输入：「3, 8、12」→ [3, 8, 12]，非法片段丢弃后由校验兜底 */
export function parseLeafNos(text: string): number[] {
  return text
    .split(/[,，、;；\s]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece) => Number(piece))
    .filter((leafNo) => Number.isInteger(leafNo) && leafNo > 0);
}

export function createEmptySlipDraft(batchId: string, workshop: string): ReturnSlipDraft {
  return {
    batchId,
    workshop,
    returnDate: new Date().toISOString().slice(0, 10),
    leafNos: [],
    reworkNote: '',
  };
}
