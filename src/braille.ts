import type { BrailleBlock, BrailleRecord, TactileSign } from "./types";
import { uid } from "./data";

/** 字符串指纹 (FNV-1a) — 用于记录点字稿照哪一版译文转的 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 去掉变音符号，便于映射到基础拉丁字母 */
function normalizeChar(char: string): string {
  return char.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** 基础拉丁字母点字 (uncontracted) */
const BRAILLE_CELLS: Record<string, string> = {
  a: "⠁", b: "⠃", c: "⠉", d: "⠙", e: "⠑", f: "⠋", g: "⠛", h: "⠓",
  i: "⠊", j: "⠚", k: "⠅", l: "⠇", m: "⠍", n: "⠝", o: "⠕", p: "⠏",
  q: "⠟", r: "⠗", s: "⠎", t: "⠞", u: "⠥", v: "⠧", w: "⠺", x: "⠭",
  y: "⠽", z: "⠵",
  "0": "⠴", "1": "⠂", "2": "⠆", "3": "⠒", "4": "⠲", "5": "⠢",
  "6": "⠖", "7": "⠶", "8": "⠦", "9": "⠔",
  ".": "⠲", ",": "⠂", "?": "⠢", "!": "⠖", "-": "⠤", "'": "⠄",
  '"': "⠐⠂", ";": "⠆", ":": "⠒", "(": "⠐⠣", ")": "⠐⠜", "/": "⠌",
  "&": "⠯",
};

export interface TranscribeResult {
  cells: string;
  cellCount: number;
  error?: string;
}

/**
 * 模拟点字转写。
 * 拉丁字母 (含常见变音符号)、数字、标点 → 点字格；
 * 空格 → 空点字格；换行 → 换行；
 * 其他字符 (中文、日文假名、谚文等) → 不支持，整块失败。
 */
export function transcribeText(text: string): TranscribeResult {
  const cells: string[] = [];
  const unsupported: string[] = [];
  for (const raw of text) {
    if (raw === "\n") {
      cells.push("\n");
      continue;
    }
    if (raw === " ") {
      cells.push("⠀");
      continue;
    }
    const normalized = normalizeChar(raw).toLowerCase();
    if (BRAILLE_CELLS[normalized]) {
      cells.push(BRAILLE_CELLS[normalized]);
    } else {
      unsupported.push(raw);
    }
  }
  if (unsupported.length) {
    const shown = [...new Set(unsupported)].slice(0, 6).join(" ");
    return { cells: "", cellCount: 0, error: `不支持的字符：${shown}` };
  }
  const cellCount = cells.filter((cell) => cell !== "\n").length;
  return { cells: cells.join(""), cellCount };
}

export function transcribeBlock(block: BrailleBlock): BrailleBlock {
  const result = transcribeText(block.sourceText);
  if (result.error) {
    return { ...block, status: "failed", error: result.error, brailleCells: "", cellCount: 0 };
  }
  return { ...block, status: "done", brailleCells: result.cells, cellCount: result.cellCount, error: undefined };
}

/** 按硬行切分块 — 每块独立转写、独立重试 */
export function splitIntoBlocks(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** 旧稿升级：按译文回填一份待确认的初稿 (未转写) */
export function backfillBraille(targetText: string, code: string): BrailleRecord {
  const blocks = splitIntoBlocks(targetText).map((sourceText, index) => ({
    id: uid("block"),
    index,
    sourceText,
    brailleCells: "",
    cellCount: 0,
    status: "pending" as const,
  }));
  const tactileSigns: TactileSign[] = [{
    id: uid("plate"),
    code,
    widthMm: 100,
    heightMm: 40,
    cellPitchMm: 2.5,
    linePitchMm: 10,
    marginMm: 5,
    installed: false,
    blockIds: [],
  }];
  return {
    status: "draft",
    sourceFingerprint: hashText(targetText),
    blocks,
    tactileSigns,
    queuedBlockIds: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 按实测牌面尺寸定容量 — 不缩点距、不动尺寸 */
export function signCapacity(sign: TactileSign) {
  const cellsPerLine = Math.max(1, Math.floor((sign.widthMm - 2 * sign.marginMm) / sign.cellPitchMm));
  const lines = Math.max(1, Math.floor((sign.heightMm - 2 * sign.marginMm) / sign.linePitchMm));
  return { cellsPerLine, lines, totalCells: cellsPerLine * lines };
}

/**
 * 重新排布：把块按顺序放到非上牌的标牌上。
 * 已上牌的标牌照旧留着 (块不重排)；放不下的块排队等重排。
 */
export function recomputeLayout(record: BrailleRecord): BrailleRecord {
  const installedBlockIds = new Set<string>();
  for (const sign of record.tactileSigns) {
    if (sign.installed) sign.blockIds.forEach((id) => installedBlockIds.add(id));
  }
  const remaining = record.blocks.filter((block) => !installedBlockIds.has(block.id));
  const nonInstalled = record.tactileSigns.filter((sign) => !sign.installed);
  const assignments = new Map<string, string[]>();
  const queued: string[] = [];
  let signIndex = 0;
  let usedCells = 0;
  for (const block of remaining) {
    if (block.status !== "done") {
      queued.push(block.id);
      continue;
    }
    let placed = false;
    while (signIndex < nonInstalled.length) {
      const sign = nonInstalled[signIndex];
      const { totalCells } = signCapacity(sign);
      if (usedCells + block.cellCount <= totalCells) {
        const list = assignments.get(sign.id) ?? [];
        list.push(block.id);
        assignments.set(sign.id, list);
        usedCells += block.cellCount;
        placed = true;
        break;
      }
      signIndex += 1;
      usedCells = 0;
    }
    if (!placed) queued.push(block.id);
  }
  for (const sign of record.tactileSigns) {
    if (!sign.installed) sign.blockIds = assignments.get(sign.id) ?? [];
  }
  return { ...record, queuedBlockIds: queued };
}

/** 译文改过 → 点字稿退回重转；已上牌的块不动 */
export function markStale(record: BrailleRecord): BrailleRecord {
  return { ...record, status: "stale", updatedAt: new Date().toISOString() };
}
