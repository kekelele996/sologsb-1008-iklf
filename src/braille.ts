import { uid } from "./data";
import type {
  BrailleBlock,
  BrailleBook,
  BrailleDraft,
  PlateLayout,
  SignItem,
  SignProject,
  TactilePlate,
} from "./types";

/**
 * 盲文工艺固定参数（毫米）。
 * 触觉标牌的容量只由实测牌面尺寸决定：排版不缩点距，也不改动量好的尺寸。
 */
export const BRAILLE_METRICS = {
  dotPitchMm: 2.5, // 点距
  cellPitchMm: 6, // 方距（字距）
  linePitchMm: 10, // 行距
  marginMm: 10, // 牌面四周边距
} as const;

/** 回填旧稿时使用的默认牌面，标记为待实测 */
export const DEFAULT_PLATE_SIZE = { widthMm: 240, heightMm: 150 } as const;

const BLOCK_MAX_CHARS = 24;
const PLACEHOLDER_CELL = "⠿";

// 拉丁字母一级盲文（a–z）
const LETTER_CELLS = "⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵";
const CAPITAL_PREFIX = "⠠";
const NUMBER_PREFIX = "⠼";

const PUNCT_CELLS: Record<string, string> = {
  ",": "⠂",
  ";": "⠆",
  ":": "⠒",
  ".": "⠲",
  "!": "⠖",
  "?": "⠦",
  "'": "⠄",
  "’": "⠄",
  "-": "⠤",
  "–": "⠤",
  "—": "⠤",
  "(": "⠶",
  ")": "⠶",
  "/": "⠌",
  "&": "⠯",
  "·": "⠐",
};

const CJK_PATTERN = /[⺀-鿿぀-ヿ가-힯豈-﫿]/;

export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 译文修订号：目标语言或译文内容变化即改变，点字稿据此判断是否需退回重转 */
export function translationRev(sign: Pick<SignItem, "targetLanguage" | "targetText">): string {
  return hashText(`${sign.targetLanguage}\n${sign.targetText}`);
}

/** 非拉丁文字（汉字、假名、谚文）的示意点字；正式生产需接入对应语种的盲文表 */
function pseudoCells(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const low = (code % 255) + 1;
  const high = ((code >> 8) % 255) + 1;
  return String.fromCharCode(0x2800 + low, 0x2800 + high);
}

function letterCell(lower: string): string {
  return LETTER_CELLS[lower.charCodeAt(0) - 97];
}

function mapChar(char: string): string | null {
  if (char === " ") return "⠀";
  if (char >= "a" && char <= "z") return letterCell(char);
  if (char >= "A" && char <= "Z") return CAPITAL_PREFIX + letterCell(char.toLowerCase());
  const punct = PUNCT_CELLS[char];
  if (punct) return punct;
  // 重音拉丁字母按基础字母转写（示意）
  const base = char.normalize("NFD");
  if (base.length > 1 && base[0] >= "a" && base[0] <= "z") return letterCell(base[0]);
  if (base.length > 1 && base[0] >= "A" && base[0] <= "Z") {
    return CAPITAL_PREFIX + letterCell(base[0].toLowerCase());
  }
  if (CJK_PATTERN.test(char)) return pseudoCells(char);
  return null;
}

/**
 * 把一段译文转成点字。严格模式下遇到无法转写的字符即抛错（该块转写失败）；
 * 逐块重试时允许占位，无法转写的字符以 ⠿ 代替。
 */
export function transcribeText(
  text: string,
  allowPlaceholder: boolean,
): { cells: string; placeholders: number } {
  let cells = "";
  let placeholders = 0;
  let inNumber = false;
  for (const char of text) {
    if (char >= "0" && char <= "9") {
      cells += (inNumber ? "" : NUMBER_PREFIX) + LETTER_CELLS[char === "0" ? 9 : char.charCodeAt(0) - 49];
      inNumber = true;
      continue;
    }
    inNumber = false;
    const mapped = mapChar(char);
    if (mapped !== null) {
      cells += mapped;
      continue;
    }
    if (allowPlaceholder) {
      cells += PLACEHOLDER_CELL;
      placeholders += 1;
      continue;
    }
    const code = char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
    throw new Error(`字符「${char}」(U+${code}) 无法转写`);
  }
  return { cells, placeholders };
}

/** 译文按行与长度分成转写块，失败与重试都以块为单位 */
export function splitChunks(text: string): string[] {
  const chunks: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (let start = 0; start < trimmed.length; start += BLOCK_MAX_CHARS) {
      chunks.push(trimmed.slice(start, start + BLOCK_MAX_CHARS));
    }
  }
  return chunks.length ? chunks : [""];
}

/** 按当前译文转写一份新点字稿；有块失败时整侧挂起（suspended），等待逐块重试 */
export function transcribeSign(sign: SignItem): BrailleDraft {
  const blocks: BrailleBlock[] = splitChunks(sign.targetText).map((text, index) => {
    try {
      const { cells, placeholders } = transcribeText(text, false);
      return {
        id: uid("bb"),
        index,
        text,
        cells,
        status: "ok" as const,
        attempts: 1,
        placeholder: placeholders > 0,
      };
    } catch (error) {
      return {
        id: uid("bb"),
        index,
        text,
        cells: "",
        status: "failed" as const,
        attempts: 1,
        placeholder: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return {
    signId: sign.id,
    basedOnRev: translationRev(sign),
    basedOnText: sign.targetText,
    status: blocks.some((block) => block.status === "failed") ? "suspended" : "pending",
    blocks,
    updatedAt: new Date().toISOString(),
  };
}

/** 逐块重试：无法转写的字符以 ⠿ 占位；全部恢复后解除本侧挂起 */
export function retryBlock(draft: BrailleDraft, blockId: string): boolean {
  const block = draft.blocks.find((item) => item.id === blockId);
  if (!block || block.status !== "failed") return false;
  const { cells, placeholders } = transcribeText(block.text, true);
  block.cells = cells;
  block.status = "ok";
  block.placeholder = placeholders > 0;
  block.attempts += 1;
  delete block.error;
  if (draft.status === "suspended" && draft.blocks.every((item) => item.status === "ok")) {
    draft.status = "pending";
  }
  draft.updatedAt = new Date().toISOString();
  return true;
}

/** 译文改过就退回重转；已经装上牌子的照旧留着，不要求重转 */
export function isDraftStale(draft: BrailleDraft, sign: SignItem): boolean {
  return draft.status !== "installed" && draft.basedOnRev !== translationRev(sign);
}

/** 容量只按实测牌面尺寸与固定工艺参数推算 */
export function plateCapacity(widthMm: number, heightMm: number) {
  const columns = Math.max(
    0,
    Math.floor((widthMm - BRAILLE_METRICS.marginMm * 2) / BRAILLE_METRICS.cellPitchMm),
  );
  const rows = Math.max(
    0,
    Math.floor((heightMm - BRAILLE_METRICS.marginMm * 2) / BRAILLE_METRICS.linePitchMm),
  );
  return { columns, rows, capacityCells: columns * rows };
}

export function layoutSignature(blocks: BrailleBlock[], widthMm: number, heightMm: number): string {
  return hashText(`${widthMm}x${heightMm}|${blocks.map((block) => `${block.status}:${block.cells}`).join("|")}`);
}

/**
 * 按实测牌面尺寸排版：点距、行距固定，块顺序不变；
 * 放不下的块原样排队等重排，不缩点距也不动量好的尺寸。
 */
export function layoutPlate(blocks: BrailleBlock[], widthMm: number, heightMm: number): PlateLayout {
  const { columns, rows: rowCount, capacityCells } = plateCapacity(widthMm, heightMm);
  const queue: PlateLayout["queue"] = [];
  let placed = "";
  let used = 0;
  let overflowing = false;
  for (const block of blocks) {
    // 转写失败的块不参与排版，先在点字稿里逐块重试
    if (block.status !== "ok") continue;
    if (overflowing) {
      queue.push({ blockId: block.id, text: block.text, cells: block.cells });
      continue;
    }
    const separator = used > 0 ? 1 : 0;
    if (used + separator + block.cells.length > capacityCells) {
      overflowing = true;
      queue.push({ blockId: block.id, text: block.text, cells: block.cells });
      continue;
    }
    if (separator) placed += "⠀";
    placed += block.cells;
    used += separator + block.cells.length;
  }
  const rows: string[] = [];
  if (columns > 0) {
    for (let start = 0; start < placed.length; start += columns) {
      rows.push(placed.slice(start, start + columns));
    }
  }
  return {
    rows,
    queue,
    columns,
    rowCount,
    capacityCells,
    signature: layoutSignature(blocks, widthMm, heightMm),
    laidOutAt: new Date().toISOString(),
  };
}

export function createEmptyBook(): BrailleBook {
  return { schema: 1, drafts: {}, plates: {}, updatedAt: new Date().toISOString() };
}

export function createPlate(signId: string): TactilePlate {
  return {
    signId,
    measuredWidthMm: DEFAULT_PLATE_SIZE.widthMm,
    measuredHeightMm: DEFAULT_PLATE_SIZE.heightMm,
    layout: null,
    archives: [],
  };
}

/** 旧稿升级：没记点字的标识按当前译文回填一份待确认初稿，并配好默认牌面 */
export function ensureBrailleRecords(book: BrailleBook, project: SignProject): void {
  let changed = false;
  for (const sign of project.signs) {
    if (!book.drafts[sign.id]) {
      const draft = transcribeSign(sign);
      draft.backfilled = true;
      book.drafts[sign.id] = draft;
      changed = true;
    }
    if (!book.plates[sign.id]) {
      book.plates[sign.id] = createPlate(sign.id);
      changed = true;
    }
    const draft = book.drafts[sign.id];
    const plate = book.plates[sign.id];
    if (!plate.layout && draft.status !== "suspended") {
      plate.layout = layoutPlate(draft.blocks, plate.measuredWidthMm, plate.measuredHeightMm);
      changed = true;
    }
  }
  if (changed) book.updatedAt = new Date().toISOString();
}

/**
 * 读取服务方本地稿。数据缺失或损坏时回退为空稿并按译文回填，
 * 服务中心那份（SignProject）不受影响、照旧能看。
 */
export function parseBrailleBook(raw: string | null, project: SignProject): BrailleBook {
  let book: BrailleBook | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as BrailleBook;
      if (parsed && parsed.schema === 1 && parsed.drafts && parsed.plates) book = parsed;
    } catch {
      book = null;
    }
  }
  if (!book) book = createEmptyBook();
  for (const plate of Object.values(book.plates)) {
    plate.archives ??= [];
    plate.layout ??= null;
  }
  ensureBrailleRecords(book, project);
  return book;
}
