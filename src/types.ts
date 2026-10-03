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

// ---- 无障碍版本：盲文服务方独立维护的数据 ----
// 服务中心的 SignProject 记中文原文与译文；以下类型是服务方自己的本地稿，
// 记点字稿与触觉标牌，两边分开保存、分头维护，互不相同步覆盖。

export type BrailleBlockStatus = "ok" | "failed";

export interface BrailleBlock {
  id: string;
  index: number;
  /** 转写依据的译文片段 */
  text: string;
  /** 点字（Unicode 盲文图案），转写失败时为空 */
  cells: string;
  status: BrailleBlockStatus;
  attempts: number;
  /** 重试时对无法转写的字符使用了 ⠿ 占位 */
  placeholder: boolean;
  error?: string;
}

export type BrailleDraftStatus = "pending" | "confirmed" | "installed" | "suspended";

export interface BrailleDraft {
  signId: string;
  /** 照哪一版译文转的（译文修订号），译文改过即据此退回重转 */
  basedOnRev: string;
  /** 转写时的译文快照，便于对照变更 */
  basedOnText: string;
  status: BrailleDraftStatus;
  /** 旧稿升级时按译文回填的待确认初稿 */
  backfilled?: boolean;
  blocks: BrailleBlock[];
  updatedAt: string;
  confirmedAt?: string;
  installedAt?: string;
}

export interface PlateQueueItem {
  blockId: string;
  text: string;
  cells: string;
}

export interface PlateLayout {
  /** 按实测牌面尺寸排出的点字行 */
  rows: string[];
  /** 放不下的块，按原顺序排队等重排 */
  queue: PlateQueueItem[];
  columns: number;
  rowCount: number;
  capacityCells: number;
  /** 排版依据（尺寸 + 点字块）签名，变化后提示重排 */
  signature: string;
  laidOutAt: string;
}

export interface PlateArchive {
  rev: string;
  installedAt: string;
  layout: PlateLayout;
}

export interface TactilePlate {
  signId: string;
  /** 实测牌面尺寸（毫米），排版只读取、绝不改动 */
  measuredWidthMm: number;
  measuredHeightMm: number;
  /** 未实测前为默认牌面尺寸 */
  measuredAt?: string;
  layout: PlateLayout | null;
  installedAt?: string;
  /** 换下来的已装牌子照旧保留 */
  archives: PlateArchive[];
}

export interface BrailleBook {
  schema: 1;
  drafts: Record<string, BrailleDraft>;
  plates: Record<string, TactilePlate>;
  updatedAt: string;
}
