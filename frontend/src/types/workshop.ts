/**
 * 馆外工坊（Workshop）数据模型
 * 承接修复室整册托裱需求的馆外修书工坊；两边各记各的，工坊是本室送修登记的对手方。
 */

export interface Workshop {
  id: string;
  /** 工坊名称，如「苏州古籍修复工坊」 */
  name: string;
  /** 联系方式 */
  contact: string;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type WorkshopDraft = Omit<Workshop, 'id' | 'createdAt' | 'updatedAt'>;

export function createEmptyWorkshopDraft(): WorkshopDraft {
  return {
    name: '',
    contact: '',
    note: ''
  };
}
