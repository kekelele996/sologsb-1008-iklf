export type ReviewStatus = "draft" | "pending" | "confirmed" | "changes";

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface TermBinding {
  id: string;
  source: string;
  target: string;
  required: boolean;
  confirmed: boolean;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sourceText: string;
  targetText: string;
  status: ReviewStatus;
  terms: TermBinding[];
}

// === 盲文服务方 (Braille Service Provider) ===

export type BrailleBlockStatus = "pending" | "done" | "failed";

export interface BrailleBlock {
  id: string;
  index: number;
  /** 该块对应的译文片段 */
  sourceText: string;
  /** 转写后的点字 (unicode braille cells) */
  brailleCells: string;
  /** 点字格数 */
  cellCount: number;
  status: BrailleBlockStatus;
  error?: string;
}

export type BrailleRecordStatus = "draft" | "transcribed" | "stale" | "failed";

export interface TactileSign {
  id: string;
  /** 牌面编号 */
  code: string;
  /** 实测牌面宽度 (mm) */
  widthMm: number;
  /** 实测牌面高度 (mm) */
  heightMm: number;
  /** 实测点距 (mm) — 不可缩 */
  cellPitchMm: number;
  /** 实测行距 (mm) */
  linePitchMm: number;
  /** 实测边距 (mm) */
  marginMm: number;
  /** 已装上牌 — 译文改动后照旧留着 */
  installed: boolean;
  /** 上牌时快照的点字排布 (格) — 重转后照旧显示 */
  snapshotCells?: string[];
  /** 排布在该牌上的块 (按顺序) */
  blockIds: string[];
}

export interface BrailleRecord {
  status: BrailleRecordStatus;
  /** 照哪一版译文转的 (targetText 指纹) */
  sourceFingerprint: string;
  blocks: BrailleBlock[];
  tactileSigns: TactileSign[];
  /** 放不下、排队等重排的块 */
  queuedBlockIds: string[];
  updatedAt: string;
}

export interface SignItem {
  id: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  terms: TermBinding[];
  comments: ReviewComment[];
  versions: VersionSnapshot[];
  emergencyRevision: boolean;
  /** 盲文服务方持有的点字稿与触觉标牌 */
  braille?: BrailleRecord;
  updatedAt: string;
}

export interface SignProject {
  id: string;
  title: string;
  location: string;
  activeSignId: string;
  signs: SignItem[];
  updatedAt: string;
}

export interface PersistedProject {
  schema: 1;
  project: SignProject;
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
