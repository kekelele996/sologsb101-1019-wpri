/**
 * 送修登记（SendRegistration）数据模型 —— 本室那本
 * 修复室做不完的册送去馆外工坊做整册托裱时，本室记的底账：
 * 送去哪几叶、交给哪家工坊、约定哪天交回。
 */

/** 批次状态：在修 / 已交回 / 逾期（逾期为派生状态，不落库） */
export type SendStatus = 'active' | 'returned' | 'overdue';

export interface SendRegistration {
  id: string;
  /** 批次号，如「SX-2026-001」 */
  batchNo: string;
  /** 承接工坊 id */
  workshopId: string;
  /** 送去哪几叶（书叶 id 列表） */
  leafIds: string[];
  /** 送修日期 yyyy-MM-dd */
  sendDate: string;
  /** 约定交回日期 yyyy-MM-dd */
  agreedReturnDate: string;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type SendRegistrationDraft = Omit<SendRegistration, 'id' | 'createdAt' | 'updatedAt'>;

export const SEND_STATUS_LABEL: Record<SendStatus, string> = {
  active: '在修',
  returned: '已交回',
  overdue: '逾期'
};

export const SEND_STATUS_COLOR: Record<SendStatus, string> = {
  active: '#d68910',
  returned: '#1e8449',
  overdue: '#b03a2e'
};

/**
 * 计算批次状态：
 * - 已交回：存在回件单且交回叶覆盖全部送修叶
 * - 逾期：过了约定交期仍未交回
 * - 在修：其余情况
 * 逾期不落库，由调用方结合回件单派生。
 */
export function deriveSendStatus(
  send: SendRegistration,
  returnedLeafIds: string[],
  today: string
): SendStatus {
  const sent = new Set(send.leafIds);
  const returned = new Set(returnedLeafIds);
  const allReturned = sent.size > 0 && [...sent].every((id) => returned.has(id));
  if (allReturned) return 'returned';
  if (send.agreedReturnDate < today) return 'overdue';
  return 'active';
}

/** 生成批次号：SX-yyyy-xxx */
export function generateBatchNo(existing: SendRegistration[], year: number): string {
  const prefix = `SX-${year}-`;
  let max = 0;
  existing.forEach((item) => {
    if (item.batchNo.startsWith(prefix)) {
      const num = Number.parseInt(item.batchNo.slice(prefix.length), 10);
      if (Number.isFinite(num) && num > max) max = num;
    }
  });
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

export function createEmptySendDraft(workshopId: string, batchNo: string): SendRegistrationDraft {
  const today = new Date().toISOString().slice(0, 10);
  const agreed = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  return {
    batchNo,
    workshopId,
    leafIds: [],
    sendDate: today,
    agreedReturnDate: agreed,
    note: ''
  };
}
