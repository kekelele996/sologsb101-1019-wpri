/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方）
 * - 六张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table, type Transaction } from 'dexie'
import type { Book } from '@/types/book'
import type { Volume } from '@/types/volume'
import type { Leaf } from '@/types/leaf'
import { DEFAULT_DYE_RECIPE, type Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import type { Workshop } from '@/types/workshop'
import type { SendRegistration } from '@/types/sendRegistration'
import type { ReturnSlip } from '@/types/returnSlip'

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbbookrestore'

/** 当前数据结构版本号 */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbbookrestore:db-version',
  lastBackupAt: 'gbbookrestore:last-backup-at',
  uiPrefs: 'gbbookrestore:ui-prefs'
} as const

export interface UiPrefs {
  lastBookId: string | null
  lastVolumeId: string | null
  repairSort: 'manual' | 'leaf'
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBookId: null, lastVolumeId: null, repairSort: 'manual' }

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastBookId: typeof parsed.lastBookId === 'string' ? parsed.lastBookId : null,
      lastVolumeId: typeof parsed.lastVolumeId === 'string' ? parsed.lastVolumeId : null,
      repairSort: parsed.repairSort === 'leaf' ? 'leaf' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value)
  } catch {
    /* ignore */
  }
}

export class BookRestoreDatabase extends Dexie {
  books!: Table<Book, string>
  volumes!: Table<Volume, string>
  leaves!: Table<Leaf, string>
  papers!: Table<Paper, string>
  repairOrders!: Table<RepairOrder, string>
  bindings!: Table<Binding, string>
  workshops!: Table<Workshop, string>
  sendRegistrations!: Table<SendRegistration, string>
  returnSlips!: Table<ReturnSlip, string>

  constructor() {
    super(DB_NAME)
    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      books: 'id, title, era, level, updatedAt',
      volumes: 'id, bookId, volumeNo, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
      papers: 'id, leafId, paperType, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, state, updatedAt',
      bindings: 'id, volumeId, verdict, finishDate, updatedAt'
    })
    // v2：Paper 增加 dyeRecipe 字段，按纸种为历史记录回填默认配方
    this.version(2)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (!paper.dyeRecipe || paper.dyeRecipe.length === 0) {
              paper.dyeRecipe = DEFAULT_DYE_RECIPE[paper.paperType] ?? DEFAULT_DYE_RECIPE.bamboo
            }
            if (typeof paper.deltaE !== 'number') paper.deltaE = 2
            if (typeof paper.thicknessMm !== 'number') paper.thicknessMm = 0.06
          })
      })
    // v3：新增馆外工坊、送修登记、回件单三张表；
    // 老档案里在外的叶没有批次归属，升级时按送修日期和工坊回填，补不上的只读留着。
    this.version(3)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, readOnly, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt',
        workshops: 'id, name, updatedAt',
        sendRegistrations: 'id, batchNo, workshopId, sendDate, agreedReturnDate, updatedAt',
        returnSlips: 'id, batchId, workshopId, returnDate, reconcileStatus, updatedAt'
      })
      .upgrade(async (tx) => {
        await backfillOutsideLeaves(tx)
      })
  }
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/**
 * v2→v3 升级迁移：回填在外叶的批次归属。
 * 老档案里在外的叶（state=repairing）没有批次归属，
 * 升级时按送修日期（leaf.updatedAt）和工坊回填到送修登记；
 * 补不上的（日期非法等）标记 readOnly 只读留着，不可编辑。
 */
export async function backfillOutsideLeaves(tx: Transaction): Promise<void> {
  const leafTable = tx.table<Leaf>('leaves')
  const workshopTable = tx.table<Workshop>('workshops')
  const sendTable = tx.table<SendRegistration>('sendRegistrations')

  // 确保有一个默认工坊可挂
  let workshop = await workshopTable.orderBy('updatedAt').first()
  if (!workshop) {
    workshop = {
      id: createId('workshop'),
      name: '苏州古籍修复工坊',
      contact: '',
      note: 'v3 升级时为在外叶回填批次而建',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await workshopTable.put(workshop)
  }

  const leaves = await leafTable.toArray()
  let batchCounter = 1
  const now = Date.now()

  for (const leaf of leaves) {
    // 只处理在外（修复中）且未标记只读的叶
    if (leaf.state !== 'repairing' || leaf.readOnly) continue

    // 送修日期取叶的最近更新时间；非法则补不上，只读留着
    const sendDate = new Date(leaf.updatedAt)
    if (Number.isNaN(sendDate.getTime())) {
      await leafTable.update(leaf.id, { readOnly: true, updatedAt: now })
      continue
    }
    const sendDateStr = sendDate.toISOString().slice(0, 10)

    // 按送修日期 + 工坊匹配已有批次，匹配到就补进去
    const existing = await sendTable
      .where('workshopId')
      .equals(workshop.id)
      .and((s: SendRegistration) => s.sendDate === sendDateStr)
      .first()

    if (existing) {
      if (!existing.leafIds.includes(leaf.id)) {
        existing.leafIds.push(leaf.id)
        existing.updatedAt = now
        await sendTable.put(existing)
      }
    } else {
      // 匹配不到就新建一条送修登记（回填）
      const agreed = new Date(sendDate.getTime() + 30 * 86400000).toISOString().slice(0, 10)
      await sendTable.put({
        id: createId('send'),
        batchNo: `SX-${sendDate.getFullYear()}-${String(batchCounter).padStart(3, '0')}`,
        workshopId: workshop.id,
        leafIds: [leaf.id],
        sendDate: sendDateStr,
        agreedReturnDate: agreed,
        note: 'v3 升级回填',
        createdAt: now,
        updatedAt: now
      })
      batchCounter += 1
    }
  }
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open()
  stampDbVersion()
  if ((await db.books.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Book → Volume → Leaf →（Paper / RepairOrder）＋ Volume → Binding */

export async function seedDatabase(): Promise<void> {
  const now = Date.now()
  const day = 86400000

  const books: Book[] = [
    {
      id: 'book_01',
      title: '昌黎先生集',
      edition: '明万历刻本',
      era: '明',
      volumeCount: 2,
      collectionNo: 'GJ-0017',
      level: 'first',
      createdAt: now - day * 40,
      updatedAt: now - day * 3
    },
    {
      id: 'book_02',
      title: '梦溪笔谈',
      edition: '清乾隆写刻',
      era: '清',
      volumeCount: 1,
      collectionNo: 'GJ-0042',
      level: 'second',
      createdAt: now - day * 32,
      updatedAt: now - day * 2
    },
    {
      id: 'book_03',
      title: '重刊巢氏诸病源候总论',
      edition: '元至正刻本（残）',
      era: '元',
      volumeCount: 1,
      collectionNo: 'GJ-0008',
      level: 'first',
      createdAt: now - day * 60,
      updatedAt: now - day * 5
    }
  ]

  const volumes: Volume[] = [
    { id: 'vol_0101', bookId: 'book_01', volumeNo: 1, leafCount: 24, bindingType: 'thread', state: 'repairing', createdAt: now - day * 38, updatedAt: now - day * 3 },
    { id: 'vol_0102', bookId: 'book_01', volumeNo: 2, leafCount: 18, bindingType: 'wrapped', state: 'pending', createdAt: now - day * 38, updatedAt: now - day * 6 },
    { id: 'vol_0201', bookId: 'book_02', volumeNo: 1, leafCount: 30, bindingType: 'thread', state: 'archived', createdAt: now - day * 30, updatedAt: now - day * 2 },
    { id: 'vol_0301', bookId: 'book_03', volumeNo: 1, leafCount: 12, bindingType: 'butterfly', state: 'archived', createdAt: now - day * 55, updatedAt: now - day * 5 }
  ]

  const leaves: Leaf[] = [
    { id: 'leaf_010101', volumeId: 'vol_0101', leafNo: 3, damageType: 'worm', damageAreaCm2: 6.5, phValue: 6.4, state: 'repairing', readOnly: false, createdAt: now - day * 20, updatedAt: now - day * 3 },
    { id: 'leaf_010102', volumeId: 'vol_0101', leafNo: 8, damageType: 'acid', damageAreaCm2: 12.2, phValue: 5.1, state: 'pending', readOnly: false, createdAt: now - day * 20, updatedAt: now - day * 4 },
    { id: 'leaf_010103', volumeId: 'vol_0101', leafNo: 8, damageType: 'stain', damageAreaCm2: 4.8, phValue: 6.1, state: 'pending', readOnly: false, createdAt: now - day * 19, updatedAt: now - day * 4 },
    { id: 'leaf_010104', volumeId: 'vol_0101', leafNo: 12, damageType: 'worm', damageAreaCm2: 3.2, phValue: 6.0, state: 'repairing', readOnly: true, createdAt: now - day * 40, updatedAt: now - day * 35 },
    { id: 'leaf_010201', volumeId: 'vol_0102', leafNo: 2, damageType: 'loss', damageAreaCm2: 9.4, phValue: 6.7, state: 'pending', readOnly: false, createdAt: now - day * 18, updatedAt: now - day * 6 },
    { id: 'leaf_020101', volumeId: 'vol_0201', leafNo: 5, damageType: 'fibrin', damageAreaCm2: 15.6, phValue: 6.9, state: 'repaired', readOnly: false, createdAt: now - day * 25, updatedAt: now - day * 2 },
    { id: 'leaf_020102', volumeId: 'vol_0201', leafNo: 11, damageType: 'worm', damageAreaCm2: 7.2, phValue: 6.6, state: 'repaired', readOnly: false, createdAt: now - day * 24, updatedAt: now - day * 3 },
    { id: 'leaf_030101', volumeId: 'vol_0301', leafNo: 1, damageType: 'acid', damageAreaCm2: 20.5, phValue: 4.8, state: 'repaired', readOnly: false, createdAt: now - day * 50, updatedAt: now - day * 5 },
    { id: 'leaf_030102', volumeId: 'vol_0301', leafNo: 6, damageType: 'loss', damageAreaCm2: 11.1, phValue: 5.6, state: 'repaired', readOnly: false, createdAt: now - day * 49, updatedAt: now - day * 6 }
  ]

  const papers: Paper[] = [
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 45, updatedAt: now - day * 45 }
  ]

  const repairOrders: RepairOrder[] = [
    { id: 'order_010101', leafId: 'leaf_010101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '沈玉', date: '2026-03-04', state: 'done', createdAt: now - day * 16, updatedAt: now - day * 14 },
    { id: 'order_010102', leafId: 'leaf_010101', seq: 2, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-03-06', state: 'doing', createdAt: now - day * 15, updatedAt: now - day * 3 },
    { id: 'order_010103', leafId: 'leaf_010101', seq: 3, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-03-09', state: 'todo', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'order_010201', leafId: 'leaf_010201', seq: 1, name: 'mend', material: '补纸 0.05mm + 小麦淀粉糊', operator: '陆敏', date: '2026-03-08', state: 'todo', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'order_020101', leafId: 'leaf_020101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '陆敏', date: '2026-02-26', state: 'done', createdAt: now - day * 22, updatedAt: now - day * 20 },
    { id: 'order_020102', leafId: 'leaf_020101', seq: 2, name: 'corner', material: '溜口纸条 + 稠浆糊', operator: '陆敏', date: '2026-02-28', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 19 },
    { id: 'order_020103', leafId: 'leaf_020101', seq: 3, name: 'trim', material: '裁板 + 竹起子', operator: '陆敏', date: '2026-03-01', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 18 },
    { id: 'order_020104', leafId: 'leaf_020101', seq: 4, name: 'press', material: '压书板 + 宣纸吸水层', operator: '陆敏', date: '2026-03-02', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 17 },
    { id: 'order_030101', leafId: 'leaf_030101', seq: 1, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-02-12', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 38 },
    { id: 'order_030102', leafId: 'leaf_030101', seq: 2, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-02-15', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 36 }
  ]

  const bindings: Binding[] = [
    { id: 'bind_0201', volumeId: 'vol_0201', method: '六眼线装', finishDate: '2026-03-03', verdict: 'pass', inspector: '程砚', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'bind_0301', volumeId: 'vol_0301', method: '蝴蝶装复原', finishDate: '2026-02-18', verdict: 'pass', inspector: '程砚', createdAt: now - day * 8, updatedAt: now - day * 5 },
    { id: 'bind_0101', volumeId: 'vol_0101', method: '四眼线装', finishDate: '2026-03-10', verdict: 'rework', inspector: '程砚', createdAt: now - day * 2, updatedAt: now - day * 2 }
  ]

  /* 馆外工坊：本室做不完的册送去做整册托裱，两边各记各的 */
  const workshops: Workshop[] = [
    { id: 'workshop_01', name: '苏州古籍修复工坊', contact: '苏州市姑苏区 · 顾师傅', note: '擅长整册托裱与金镶玉装', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'workshop_02', name: '扬州修书坊', contact: '扬州市广陵区 · 方师傅', note: '擅长蝴蝶装与包背装复原', createdAt: now - day * 25, updatedAt: now - day * 25 }
  ]

  /* 送修登记（本室那本）：送去哪几叶、交给哪家工坊、约定哪天交回 */
  const sendRegistrations: SendRegistration[] = [
    {
      id: 'send_01',
      batchNo: 'SX-2026-001',
      workshopId: 'workshop_01',
      leafIds: ['leaf_010101'],
      sendDate: new Date(now - day * 15).toISOString().slice(0, 10),
      agreedReturnDate: new Date(now + day * 15).toISOString().slice(0, 10),
      note: '整册托裱，虫蛀叶需补破后托裱',
      createdAt: now - day * 15,
      updatedAt: now - day * 15
    },
    {
      id: 'send_02',
      batchNo: 'SX-2026-002',
      workshopId: 'workshop_02',
      leafIds: ['leaf_010102', 'leaf_010103'],
      sendDate: new Date(now - day * 45).toISOString().slice(0, 10),
      agreedReturnDate: new Date(now - day * 5).toISOString().slice(0, 10),
      note: '酸化叶托裱，已过约定交期',
      createdAt: now - day * 45,
      updatedAt: now - day * 45
    },
    {
      id: 'send_03',
      batchNo: 'SX-2026-003',
      workshopId: 'workshop_01',
      leafIds: ['leaf_010201'],
      sendDate: new Date(now - day * 20).toISOString().slice(0, 10),
      agreedReturnDate: new Date(now - day * 2).toISOString().slice(0, 10),
      note: '缺肉叶补破托裱，已交回',
      createdAt: now - day * 20,
      updatedAt: now - day * 20
    }
  ]

  /* 回件单（工坊那本）：交回日期、实际交了哪几叶、返工说明 */
  const returnSlips: ReturnSlip[] = [
    {
      id: 'return_01',
      batchId: 'send_03',
      workshopId: 'workshop_01',
      returnDate: new Date(now - day * 2).toISOString().slice(0, 10),
      leafIds: ['leaf_010201'],
      reworkNote: '补破处已托裱，待本室验收',
      reconcileStatus: 'matched',
      claimNote: '',
      claimedBy: '',
      claimedAt: null,
      createdAt: now - day * 2,
      updatedAt: now - day * 2
    }
  ]

  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.workshops, db.sendRegistrations, db.returnSlips],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
      await db.workshops.bulkPut(workshops)
      await db.sendRegistrations.bulkPut(sendRegistrations)
      await db.returnSlips.bulkPut(returnSlips)
    }
  )
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RestoreSnapshot {
  app: typeof DB_NAME
  schemaVersion: number
  exportedAt: string
  books: Book[]
  volumes: Volume[]
  leaves: Leaf[]
  papers: Paper[]
  repairOrders: RepairOrder[]
  bindings: Binding[]
  workshops: Workshop[]
  sendRegistrations: SendRegistration[]
  returnSlips: ReturnSlip[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, repairOrders, bindings, workshops, sendRegistrations, returnSlips] =
    await Promise.all([
      db.books.toArray(),
      db.volumes.toArray(),
      db.leaves.toArray(),
      db.papers.toArray(),
      db.repairOrders.toArray(),
      db.bindings.toArray(),
      db.workshops.toArray(),
      db.sendRegistrations.toArray(),
      db.returnSlips.toArray()
    ])
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    volumes,
    leaves,
    papers,
    repairOrders,
    bindings,
    workshops,
    sendRegistrations,
    returnSlips
  }
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot>
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`
  const keys: Array<keyof RestoreSnapshot> = [
    'books',
    'volumes',
    'leaves',
    'papers',
    'repairOrders',
    'bindings',
    'workshops',
    'sendRegistrations',
    'returnSlips'
  ]
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`
  }
  return ''
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.workshops, db.sendRegistrations, db.returnSlips],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.workshops.clear(),
        db.sendRegistrations.clear(),
        db.returnSlips.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.volumes.bulkPut(snapshot.volumes)
      await db.leaves.bulkPut(snapshot.leaves)
      await db.papers.bulkPut(snapshot.papers)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
      await db.workshops.bulkPut(snapshot.workshops ?? [])
      await db.sendRegistrations.bulkPut(snapshot.sendRegistrations ?? [])
      await db.returnSlips.bulkPut(snapshot.returnSlips ?? [])
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.workshops, db.sendRegistrations, db.returnSlips],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.workshops.clear(),
        db.sendRegistrations.clear(),
        db.returnSlips.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, repairOrders, bindings, workshops, sendRegistrations, returnSlips] =
    await Promise.all([
      db.books.count(),
      db.volumes.count(),
      db.leaves.count(),
      db.papers.count(),
      db.repairOrders.count(),
      db.bindings.count(),
      db.workshops.count(),
      db.sendRegistrations.count(),
      db.returnSlips.count()
    ])
  return { books, volumes, leaves, papers, repairOrders, bindings, workshops, sendRegistrations, returnSlips }
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订 / 送修登记 / 回件单 */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.volumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.sendRegistrations, db.returnSlips],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
        await cleanupWorkshopRecords(leafIds)
      }
      if (volumeIds.length > 0) {
        await db.leaves.where('volumeId').anyOf(volumeIds).delete()
        await db.bindings.where('volumeId').anyOf(volumeIds).delete()
      }
      await db.volumes.where('bookId').equals(bookId).delete()
      await db.books.delete(bookId)
    }
  )
}

/** 级联删除册次 → 书叶 → 补纸 / 工序 / 装订 / 送修登记 / 回件单 */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  await db.transaction(
    'rw',
    [db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.sendRegistrations, db.returnSlips],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
        await cleanupWorkshopRecords(leafIds)
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.volumes.delete(volumeId)
    }
  )
}

/** 从送修登记与回件单中移除指定书叶的引用（级联删除时清理孤儿引用） */
async function cleanupWorkshopRecords(leafIds: string[]): Promise<void> {
  const idSet = new Set(leafIds)
  const now = Date.now()
  const sends = await db.sendRegistrations.toArray()
  for (const send of sends) {
    const next = send.leafIds.filter((id) => !idSet.has(id))
    if (next.length !== send.leafIds.length) {
      send.leafIds = next
      send.updatedAt = now
      await db.sendRegistrations.put(send)
    }
  }
  const slips = await db.returnSlips.toArray()
  for (const slip of slips) {
    const next = slip.leafIds.filter((id) => !idSet.has(id))
    if (next.length !== slip.leafIds.length) {
      slip.leafIds = next
      slip.updatedAt = now
      await db.returnSlips.put(slip)
    }
  }
}

/** 级联删除书叶 → 补纸 / 工序 / 送修登记 / 回件单 */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.leaves, db.papers, db.repairOrders, db.sendRegistrations, db.returnSlips],
    async () => {
      await db.papers.where('leafId').equals(leafId).delete()
      await db.repairOrders.where('leafId').equals(leafId).delete()
      // 从送修登记的 leafIds 中移除该书叶
      const sends = await db.sendRegistrations.toArray()
      for (const send of sends) {
        if (send.leafIds.includes(leafId)) {
          send.leafIds = send.leafIds.filter((id) => id !== leafId)
          send.updatedAt = Date.now()
          await db.sendRegistrations.put(send)
        }
      }
      // 从回件单的 leafIds 中移除该书叶
      const slips = await db.returnSlips.toArray()
      for (const slip of slips) {
        if (slip.leafIds.includes(leafId)) {
          slip.leafIds = slip.leafIds.filter((id) => id !== leafId)
          slip.updatedAt = Date.now()
          await db.returnSlips.put(slip)
        }
      }
      await db.leaves.delete(leafId)
    }
  )
}
