import { $, component$, useSignal, useVisibleTask$, type QRL } from "@builder.io/qwik";
import { type DocumentHead } from "@builder.io/qwik-city";
import { createSeedProject, STATUS_LABELS, uid } from "../data";
import type { BrailleRecordStatus, BrailleBlock, ReviewStatus, SignItem, SignProject, TactileSign } from "../types";
import { analyzeSign, cloneTerms, diffText } from "../utils";
import {
  backfillBraille,
  hashText,
  markStale,
  recomputeLayout,
  signCapacity,
  transcribeBlock,
} from "../braille";

const STORAGE_KEY = "sologsb-1008-project-v1";
const WIDTHS = [320, 480, 720, 960] as const;

const BRAILLE_STATUS_LABELS: Record<BrailleRecordStatus, string> = {
  draft: "待确认初稿",
  transcribed: "已转写",
  stale: "译文已改·待重转",
  failed: "转写失败·已挂起",
};

function brailleStatusClass(status: BrailleRecordStatus | undefined) {
  if (!status) return "badge-neutral";
  if (status === "transcribed") return "badge-success";
  if (status === "failed") return "badge-error";
  if (status === "stale") return "badge-warning";
  return "badge-neutral";
}

/** 点字字符 → 6 点排布 (2列×3行) */
function brailleDots(char: string): boolean[] {
  const code = char.charCodeAt(0) - 0x2800;
  return [
    (code & 0x01) !== 0,
    (code & 0x02) !== 0,
    (code & 0x04) !== 0,
    (code & 0x08) !== 0,
    (code & 0x10) !== 0,
    (code & 0x20) !== 0,
  ];
}

export const head: DocumentHead = {
  title: "公共标识多语言校对台",
  meta: [
    { name: "description", content: "公共标识译文、术语、版本和版面风险校对工作台" },
  ],
};

function statusClass(status: ReviewStatus) {
  if (status === "confirmed") return "badge-success";
  if (status === "changes") return "badge-error";
  if (status === "pending") return "badge-warning";
  return "badge-neutral";
}

export default component$(() => {
  const project = useSignal<SignProject>(createSeedProject());
  const past = useSignal<SignProject[]>([]);
  const future = useSignal<SignProject[]>([]);
  const hydrated = useSignal(false);
  const online = useSignal(true);
  const previewWidth = useSignal(480);
  const previewFont = useSignal(42);
  const selectedVersionId = useSignal("");
  const termSource = useSignal("");
  const termTarget = useSignal("");
  const commentDraft = useSignal("");
  const replyDraft = useSignal("");
  const replyingTo = useSignal("");
  const toast = useSignal("");
  const previewId = useSignal("");
  const readOnly = useSignal(false);
  const mode = useSignal<"center" | "braille">("center");
  const previewPlateId = useSignal("");
  const active = () => project.value.signs.find((sign) => sign.id === (previewId.value || project.value.activeSignId)) ?? project.value.signs[0];
  const brailleRecord = () => active().braille;

  const commit = $((label: string, update: (draft: SignProject) => void) => {
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = [];
    const draft = structuredClone(project.value);
    update(draft);
    draft.updatedAt = new Date().toISOString();
    project.value = draft;
  });

  const updateActive = $((label: string, update: (sign: SignItem, draft: SignProject) => void) => {
    commit(label, (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (sign) update(sign, draft);
    });
  });

  const undo = $(() => {
    if (!past.value.length) return;
    const previous = past.value.at(-1)!;
    future.value = [structuredClone(project.value), ...future.value].slice(0, 50);
    past.value = past.value.slice(0, -1);
    project.value = previous;
    toast.value = "已撤销";
  });

  const redo = $(() => {
    if (!future.value.length) return;
    const next = future.value[0];
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = future.value.slice(1);
    project.value = next;
    toast.value = "已重做";
  });

  const navigateSign = $((direction: 1 | -1) => {
    if (readOnly.value) return;
    const signs = project.value.signs;
    const index = Math.max(0, signs.findIndex((sign) => sign.id === project.value.activeSignId));
    const next = signs[(index + direction + signs.length) % signs.length];
    commit("切换标识", (draft) => { draft.activeSignId = next.id; });
    selectedVersionId.value = "";
    previewPlateId.value = "";
  });

  const setStatus = $((status: ReviewStatus) => {
    commit("更新审校状态", (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!sign) return;
      if (sign.emergencyRevision && status === "confirmed") {
        sign.status = "pending";
      } else {
        sign.status = status;
      }
    });
  });

  const toggleEmergency = $(() => {
    commit("切换紧急修订", (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!sign) return;
      sign.emergencyRevision = !sign.emergencyRevision;
      if (sign.emergencyRevision) sign.status = "changes";
    });
  });

  const saveVersion = $(() => {
    const sign = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (!sign) return;
    const versionId = uid("version");
    commit("保存版本快照", (draft) => {
      const current = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!current) return;
      current.versions.unshift({
        id: versionId,
        label: `版本 ${current.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        sourceText: current.sourceText,
        targetText: current.targetText,
        status: current.status,
        terms: cloneTerms(current.terms),
      });
      current.versions = current.versions.slice(0, 12);
    });
    selectedVersionId.value = versionId;
    toast.value = "版本快照已保存";
  });

  const addTerm = $(() => {
    const source = termSource.value.trim();
    const target = termTarget.value.trim();
    if (!source || !target) return;
    updateActive("绑定术语", (sign) => {
      sign.terms.push({ id: uid("term"), source, target, required: true, confirmed: false });
      sign.status = "pending";
    });
    termSource.value = "";
    termTarget.value = "";
  });

  const addComment = $(() => {
    const body = commentDraft.value.trim();
    if (!body) return;
    updateActive("添加审校意见", (sign) => {
      sign.comments.unshift({
        id: uid("comment"),
        author: "当前审校员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      sign.status = sign.status === "confirmed" ? "changes" : sign.status;
    });
    commentDraft.value = "";
  });

  const addReply = $((commentId: string) => {
    const body = replyDraft.value.trim();
    if (!body) return;
    updateActive("回复审校意见", (sign) => {
      const comment = sign.comments.find((item) => item.id === commentId);
      comment?.replies.push({ id: uid("reply"), author: "当前审校员", body, createdAt: new Date().toISOString() });
    });
    replyDraft.value = "";
    replyingTo.value = "";
  });

  const sharePreview: QRL<() => void> = $(() => {
    const current = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (!current) return;
    const url = `${window.location.origin}${window.location.pathname}?preview=${encodeURIComponent(current.id)}`;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    toast.value = "只读预览链接已复制";
  });

  const preview = () => analyzeSign(active(), previewWidth.value, previewFont.value);
  const selectedVersion = () => active().versions.find((version) => version.id === selectedVersionId.value) ?? active().versions[0];
  const comparison = () => {
    const version = selectedVersion();
    return version ? diffText(version.targetText, active().targetText) : [];
  };

  // === 盲文服务方动作 ===

  const transcribeAll = $(() => {
    updateActive("转写点字", (sign) => {
      if (!sign.braille) return;
      sign.braille.blocks = sign.braille.blocks.map(transcribeBlock);
      const anyFailed = sign.braille.blocks.some((block) => block.status === "failed");
      sign.braille.status = anyFailed ? "failed" : "transcribed";
      sign.braille.sourceFingerprint = hashText(sign.targetText);
      sign.braille.updatedAt = new Date().toISOString();
      recomputeLayout(sign.braille);
    });
  });

  const retryBlock = $((blockId: string) => {
    updateActive("重试点字块", (sign) => {
      if (!sign.braille) return;
      const block = sign.braille.blocks.find((item) => item.id === blockId);
      if (block) Object.assign(block, transcribeBlock(block));
      const anyFailed = sign.braille.blocks.some((item) => item.status === "failed");
      const allDone = sign.braille.blocks.every((item) => item.status === "done");
      sign.braille.status = anyFailed ? "failed" : allDone ? "transcribed" : sign.braille.status;
      sign.braille.sourceFingerprint = hashText(sign.targetText);
      recomputeLayout(sign.braille);
    });
  });

  const addTactileSign = $(() => {
    updateActive("新增触觉标牌", (sign) => {
      if (!sign.braille) return;
      sign.braille.tactileSigns.push({
        id: uid("plate"),
        code: `${sign.code}-${sign.braille.tactileSigns.length + 1}`,
        widthMm: 100,
        heightMm: 40,
        cellPitchMm: 2.5,
        linePitchMm: 10,
        marginMm: 5,
        installed: false,
        blockIds: [],
      });
      recomputeLayout(sign.braille);
    });
  });

  const updateSignDimensions = $((signId: string, field: "widthMm" | "heightMm" | "cellPitchMm" | "linePitchMm" | "marginMm", value: number) => {
    updateActive("调整标牌尺寸", (sign) => {
      if (!sign.braille) return;
      const plate = sign.braille.tactileSigns.find((item) => item.id === signId);
      if (plate) {
        plate[field] = value;
        recomputeLayout(sign.braille);
      }
    });
  });

  const toggleInstalled = $((signId: string) => {
    updateActive("切换上牌状态", (sign) => {
      if (!sign.braille) return;
      const plate = sign.braille.tactileSigns.find((item) => item.id === signId);
      if (plate) {
        plate.installed = !plate.installed;
        if (plate.installed) {
          // 上牌时快照当前点字排布 — 重转后照旧显示
          const cells: string[] = [];
          for (const blockId of plate.blockIds) {
            const block = sign.braille.blocks.find((item) => item.id === blockId);
            if (block) cells.push(...block.brailleCells.split(""));
          }
          plate.snapshotCells = cells;
        } else {
          plate.snapshotCells = undefined;
        }
        recomputeLayout(sign.braille);
      }
    });
  });

  const relayout = $(() => {
    updateActive("重新排布", (sign) => {
      if (!sign.braille) return;
      recomputeLayout(sign.braille);
    });
  });

  const regenerateDraft = $(() => {
    updateActive("重新生成初稿", (sign) => {
      if (!sign.braille) return;
      const signs = sign.braille.tactileSigns;
      sign.braille = backfillBraille(sign.targetText, sign.code);
      sign.braille.tactileSigns = signs;
    });
  });

  /** 当前选中标牌上排布的点字格 (按顺序)；已上牌的用快照 */
  const plateCells = (plate: TactileSign) => {
    if (plate.installed && plate.snapshotCells) return [...plate.snapshotCells];
    const cells: string[] = [];
    const braille = active().braille;
    if (!braille) return cells;
    for (const blockId of plate.blockIds) {
      const block = braille.blocks.find((item) => item.id === blockId);
      if (block) cells.push(...block.brailleCells.split(""));
    }
    return cells;
  };

  useVisibleTask$(({ track }) => {
    track(() => hydrated.value);
    if (!hydrated.value) {
      try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as { schema: number; project: SignProject };
        if (stored.schema === 1 && stored.project?.signs?.length) {
          // 升级：旧稿没记点字，按译文回填一份待确认的初稿
          stored.project.signs = stored.project.signs.map((sign) =>
            sign.braille ? sign : { ...sign, braille: backfillBraille(sign.targetText, sign.code) },
          );
          project.value = stored.project;
        }
        const requestedPreview = new URLSearchParams(window.location.search).get("preview") ?? "";
        previewId.value = requestedPreview;
        readOnly.value = Boolean(requestedPreview);
      } catch {
        // Keep bundled sample data when storage is unavailable or malformed.
      }
      hydrated.value = true;
    }
  });

  useVisibleTask$(({ track, cleanup }) => {
    track(() => hydrated.value);
    if (!hydrated.value) return;
    track(() => project.value);
    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 1, project: project.value }));
    }, 450);
    cleanup(() => window.clearTimeout(timer));
  });

  useVisibleTask$(({ cleanup }) => {
    const updateOnline = () => { online.value = navigator.onLine; };
    updateOnline();
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? undo() : undo();
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        navigateSign(1);
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigateSign(-1);
      } else if (event.key === "[") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.max(0, index - 1)];
      } else if (event.key === "]") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.min(WIDTHS.length - 1, index + 1)];
      } else if (event.key === "-") {
        previewFont.value = Math.max(28, previewFont.value - 4);
      } else if (event.key === "=") {
        previewFont.value = Math.min(88, previewFont.value + 4);
      }
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("keydown", keydown);
    cleanup(() => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("keydown", keydown);
    });
  });

  if (readOnly.value) {
    const sign = active();
    const analysis = analyzeSign(sign, previewWidth.value, previewFont.value);
    return (
      <main data-theme="corporate" class="min-h-screen bg-slate-100 p-6">
        <div class="mx-auto max-w-5xl">
          <div class="mb-4 flex items-center justify-between">
            <div>
              <div class="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Read-only preview</div>
              <h1 class="text-2xl font-bold text-slate-800">{sign.code} · {sign.scenario}</h1>
            </div>
            <span class={`badge ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
          </div>
          <section class="rounded-3xl bg-white p-14 shadow-xl">
            <div class="mb-3 text-center text-xs text-slate-400">中文原文</div>
            <p class="mx-auto mb-10 max-w-2xl text-center text-lg text-slate-600">{sign.sourceText}</p>
            <div class="mx-auto border-y-4 border-slate-800 py-10 text-center">
              <p class="whitespace-pre-line font-black leading-tight tracking-wide text-slate-900" style={{ fontSize: `${previewFont.value}px` }}>{analysis.visible.join("\n")}</p>
            </div>
            <div class="mt-5 text-center text-sm text-slate-500">{sign.targetLanguage} · {sign.regulation}</div>
          </section>
          <p class="mt-4 text-center text-xs text-slate-400">此链接读取当前浏览器中的本地版本，仅用于演示只读预览。</p>
        </div>
      </main>
    );
  }

  return (
    <div data-theme="corporate" class="min-h-screen bg-slate-100 pb-9 text-slate-800">
      <header class="navbar sticky top-0 z-40 min-h-16 border-b border-slate-700 bg-[#17324d] px-5 text-white shadow-lg">
        <div class="navbar-start gap-3">
          <div class="grid h-10 w-10 place-items-center rounded-xl border border-white/20 bg-white/10 font-black">译</div>
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-sky-200">Public Sign Review</div>
            <div class="font-bold">公共标识多语言校对台</div>
          </div>
          <div class="join ml-4">
            <button
              class={`btn btn-sm join-item ${mode.value === "center" ? "btn-primary" : "btn-outline border-white/20 bg-white/10 text-white hover:bg-white/20"}`}
              onClick$={() => { mode.value = "center"; }}
            >语言服务中心</button>
            <button
              class={`btn btn-sm join-item ${mode.value === "braille" ? "btn-primary" : "btn-outline border-white/20 bg-white/10 text-white hover:bg-white/20"}`}
              onClick$={() => { mode.value = "braille"; }}
            >盲文服务方</button>
          </div>
        </div>
        <div class="navbar-center hidden xl:flex">
          <input
            class="input input-sm w-80 border-white/15 bg-white/10 text-white placeholder:text-slate-300"
            value={project.value.title}
            onInput$={(_, element) => commit("修改项目名称", (draft) => { draft.title = element.value; })}
            aria-label="项目名称"
          />
        </div>
        <div class="navbar-end gap-2">
          <span class={`badge ${online.value ? "badge-success" : "badge-warning"} badge-outline`}>{online.value ? "在线" : "离线草稿"}</span>
          <button class="btn btn-ghost btn-sm" disabled={!past.value.length} onClick$={undo}>撤销</button>
          <button class="btn btn-ghost btn-sm" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="btn btn-sm border-white/20 bg-white/10 text-white hover:bg-white/20" onClick$={sharePreview}>复制只读链接</button>
          <button class={`btn btn-sm ${active().emergencyRevision ? "btn-error" : "btn-warning"}`} onClick$={toggleEmergency}>
            {active().emergencyRevision ? "退出紧急修订" : "紧急修订"}
          </button>
        </div>
      </header>

      {active().emergencyRevision && (
        <div class="alert alert-error sticky top-16 z-30 rounded-none border-x-0 py-2 text-white">
          <span class="text-lg">!</span>
          <span><strong>紧急修订模式</strong>：确认操作已锁定，修改后必须重新审校并保存版本。</span>
        </div>
      )}

      <div class="grid min-h-[calc(100vh-64px)] grid-cols-[270px_minmax(560px,1fr)_430px] gap-px bg-slate-300">
        <aside class="overflow-y-auto bg-slate-50 p-3">
          <div class="mb-3 rounded-xl bg-white p-4 shadow-sm">
            <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">标识清单</div>
            <div class="mt-1 text-lg font-bold text-slate-800">{project.value.signs.length} 处标识</div>
            <p class="mt-1 text-xs leading-5 text-slate-500">{project.value.location}</p>
          </div>
          <div class="space-y-2">
            {project.value.signs.map((sign, index) => {
              const risk = analyzeSign(sign, previewWidth.value, previewFont.value);
              return (
                <button
                  key={sign.id}
                  class={`w-full rounded-xl border p-3 text-left transition ${sign.id === project.value.activeSignId ? "border-blue-400 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"}`}
                  onClick$={() => {
                    commit("切换标识", (draft) => { draft.activeSignId = sign.id; });
                    selectedVersionId.value = "";
                    previewPlateId.value = "";
                  }}
                >
                  <div class="flex items-center justify-between">
                    <span class="font-mono text-xs font-bold text-slate-500">{sign.code}</span>
                    <span class={`badge badge-sm ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
                  </div>
                  <div class="mt-2 line-clamp-2 text-sm font-semibold text-slate-700">{sign.sourceText}</div>
                  <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                    <span>{sign.targetLanguage}</span>
                    <span class={risk.risk === "high" ? "font-bold text-error" : risk.risk === "medium" ? "font-bold text-warning" : "text-success"}>
                      {risk.risk === "high" ? "高风险" : risk.risk === "medium" ? "需留意" : "版面正常"}
                    </span>
                  </div>
                  {sign.braille && (
                    <div class="mt-1 flex items-center justify-between">
                      <span class={`badge badge-sm ${brailleStatusClass(sign.braille.status)}`}>{BRAILLE_STATUS_LABELS[sign.braille.status]}</span>
                      {sign.braille.queuedBlockIds.length > 0 && (
                        <span class="text-[11px] font-bold text-warning">{sign.braille.queuedBlockIds.length} 块排队</span>
                      )}
                    </div>
                  )}
                  <span class="sr-only">第 {index + 1} 条</span>
                </button>
              );
            })}
          </div>
        </aside>

        {mode.value === "braille" ? (
          <main class="min-w-0 bg-white">
            <div class="border-b border-slate-200 bg-slate-50 px-6 py-4">
              <div class="flex items-start justify-between gap-5">
                <div>
                  <div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">{active().code} · {active().scenario}</div>
                  <h1 class="mt-1 text-xl font-bold">盲文点字稿与触觉标牌</h1>
                </div>
                <span class={`badge ${brailleStatusClass(brailleRecord()?.status)}`}>
                  {brailleRecord() ? BRAILLE_STATUS_LABELS[brailleRecord()!.status] : "无点字稿"}
                </span>
              </div>
            </div>

            <div class="space-y-5 p-6">
              {brailleRecord()?.status === "stale" && (
                <div class="alert alert-warning py-2 text-sm">
                  <span><strong>译文已更新</strong>：点字稿照的是上一版译文，已退回重转。已上牌的标牌照旧留着，不受影响。</span>
                </div>
              )}
              {brailleRecord()?.status === "failed" && (
                <div class="alert alert-error py-2 text-sm">
                  <span><strong>转写失败</strong>：已挂起盲文侧，逐块重试即可。语言服务中心的译文与术语照旧能看、能改。</span>
                </div>
              )}

              {/* 点字稿 */}
              <section class="card border border-slate-200 bg-white shadow-sm">
                <div class="card-body gap-4 p-5">
                  <div class="flex items-center justify-between">
                    <div>
                      <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Braille Transcript</div>
                      <h2 class="font-bold">点字稿</h2>
                      <p class="text-xs text-slate-500">
                        {active().braille?.status === "draft"
                          ? "升级回填的待确认初稿，确认后可转写。"
                          : `照译文指纹 ${active().braille?.sourceFingerprint} 转写。`}
                      </p>
                    </div>
                    <div class="flex gap-2">
                      {active().braille?.status === "draft" && (
                        <button class="btn btn-sm btn-outline" onClick$={regenerateDraft}>重新生成初稿</button>
                      )}
                      <button class="btn btn-sm btn-primary" onClick$={transcribeAll}>
                        {active().braille?.status === "stale" ? "重新转写" : "转写全部"}
                      </button>
                    </div>
                  </div>
                  <div class="space-y-2">
                    {active().braille?.blocks.map((block) => (
                      <div key={block.id} class={`rounded-lg border p-3 ${block.status === "failed" ? "border-error bg-error/5" : block.status === "done" ? "border-slate-200" : "border-dashed border-slate-300"}`}>
                        <div class="flex items-center justify-between gap-2">
                          <span class="font-mono text-xs font-bold text-slate-400">#{block.index + 1}</span>
                          <div class="flex items-center gap-2">
                            {block.status === "done" && <span class="text-[11px] text-slate-400">{block.cellCount} 格</span>}
                            {block.status === "pending" && <span class="badge badge-sm badge-ghost">待转写</span>}
                            {block.status === "failed" && <span class="badge badge-sm badge-error">失败</span>}
                            {block.status === "failed" && (
                              <button class="btn btn-xs btn-outline" onClick$={() => retryBlock(block.id)}>重试</button>
                            )}
                          </div>
                        </div>
                        <div class="mt-1 text-sm text-slate-600">{block.sourceText}</div>
                        {block.status === "done" && (
                          <div class="mt-2 break-all font-mono text-lg leading-relaxed tracking-wider text-slate-800">{block.brailleCells}</div>
                        )}
                        {block.status === "failed" && (
                          <div class="mt-1 text-xs text-error">{block.error}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              {/* 触觉标牌 */}
              <section class="card border border-slate-200 bg-white shadow-sm">
                <div class="card-body gap-4 p-5">
                  <div class="flex items-center justify-between">
                    <div>
                      <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Tactile Signs</div>
                      <h2 class="font-bold">触觉标牌</h2>
                      <p class="text-xs text-slate-500">按实测牌面尺寸定容量，放不下的排队等重排；不缩点距，不动尺寸。</p>
                    </div>
                    <button class="btn btn-sm btn-outline" onClick$={addTactileSign}>新增标牌</button>
                  </div>
                  <div class="space-y-3">
                    {active().braille?.tactileSigns.map((plate) => {
                      const capacity = signCapacity(plate);
                      const overflow = plate.blockIds.reduce((sum, id) => {
                        const block = active().braille?.blocks.find((item) => item.id === id);
                        return sum + (block?.cellCount ?? 0);
                      }, 0);
                      return (
                        <div key={plate.id} class={`rounded-lg border p-3 ${plate.installed ? "border-success bg-success/5" : "border-slate-200"}`}>
                          <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2">
                              <span class="font-mono text-sm font-bold">{plate.code}</span>
                              {plate.installed && <span class="badge badge-sm badge-success">已装上牌</span>}
                            </div>
                            <button class="btn btn-xs btn-outline" onClick$={() => toggleInstalled(plate.id)}>
                              {plate.installed ? "拆下牌" : "标记已上牌"}
                            </button>
                          </div>
                          <div class="mt-2 grid grid-cols-5 gap-2 text-xs">
                            <label class="form-control">
                              <span class="label-text text-[10px] text-slate-400">宽 mm</span>
                              <input type="number" class="input input-xs input-bordered" value={plate.widthMm}
                                onInput$={(_, el) => updateSignDimensions(plate.id, "widthMm", Number(el.value))} />
                            </label>
                            <label class="form-control">
                              <span class="label-text text-[10px] text-slate-400">高 mm</span>
                              <input type="number" class="input input-xs input-bordered" value={plate.heightMm}
                                onInput$={(_, el) => updateSignDimensions(plate.id, "heightMm", Number(el.value))} />
                            </label>
                            <label class="form-control">
                              <span class="label-text text-[10px] text-slate-400">点距 mm</span>
                              <input type="number" step="0.1" class="input input-xs input-bordered" value={plate.cellPitchMm}
                                onInput$={(_, el) => updateSignDimensions(plate.id, "cellPitchMm", Number(el.value))} />
                            </label>
                            <label class="form-control">
                              <span class="label-text text-[10px] text-slate-400">行距 mm</span>
                              <input type="number" class="input input-xs input-bordered" value={plate.linePitchMm}
                                onInput$={(_, el) => updateSignDimensions(plate.id, "linePitchMm", Number(el.value))} />
                            </label>
                            <label class="form-control">
                              <span class="label-text text-[10px] text-slate-400">边距 mm</span>
                              <input type="number" class="input input-xs input-bordered" value={plate.marginMm}
                                onInput$={(_, el) => updateSignDimensions(plate.id, "marginMm", Number(el.value))} />
                            </label>
                          </div>
                          <div class="mt-2 flex items-center justify-between text-xs text-slate-500">
                            <span>容量 {capacity.totalCells} 格 ({capacity.cellsPerLine}×{capacity.lines})</span>
                            <span>已排 {plate.blockIds.length} 块 · {overflow} 格</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* 排队等重排 */}
                  <div class="rounded-lg border border-dashed border-warning bg-warning/5 p-3">
                    <div class="flex items-center justify-between">
                      <h3 class="text-sm font-bold text-warning">排队等重排</h3>
                      <button class="btn btn-xs btn-outline" onClick$={relayout}>重新排布</button>
                    </div>
                    {(brailleRecord()?.queuedBlockIds.length ?? 0) > 0 ? (
                      <div class="mt-2 space-y-1">
                        {brailleRecord()!.queuedBlockIds.map((blockId) => {
                          const block = brailleRecord()?.blocks.find((item) => item.id === blockId);
                          if (!block) return null;
                          return (
                            <div key={blockId} class="flex items-center justify-between text-xs">
                              <span class="text-slate-600">#{block.index + 1} {block.sourceText}</span>
                              <span class="text-slate-400">{block.status === "done" ? `${block.cellCount} 格` : block.status === "failed" ? "失败" : "待转写"}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div class="mt-1 text-xs text-slate-400">暂无排队的块。放不下的块会留在这里，等加牌或调尺寸后重排。</div>
                    )}
                  </div>
                </div>
              </section>
            </div>
          </main>
        ) : (
          <main class="min-w-0 bg-white">
          <div class="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <div class="flex items-start justify-between gap-5">
              <div>
                <div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">{active().code} · {active().scenario}</div>
                <h1 class="mt-1 text-xl font-bold">中文原文与译文校对</h1>
              </div>
              <div class="join">
                {(["draft", "pending", "changes", "confirmed"] as ReviewStatus[]).map((status) => (
                  <button key={status} class={`btn join-item btn-sm ${active().status === status ? "btn-primary" : "btn-outline"}`} onClick$={() => setStatus(status)}>{STATUS_LABELS[status]}</button>
                ))}
              </div>
            </div>
          </div>

          <div class="space-y-5 p-6">
            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body gap-4 p-5">
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Source</div><h2 class="font-bold">中文原文</h2></div>
                  <span class="badge badge-ghost">简体中文</span>
                </div>
                <textarea
                  class="textarea textarea-bordered min-h-24 w-full text-base leading-7"
                  value={active().sourceText}
                  onInput$={(_, element) => updateActive("修改中文原文", (sign) => { sign.sourceText = element.value; sign.status = "draft"; })}
                />
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body gap-4 p-5">
                <div class="grid grid-cols-2 gap-4">
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">目标语言</span>
                    <select class="select select-bordered" value={active().targetLanguage} onChange$={(_, element) => updateActive("修改目标语言", (sign) => { sign.targetLanguage = element.value; sign.status = "pending"; })}>
                      {["English", "日本語", "Français", "Deutsch", "한국어", "Español"].map((language) => <option key={language}>{language}</option>)}
                    </select>
                  </label>
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">适用场景</span>
                    <input class="input input-bordered" value={active().scenario} onInput$={(_, element) => updateActive("修改适用场景", (sign) => { sign.scenario = element.value; })} />
                  </label>
                </div>
                <label class="form-control">
                  <span class="label-text mb-1 text-xs font-bold text-slate-500">法规或规范提示</span>
                  <input class="input input-bordered" value={active().regulation} onInput$={(_, element) => updateActive("修改法规提示", (sign) => { sign.regulation = element.value; })} />
                </label>
                <div class="divider my-0"></div>
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-500">Target</div><h2 class="font-bold">目标语言译文</h2></div>
                  <button class="btn btn-sm btn-outline" onClick$={saveVersion}>保存版本快照</button>
                </div>
                <textarea
                  class="textarea textarea-bordered min-h-36 w-full text-lg leading-8"
                  value={active().targetText}
                  onInput$={(_, element) => updateActive("修改译文", (sign) => {
                    sign.targetText = element.value;
                    sign.status = sign.emergencyRevision ? "changes" : "pending";
                    // 译文改过 → 点字稿退回重转；已上牌的块不动
                    if (sign.braille) {
                      if (sign.braille.status === "draft") {
                        const signs = sign.braille.tactileSigns;
                        sign.braille = backfillBraille(sign.targetText, sign.code);
                        sign.braille.tactileSigns = signs;
                      } else {
                        sign.braille = markStale(sign.braille);
                      }
                      recomputeLayout(sign.braille);
                    }
                  })}
                />
                <div class="flex flex-wrap gap-2">
                  {active().terms.map((term) => {
                    const matched = active().targetText.toLocaleLowerCase().includes(term.target.toLocaleLowerCase());
                    return (
                      <button
                        key={term.id}
                        title="点击切换术语确认状态"
                        class={`badge badge-lg gap-1 ${matched && term.confirmed ? "badge-success" : matched ? "badge-warning" : "badge-error"}`}
                        onClick$={() => updateActive("确认术语", (sign) => {
                          const current = sign.terms.find((item) => item.id === term.id);
                          if (current) current.confirmed = !current.confirmed;
                        })}
                      >
                        {term.source} → {term.target} {matched ? (term.confirmed ? "✓" : "!") : "×"}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-5">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">术语绑定</h2><p class="text-xs text-slate-500">必选术语未出现在译文中时会实时告警。</p></div>
                  <span class="badge badge-outline">{active().terms.length} 条</span>
                </div>
                <div class="mt-4 grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input class="input input-sm input-bordered" placeholder="中文术语" value={termSource.value} onInput$={(_, element) => termSource.value = element.value} />
                  <input class="input input-sm input-bordered" placeholder="目标语言固定译法" value={termTarget.value} onInput$={(_, element) => termTarget.value = element.value} />
                  <button class="btn btn-sm btn-primary" onClick$={addTerm}>绑定</button>
                </div>
                <div class="mt-3 grid gap-2 md:grid-cols-2">
                  {active().terms.map((term) => (
                    <div key={term.id} class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <div class="min-w-0">
                        <div class="truncate text-xs font-bold">{term.source}</div>
                        <div class="truncate text-xs text-slate-500">{term.target}</div>
                      </div>
                      <div class="flex gap-1">
                        <button class={`btn btn-xs ${term.confirmed ? "btn-success" : "btn-ghost"}`} onClick$={() => updateActive("确认术语", (sign) => { const target = sign.terms.find((item) => item.id === term.id); if (target) target.confirmed = !target.confirmed; })}>确认</button>
                        <button class="btn btn-xs btn-ghost text-error" onClick$={() => updateActive("删除术语", (sign) => { sign.terms = sign.terms.filter((item) => item.id !== term.id); })}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-5">
                <h2 class="font-bold">审校意见与回复</h2>
                <div class="mt-3 flex gap-2">
                  <textarea class="textarea textarea-bordered min-h-20 flex-1" placeholder="记录措辞、文化适配或法规依据…" value={commentDraft.value} onInput$={(_, element) => commentDraft.value = element.value} />
                  <button class="btn btn-primary self-end" onClick$={addComment}>添加意见</button>
                </div>
                <div class="mt-4 space-y-3">
                  {active().comments.length === 0 && <div class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-400">还没有审校意见。</div>}
                  {active().comments.map((comment) => (
                    <article key={comment.id} class={`rounded-xl border-l-4 bg-slate-50 p-3 ${comment.resolved ? "border-success opacity-60" : "border-warning"}`}>
                      <div class="flex items-center justify-between text-xs"><strong>{comment.author}</strong><span class="text-slate-400">{new Date(comment.createdAt).toLocaleString()}</span></div>
                      <p class="my-2 text-sm">{comment.body}</p>
                      {comment.replies.map((reply) => (
                        <div key={reply.id} class="ml-4 my-1 border-l-2 border-slate-200 pl-3 text-xs"><strong>{reply.author}</strong>：{reply.body}</div>
                      ))}
                      {replyingTo.value === comment.id ? (
                        <div class="mt-2 flex gap-2">
                          <input class="input input-xs input-bordered flex-1" value={replyDraft.value} onInput$={(_, element) => replyDraft.value = element.value} />
                          <button class="btn btn-xs btn-primary" onClick$={() => addReply(comment.id)}>发送</button>
                        </div>
                      ) : (
                        <div class="mt-2 flex gap-2">
                          <button class="btn btn-xs btn-ghost" onClick$={() => { replyingTo.value = comment.id; }}>回复</button>
                          <button class="btn btn-xs btn-ghost" onClick$={() => updateActive("更新意见状态", (sign) => { const item = sign.comments.find((entry) => entry.id === comment.id); if (item) item.resolved = !item.resolved; })}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </section>
          </div>
          </main>
        )}

        {mode.value === "braille" ? (
          <aside class="overflow-y-auto bg-slate-50 p-4">
            <section class="sticky top-4 space-y-4">
              <div class="card border border-slate-200 bg-white shadow-sm">
                <div class="card-body p-4">
                  <div class="flex items-center justify-between">
                    <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Tactile Preview</div><h2 class="font-bold">标牌排布预览</h2></div>
                    <span class="badge badge-outline">{brailleRecord()?.tactileSigns.length ?? 0} 块牌</span>
                  </div>
                  {(brailleRecord()?.tactileSigns.length ?? 0) > 0 ? (
                    <>
                      <div class="mt-3 flex flex-wrap gap-1">
                        {brailleRecord()!.tactileSigns.map((plate) => (
                          <button
                            key={plate.id}
                            class={`btn btn-xs ${(previewPlateId.value || brailleRecord()!.tactileSigns[0].id) === plate.id ? "btn-primary" : "btn-outline"}`}
                            onClick$={() => { previewPlateId.value = plate.id; }}
                          >{plate.code}</button>
                        ))}
                      </div>
                      {(() => {
                        const plate = brailleRecord()!.tactileSigns.find((item) => item.id === (previewPlateId.value || brailleRecord()!.tactileSigns[0].id)) ?? brailleRecord()!.tactileSigns[0];
                        const capacity = signCapacity(plate);
                        const cells = plateCells(plate);
                        while (cells.length < capacity.cellsPerLine * capacity.lines) cells.push("");
                        return (
                          <>
                            <div class="braille-plate mt-3" style={{ aspectRatio: `${plate.widthMm} / ${plate.heightMm}` }}>
                              <div class="braille-grid" style={{ gridTemplateColumns: `repeat(${capacity.cellsPerLine}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${capacity.lines}, minmax(0, 1fr))` }}>
                                {cells.map((cell, index) => (
                                  <div key={index} class="braille-cell">
                                    {brailleDots(cell || "⠀").map((on, dotIndex) => (
                                      <div key={dotIndex} class={on ? "dot on" : "dot"} />
                                    ))}
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                              <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{plate.widthMm}×{plate.heightMm}</strong><span>实测 mm</span></div>
                              <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{capacity.totalCells}</strong><span>容量 格</span></div>
                              <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{plate.blockIds.length}</strong><span>已排 块</span></div>
                            </div>
                            <div class="mt-2 flex items-center justify-between text-xs text-slate-500">
                              <span>点距 {plate.cellPitchMm}mm · 不缩</span>
                              {plate.installed && <span class="font-bold text-success">已装上牌 · 照旧留着</span>}
                            </div>
                          </>
                        );
                      })()}
                    </>
                  ) : (
                    <div class="mt-3 rounded-xl border border-dashed p-5 text-center text-xs text-slate-400">还没有触觉标牌。</div>
                  )}
                </div>
              </div>

              <div class="rounded-xl bg-[#17324d] p-4 text-xs text-slate-200">
                <div class="mb-2 font-bold text-white">盲文侧说明</div>
                <div class="space-y-1 leading-5">
                  <div>· 点字稿照译文指纹转写，译文改过即退回重转。</div>
                  <div>· 已上牌的块照旧留着，不随译文改动。</div>
                  <div>· 容量按实测牌面尺寸计算，放不下排队等重排。</div>
                  <div>· 转写失败只挂起盲文侧，逐块重试即可。</div>
                </div>
              </div>
            </section>
          </aside>
        ) : (
          <aside class="overflow-y-auto bg-slate-50 p-4">
          <section class="sticky top-4 space-y-4">
            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Live Preview</div><h2 class="font-bold">版面实时预览</h2></div>
                  <span class={`badge ${preview().risk === "high" ? "badge-error" : preview().risk === "medium" ? "badge-warning" : "badge-success"}`}>
                    {preview().risk === "high" ? "溢出风险" : preview().risk === "medium" ? "接近边界" : "版面安全"}
                  </span>
                </div>
                <div class="mt-3 flex gap-1">
                  {WIDTHS.map((width) => <button key={width} class={`btn btn-xs flex-1 ${previewWidth.value === width ? "btn-primary" : "btn-outline"}`} onClick$={() => previewWidth.value = width}>{width}px</button>)}
                </div>
                <div class="mt-2 flex items-center gap-3 text-xs">
                  <span class="w-20">字号 {previewFont.value}px</span>
                  <input type="range" min="28" max="88" step="2" class="range range-primary range-xs flex-1" value={previewFont.value} onInput$={(_, element) => previewFont.value = Number(element.value)} />
                </div>
                <div class="mt-4 overflow-hidden rounded-xl bg-slate-800 p-3">
                  <div class="mx-auto grid min-h-48 place-items-center overflow-hidden border-4 border-white bg-[#174f3d] p-3 text-center text-white" style={{ width: `${previewWidth.value}px`, maxWidth: "100%" }}>
                    <div>
                      <div style={{ fontSize: `${previewFont.value}px` }} class="font-black leading-[1.18] tracking-wide">{preview().visible.map((line, index) => <div key={index}>{line || "\u00a0"}</div>)}</div>
                    </div>
                  </div>
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                  <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{preview().lines.length}</strong><span>预计行数</span></div>
                  <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{active().targetText.length}</strong><span>字符数</span></div>
                  <div class="rounded-lg bg-slate-100 p-2"><strong class={`block text-lg ${preview().missingTerms.length ? "text-error" : "text-success"}`}>{preview().missingTerms.length}</strong><span>缺失术语</span></div>
                </div>
                {(preview().overflow || preview().tooLong) && <div class="alert alert-error mt-3 py-2 text-xs">{preview().overflow ? "当前字号下内容超过三行，可能截断。" : "译文接近标识建议字符上限。"}</div>}
              </div>
            </div>

            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">版本比较</h2><p class="text-xs text-slate-500">旧版快照与当前译文逐词对比。</p></div>
                  <span class="badge badge-outline">{active().versions.length} 版</span>
                </div>
                {active().versions.length ? (
                  <>
                    <select class="select select-sm select-bordered mt-3 w-full" value={selectedVersionId.value || active().versions[0].id} onChange$={(_, element) => selectedVersionId.value = element.value}>
                      {active().versions.map((version) => <option key={version.id} value={version.id}>{`${version.label} · ${new Date(version.createdAt).toLocaleTimeString()}`}</option>)}
                    </select>
                    <div class="mt-3 rounded-lg bg-slate-900 p-3 text-sm leading-7 text-slate-100">
                      {comparison().map((token, index) => (
                        <span key={index} class={token.type === "add" ? "rounded bg-green-400/25 text-green-200" : token.type === "remove" ? "bg-red-400/25 text-red-200 line-through" : ""}>{token.value}</span>
                      ))}
                    </div>
                    <div class="mt-2 flex gap-3 text-[11px]"><span class="text-green-700">绿：新增</span><span class="text-red-700">红：删除</span></div>
                  </>
                ) : (
                  <div class="mt-3 rounded-xl border border-dashed p-5 text-center text-xs text-slate-400">保存当前译文后会在这里生成可比较版本。</div>
                )}
              </div>
            </div>

            <div class="rounded-xl bg-[#17324d] p-4 text-xs text-slate-200">
              <div class="mb-2 font-bold text-white">键盘操作</div>
              <div class="grid grid-cols-2 gap-y-1"><span><kbd class="kbd kbd-xs">J/K</kbd> 切换标识</span><span><kbd class="kbd kbd-xs">[ ]</kbd> 预览宽度</span><span><kbd class="kbd kbd-xs">- =</kbd> 字号</span><span><kbd class="kbd kbd-xs">Ctrl/⌘ Z</kbd> 撤销</span></div>
            </div>
          </section>
          </aside>
        )}
      </div>

      {toast.value && <div class="toast toast-end z-50"><div class="alert alert-success"><span>{toast.value}</span></div></div>}
    </div>
  );
});
