import { $, component$, useSignal, type Signal } from "@builder.io/qwik";
import {
  BRAILLE_METRICS,
  ensureBrailleRecords,
  isDraftStale,
  layoutPlate,
  layoutSignature,
  plateCapacity,
  retryBlock,
  transcribeSign,
  translationRev,
} from "../braille";
import type { BrailleBook, BrailleDraft, SignItem, SignProject } from "../types";
import { diffText } from "../utils";

interface Props {
  project: Signal<SignProject>;
  book: Signal<BrailleBook>;
  toast: Signal<string>;
}

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");

function providerBadge(draft: BrailleDraft | undefined, sign: SignItem) {
  if (!draft) return { label: "待回填", cls: "badge-neutral" };
  if (draft.status === "installed") return { label: "已装牌", cls: "badge-info" };
  if (isDraftStale(draft, sign)) return { label: "需重转", cls: "badge-error" };
  if (draft.status === "suspended") return { label: "已挂起", cls: "badge-error" };
  if (draft.status === "confirmed") return { label: "已确认", cls: "badge-success" };
  return { label: "待确认", cls: "badge-warning" };
}

export const BrailleProvider = component$<Props>(({ project, book, toast }) => {
  const selectedId = useSignal("");

  const resolveSign = () =>
    project.value.signs.find((item) => item.id === selectedId.value) ??
    project.value.signs.find((item) => item.id === project.value.activeSignId) ??
    project.value.signs[0];

  const mutateBook = $((update: (draft: BrailleBook) => void) => {
    const next = structuredClone(book.value);
    update(next);
    next.updatedAt = new Date().toISOString();
    book.value = next;
  });

  const backfill = $(() => {
    mutateBook((draft) => {
      ensureBrailleRecords(draft, project.value);
    });
    toast.value = "已按译文回填待确认初稿";
  });

  const retranscribe = $((signId: string) => {
    const target = project.value.signs.find((item) => item.id === signId);
    if (!target) return;
    mutateBook((draft) => {
      const fresh = transcribeSign(target);
      draft.drafts[target.id] = fresh;
      const plate = draft.plates[target.id];
      if (plate) plate.layout = layoutPlate(fresh.blocks, plate.measuredWidthMm, plate.measuredHeightMm);
      toast.value =
        fresh.status === "suspended"
          ? "转写未完成：部分块失败，本侧已挂起，请逐块重试"
          : "已按当前译文重新转写，待确认";
    });
  });

  const retry = $((signId: string, blockId: string) => {
    mutateBook((draft) => {
      const brailleDraft = draft.drafts[signId];
      if (!brailleDraft) return;
      retryBlock(brailleDraft, blockId);
      const plate = draft.plates[signId];
      if (plate) {
        plate.layout = layoutPlate(brailleDraft.blocks, plate.measuredWidthMm, plate.measuredHeightMm);
      }
      toast.value =
        brailleDraft.status === "suspended" ? "该块已恢复，仍有失败块待重试" : "全部块已恢复，本侧解除挂起";
    });
  });

  const confirmDraft = $((signId: string) => {
    mutateBook((draft) => {
      const brailleDraft = draft.drafts[signId];
      if (!brailleDraft || brailleDraft.status !== "pending") return;
      brailleDraft.status = "confirmed";
      brailleDraft.confirmedAt = new Date().toISOString();
      brailleDraft.updatedAt = brailleDraft.confirmedAt;
      toast.value = "点字稿已确认";
    });
  });

  const updateMeasure = $((signId: string, field: "measuredWidthMm" | "measuredHeightMm", value: number) => {
    const size = Math.max(40, Math.min(600, Math.round(value) || 40));
    mutateBook((draft) => {
      const plate = draft.plates[signId];
      // 已装牌的不动量好的尺寸
      if (!plate || plate.installedAt) return;
      plate[field] = size;
      plate.measuredAt = new Date().toISOString();
    });
  });

  const relay = $((signId: string) => {
    mutateBook((draft) => {
      const brailleDraft = draft.drafts[signId];
      const plate = draft.plates[signId];
      if (!brailleDraft || !plate || plate.installedAt) return;
      plate.layout = layoutPlate(brailleDraft.blocks, plate.measuredWidthMm, plate.measuredHeightMm);
      toast.value = plate.layout.queue.length
        ? `已按实测尺寸重排，仍有 ${plate.layout.queue.length} 块排队`
        : "已按实测尺寸重排，全部块已排下";
    });
  });

  const install = $((signId: string) => {
    mutateBook((draft) => {
      const brailleDraft = draft.drafts[signId];
      const plate = draft.plates[signId];
      if (!brailleDraft || !plate || !plate.layout) return;
      const now = new Date().toISOString();
      brailleDraft.status = "installed";
      brailleDraft.installedAt = now;
      brailleDraft.updatedAt = now;
      plate.installedAt = now;
      toast.value = "已装牌，牌子保持现状";
    });
  });

  const remake = $((signId: string) => {
    const target = project.value.signs.find((item) => item.id === signId);
    if (!target) return;
    mutateBook((draft) => {
      const brailleDraft = draft.drafts[signId];
      const plate = draft.plates[signId];
      if (!brailleDraft || !plate || brailleDraft.status !== "installed") return;
      // 换下来的旧牌子照旧留档
      if (plate.layout && plate.installedAt) {
        plate.archives.unshift({ rev: brailleDraft.basedOnRev, installedAt: plate.installedAt, layout: plate.layout });
      }
      const fresh = transcribeSign(target);
      draft.drafts[signId] = fresh;
      plate.installedAt = undefined;
      plate.layout = layoutPlate(fresh.blocks, plate.measuredWidthMm, plate.measuredHeightMm);
      toast.value = "旧牌已存档保留，按新译文重新转写";
    });
  });

  const current = resolveSign();
  const draft = book.value.drafts[current.id];
  const plate = book.value.plates[current.id];

  return (
    <div class="grid min-h-[calc(100vh-64px)] grid-cols-[270px_minmax(560px,1fr)_430px] gap-px bg-slate-300">
      <aside class="overflow-y-auto bg-slate-50 p-3">
        <div class="mb-3 rounded-xl bg-white p-4 shadow-sm">
          <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Braille Provider</div>
          <div class="mt-1 text-lg font-bold text-slate-800">盲文服务方工作台</div>
          <p class="mt-1 text-xs leading-5 text-slate-500">
            点字稿与触觉标牌由本侧独立维护，与语言服务中心的本地稿分开保存；服务中心改译文不会盖掉已量好的排布。
          </p>
        </div>
        <div class="space-y-2">
          {project.value.signs.map((item) => {
            const itemDraft = book.value.drafts[item.id];
            const itemPlate = book.value.plates[item.id];
            const badge = providerBadge(itemDraft, item);
            const queued = itemPlate?.layout?.queue.length ?? 0;
            return (
              <button
                key={item.id}
                class={`w-full rounded-xl border p-3 text-left transition ${
                  item.id === current.id
                    ? "border-emerald-400 bg-emerald-50 shadow-sm"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
                onClick$={() => {
                  selectedId.value = item.id;
                }}
              >
                <div class="flex items-center justify-between">
                  <span class="font-mono text-xs font-bold text-slate-500">{item.code}</span>
                  <span class={`badge badge-sm ${badge.cls}`}>{badge.label}</span>
                </div>
                <div class="mt-2 line-clamp-2 text-sm font-semibold text-slate-700">{item.sourceText}</div>
                <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                  <span>{item.targetLanguage}</span>
                  <span class={queued ? "font-bold text-warning" : ""}>
                    {queued ? `${queued} 块排队等重排` : itemPlate?.installedAt ? "牌子已安装" : ""}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {!draft || !plate ? (
        <main class="col-span-2 grid min-w-0 place-items-center bg-white">
          <div class="rounded-xl border border-dashed p-10 text-center">
            <p class="text-sm text-slate-500">「{current.code}」还没有点字记录。</p>
            <button class="btn btn-sm btn-primary mt-4" onClick$={backfill}>
              按译文回填待确认初稿
            </button>
          </div>
        </main>
      ) : (
        <>
          <main class="min-w-0 bg-white">
            <div class="border-b border-slate-200 bg-slate-50 px-6 py-4">
              <div class="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
                {current.code} · {current.scenario}
              </div>
              <h1 class="mt-1 text-xl font-bold">点字稿（盲文服务方）</h1>
            </div>

            <div class="space-y-5 p-6">
              {(() => {
                const stale = isDraftStale(draft, current);
                const failedCount = draft.blocks.filter((block) => block.status === "failed").length;
                const badge = providerBadge(draft, current);
                const canConfirm = draft.status === "pending" && !stale && failedCount === 0;
                return (
                  <>
                    <section class="card border border-slate-200 bg-white shadow-sm">
                      <div class="card-body gap-3 p-5">
                        <div class="flex items-center justify-between">
                          <h2 class="font-bold">转写依据</h2>
                          <div class="flex items-center gap-2">
                            {draft.backfilled && <span class="badge badge-ghost badge-sm">旧稿回填初稿</span>}
                            <span class={`badge ${badge.cls}`}>{badge.label}</span>
                          </div>
                        </div>
                        <div class="grid grid-cols-2 gap-3 text-xs">
                          <div class="rounded-lg bg-slate-100 p-3">
                            <div class="text-slate-500">本稿照此版译文转写</div>
                            <div class="mt-1 font-mono text-sm font-bold">#{draft.basedOnRev}</div>
                          </div>
                          <div class="rounded-lg bg-slate-100 p-3">
                            <div class="text-slate-500">服务中心当前译文版本</div>
                            <div class={`mt-1 font-mono text-sm font-bold ${stale ? "text-error" : ""}`}>
                              #{translationRev(current)}
                            </div>
                          </div>
                        </div>
                        <details class="text-xs text-slate-500">
                          <summary class="cursor-pointer font-bold">转写时依据的译文快照</summary>
                          <p class="mt-2 whitespace-pre-line rounded-lg bg-slate-50 p-3">{draft.basedOnText}</p>
                        </details>
                      </div>
                    </section>

                    {stale && (
                      <div class="alert alert-warning items-start">
                        <div class="w-full">
                          <div class="font-bold">译文已变更，本稿退回重转</div>
                          <p class="text-xs">
                            服务中心改动了译文，点字稿仍依据旧版。对照如下（绿：新增，红：删除）：
                          </p>
                          <div class="mt-2 rounded-lg bg-slate-900 p-3 text-sm leading-7 text-slate-100">
                            {diffText(draft.basedOnText, current.targetText).map((token, index) => (
                              <span
                                key={index}
                                class={
                                  token.type === "add"
                                    ? "rounded bg-green-400/25 text-green-200"
                                    : token.type === "remove"
                                      ? "bg-red-400/25 text-red-200 line-through"
                                      : ""
                                }
                              >
                                {token.value}
                              </span>
                            ))}
                          </div>
                          <button class="btn btn-sm btn-primary mt-3" onClick$={() => retranscribe(current.id)}>
                            按当前译文重新转写
                          </button>
                        </div>
                      </div>
                    )}

                    {draft.status === "suspended" && (
                      <div class="alert alert-error items-start">
                        <div>
                          <div class="font-bold">转写失败，本侧已挂起</div>
                          <p class="text-xs">
                            {failedCount} 个块转写失败。只挂起盲文服务方这一侧，服务中心的译文与审校照常可看。
                            请在下方逐块重试，无法转写的字符将以 ⠿ 占位。
                          </p>
                        </div>
                      </div>
                    )}

                    {draft.status === "installed" && (
                      <div class="alert alert-success items-start">
                        <div class="w-full">
                          <div class="font-bold">已装牌 · 牌子保持现状</div>
                          <p class="text-xs">
                            装牌时间 {fmtTime(draft.installedAt)}。译文后续变更不影响已经装上的牌子。
                          </p>
                          {translationRev(current) !== draft.basedOnRev && (
                            <button class="btn btn-sm btn-outline mt-2" onClick$={() => remake(current.id)}>
                              译文已更新：旧牌存档，按新译文重新制作
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    <section class="card border border-slate-200 bg-white shadow-sm">
                      <div class="card-body gap-4 p-5">
                        <div class="flex items-center justify-between">
                          <div>
                            <h2 class="font-bold">点字块</h2>
                            <p class="text-xs text-slate-500">
                              拉丁字母为一级盲文，重音字母按基础字母、非拉丁文字按示意点字转写；正式生产需接入对应语种盲文表。
                            </p>
                          </div>
                          <span class="badge badge-outline">{draft.blocks.length} 块</span>
                        </div>
                        <div class="space-y-2">
                          {draft.blocks.map((block) => (
                            <div
                              key={block.id}
                              class={`rounded-xl border p-3 ${
                                block.status === "failed" ? "border-error bg-red-50" : "border-slate-200 bg-slate-50"
                              }`}
                            >
                              <div class="flex items-center justify-between text-xs">
                                <span class="font-bold text-slate-500">第 {block.index + 1} 块</span>
                                {block.status === "failed" ? (
                                  <span class="font-bold text-error">转写失败 · 已试 {block.attempts} 次</span>
                                ) : (
                                  <span class="text-success">
                                    已转写{block.placeholder ? "（含 ⠿ 占位）" : ""}
                                  </span>
                                )}
                              </div>
                              <div class="mt-1 text-sm text-slate-700">{block.text || "（空行）"}</div>
                              {block.status === "failed" ? (
                                <div class="mt-2 flex items-center justify-between gap-2">
                                  <span class="text-xs text-error">{block.error}</span>
                                  <button
                                    class="btn btn-xs btn-warning"
                                    onClick$={() => retry(current.id, block.id)}
                                  >
                                    重试
                                  </button>
                                </div>
                              ) : (
                                <div class="mt-1 break-all text-2xl leading-9 tracking-[0.25em] text-slate-900">
                                  {block.cells}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                          <button
                            class="btn btn-sm btn-outline"
                            disabled={draft.status === "installed"}
                            onClick$={() => retranscribe(current.id)}
                          >
                            重新转写
                          </button>
                          <button
                            class="btn btn-sm btn-primary"
                            disabled={!canConfirm}
                            onClick$={() => confirmDraft(current.id)}
                          >
                            确认点字稿
                          </button>
                          <span class="text-xs text-slate-400">
                            确认后才能在右侧装牌；译文变更后需重新转写再确认。
                          </span>
                        </div>
                      </div>
                    </section>
                  </>
                );
              })()}
            </div>
          </main>

          <aside class="overflow-y-auto bg-slate-50 p-4">
            <section class="sticky top-4 space-y-4">
              {(() => {
                const stale = isDraftStale(draft, current);
                const failedCount = draft.blocks.filter((block) => block.status === "failed").length;
                const capacity = plateCapacity(plate.measuredWidthMm, plate.measuredHeightMm);
                const layoutStale =
                  !plate.layout ||
                  plate.layout.signature !==
                    layoutSignature(draft.blocks, plate.measuredWidthMm, plate.measuredHeightMm);
                const canInstall =
                  draft.status === "confirmed" &&
                  !stale &&
                  failedCount === 0 &&
                  !layoutStale &&
                  (plate.layout?.queue.length ?? 1) === 0 &&
                  !plate.installedAt;
                return (
                  <>
                    <div class="card border border-slate-200 bg-white shadow-sm">
                      <div class="card-body gap-3 p-4">
                        <div class="flex items-center justify-between">
                          <div>
                            <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
                              Tactile Plate
                            </div>
                            <h2 class="font-bold">触觉标牌</h2>
                          </div>
                          {plate.installedAt ? (
                            <span class="badge badge-info">已装牌</span>
                          ) : (
                            <span class="badge badge-ghost">未装牌</span>
                          )}
                        </div>

                        <div class="grid grid-cols-2 gap-2">
                          <label class="form-control">
                            <span class="label-text mb-1 text-xs font-bold text-slate-500">实测牌宽 (mm)</span>
                            <input
                              type="number"
                              class="input input-sm input-bordered"
                              value={plate.measuredWidthMm}
                              disabled={Boolean(plate.installedAt)}
                              onInput$={(_, element) =>
                                updateMeasure(current.id, "measuredWidthMm", Number(element.value))
                              }
                            />
                          </label>
                          <label class="form-control">
                            <span class="label-text mb-1 text-xs font-bold text-slate-500">实测牌高 (mm)</span>
                            <input
                              type="number"
                              class="input input-sm input-bordered"
                              value={plate.measuredHeightMm}
                              disabled={Boolean(plate.installedAt)}
                              onInput$={(_, element) =>
                                updateMeasure(current.id, "measuredHeightMm", Number(element.value))
                              }
                            />
                          </label>
                        </div>
                        {!plate.measuredAt && !plate.installedAt && (
                          <p class="text-[11px] font-bold text-warning">当前为默认牌面尺寸，请实测牌面后填写。</p>
                        )}
                        <p class="rounded-lg bg-slate-100 p-2 text-[11px] leading-5 text-slate-500">
                          固定工艺参数：点距 {BRAILLE_METRICS.dotPitchMm}mm · 方距 {BRAILLE_METRICS.cellPitchMm}
                          mm · 行距 {BRAILLE_METRICS.linePitchMm}mm · 边距 {BRAILLE_METRICS.marginMm}mm。
                          容量只按实测牌面尺寸计算：不缩点距，也不改动量好的尺寸。
                        </p>

                        <div class="grid grid-cols-3 gap-2 text-center text-xs">
                          <div class="rounded-lg bg-slate-100 p-2">
                            <strong class="block text-lg">{capacity.columns}</strong>
                            <span>列（方）</span>
                          </div>
                          <div class="rounded-lg bg-slate-100 p-2">
                            <strong class="block text-lg">{capacity.rows}</strong>
                            <span>行</span>
                          </div>
                          <div class="rounded-lg bg-slate-100 p-2">
                            <strong class="block text-lg">{capacity.capacityCells}</strong>
                            <span>容量（方）</span>
                          </div>
                        </div>

                        {layoutStale && !plate.installedAt && (
                          <div class="alert alert-warning py-2 text-xs">
                            牌面尺寸或点字稿已变化，排版待重排；以下为上次排版结果。
                          </div>
                        )}

                        <div class="overflow-hidden rounded-xl bg-slate-800 p-3">
                          <div class="min-h-24 rounded-lg border-2 border-slate-500 bg-[#3f3f46] p-3">
                            {plate.layout?.rows.length ? (
                              plate.layout.rows.map((row, index) => (
                                <div key={index} class="break-all text-xl leading-8 tracking-[0.2em] text-amber-100">
                                  {row}
                                </div>
                              ))
                            ) : (
                              <div class="py-6 text-center text-xs text-slate-400">暂无排版</div>
                            )}
                          </div>
                          {plate.layout && (
                            <div class="mt-1 text-right text-[10px] text-slate-400">
                              已用 {plate.layout.rows.length}/{plate.layout.rowCount} 行 · 排版于{" "}
                              {fmtTime(plate.layout.laidOutAt)}
                            </div>
                          )}
                        </div>

                        {plate.layout && plate.layout.queue.length > 0 && (
                          <div class="rounded-xl border border-warning bg-amber-50 p-3">
                            <div class="text-xs font-bold text-amber-700">
                              排队等重排 · {plate.layout.queue.length} 块
                            </div>
                            <ol class="mt-2 space-y-1 text-xs">
                              {plate.layout.queue.map((item, index) => (
                                <li key={item.blockId} class="flex justify-between gap-2">
                                  <span class="truncate">
                                    {index + 1}. {item.text}
                                  </span>
                                  <span class="shrink-0 text-slate-400">{item.cells.length} 方</span>
                                </li>
                              ))}
                            </ol>
                            <p class="mt-2 text-[11px] text-slate-500">
                              牌面放不下时不缩点距、不改尺寸；请实测更大牌面或请服务中心精简译文后重排。
                            </p>
                          </div>
                        )}

                        <div class="flex gap-2">
                          <button
                            class="btn btn-sm btn-outline flex-1"
                            disabled={Boolean(plate.installedAt)}
                            onClick$={() => relay(current.id)}
                          >
                            重排
                          </button>
                          <button
                            class="btn btn-sm btn-success flex-1"
                            disabled={!canInstall}
                            onClick$={() => install(current.id)}
                          >
                            装牌
                          </button>
                        </div>
                        {plate.installedAt ? (
                          <p class="text-[11px] text-slate-400">
                            已于 {fmtTime(plate.installedAt)} 装牌，尺寸与排版冻结保留。
                          </p>
                        ) : (
                          <p class="text-[11px] text-slate-400">
                            装牌前需点字稿已确认、全部块排下且无待重排变更。
                          </p>
                        )}
                      </div>
                    </div>

                    {plate.archives.length > 0 && (
                      <div class="card border border-slate-200 bg-white shadow-sm">
                        <div class="card-body p-4">
                          <h2 class="font-bold">已装牌存档</h2>
                          <p class="text-xs text-slate-500">换下来的旧牌子照旧保留，不随译文变更。</p>
                          {plate.archives.map((archive, index) => (
                            <details key={index} class="mt-2 rounded-lg border border-slate-200 p-2">
                              <summary class="cursor-pointer text-xs font-bold">
                                #{archive.rev} · 装牌于 {fmtTime(archive.installedAt)}
                              </summary>
                              <div class="mt-2 rounded-lg bg-slate-800 p-2">
                                {archive.layout.rows.map((row, rowIndex) => (
                                  <div
                                    key={rowIndex}
                                    class="break-all text-lg leading-7 tracking-[0.2em] text-amber-100"
                                  >
                                    {row}
                                  </div>
                                ))}
                              </div>
                            </details>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </section>
          </aside>
        </>
      )}
    </div>
  );
});
