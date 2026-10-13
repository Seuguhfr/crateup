/* Upgrader review: deck-pair listening, similarity queue, decisions,
   and the commit phase. Reads the ledger fresh on every paint so a
   re-render mid-review (or a crash recovery) resumes exactly where
   the user left off. */

import {
  checkRekordboxStatus,
  commitChanges,
  convertFileSrc,
  downloadTrackById,
  getFileSize,
  identifyTrack,
  isTauri,
  readLedgerFile,
  resetSession,
  saveLedgerDecision,
  selectOutputDirectory,
  updateRekordboxDbDirectly,
  updateRekordboxXml,
} from "../api.js";
import { clearSession, setSession } from "../store.js";
import {
  renderDock,
  renderInspector,
  renderUpgraderStage,
} from "../chrome.js";
import {
  esc,
  fmtBytes,
  fmtTime,
  joinPath,
  isLosslessExt,
  type Ledger,
} from "./utils.js";
import type { SourceResolution } from "./source.js";

/* ---------------- types ---------------- */

type CatId =
  | "identical"
  | "almost_identical"
  | "close_enough"
  | "potential_mismatch"
  | "unresolved";
type DeckId = "original" | "staged";

interface ReviewItem {
  relPath: string;
  status: string;
  deezerId: number | null | undefined;
  proxyPath: string | null | undefined;
  bitIdentical: boolean | undefined;
  similarityScore: number | undefined;
}

export interface ReviewCallbacks {
  onBack: () => void;
  onFinish: () => void;
  onClose: () => void;
}

interface Ws {
  destroy(): void;
  empty(): void;
  load(url: string): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seekTo(fraction: number): void;
  setTime(t: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPlaying(): boolean;
  getMediaElement(): HTMLMediaElement | null;
  getAudioContext?(): AudioContext | null;
  audioContext?: AudioContext | null;
  on(ev: string, cb: (v?: unknown) => void): void;
  options?: { backend?: string };
}

interface WaveSurferGlobal {
  create(opts: Record<string, unknown>): Ws;
  VERSION?: string;
}

/* ---------------- module state ---------------- */

const CATEGORY_ORDER: CatId[] = [
  "identical",
  "almost_identical",
  "close_enough",
  "potential_mismatch",
  "unresolved",
];

const CATEGORY_LABELS: Record<CatId, string> = {
  identical: "Identical Audio",
  almost_identical: "Almost Identical",
  close_enough: "Not Certain",
  potential_mismatch: "Potential Mismatch",
  unresolved: "Unresolved / No Upgrade",
};

const CATEGORY_ALLOW_APPROVE: Record<CatId, boolean> = {
  identical: true,
  almost_identical: true,
  close_enough: true,
  potential_mismatch: true,
  unresolved: false,
};

const PLAY_SVG = `<svg viewBox="0 0 8 8"><path d="M1 1l6 3-6 3z" fill="currentColor"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 8 8"><rect x="1" y="1" width="2.4" height="6" rx="0.6" fill="currentColor"/><rect x="4.6" y="1" width="2.4" height="6" rx="0.6" fill="currentColor"/></svg>`;

let active = false;
let res: SourceResolution | null = null;
let cb: ReviewCallbacks | null = null;
let ledger: Ledger | null = null;
let queue: ReviewItem[] = [];
let currentIndex = -1;
let focus: DeckId = "original";
let expanded: Record<CatId, boolean> = {
  identical: false,
  almost_identical: false,
  close_enough: false,
  potential_mismatch: false,
  unresolved: false,
};
let wsOrig: Ws | null = null;
let wsStaged: Ws | null = null;
const readyState: Record<DeckId, { ready: boolean; decode: boolean }> = {
  original: { ready: false, decode: false },
  staged: { ready: false, decode: false },
};
let lockInterval: number | null = null;
let watchdogRetried = false;
let watchdogTimer: number | null = null;
let wavWarningShown = false;

function waveSurfer(): WaveSurferGlobal | null {
  const w = (window as { WaveSurfer?: WaveSurferGlobal }).WaveSurfer;
  return w ?? null;
}

function isWs7(): boolean {
  const w = waveSurfer();
  return !!w && typeof w.VERSION === "string" && w.VERSION.startsWith("7");
}

/* ---------------- helpers ---------------- */

function id<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(`#view ${selector}`);
}

function filenameOf(relPath: string): string {
  return relPath.split("/").pop() ?? relPath;
}

function getItemCategory(item: ReviewItem): CatId {
  const le = ledger?.files?.[item.relPath];
  if (!le) return "unresolved";
  const bit = item.bitIdentical ?? le.audio_bit_identical;
  const score = item.similarityScore ?? le.similarity_score;
  if (item.status === "downloaded") {
    if (bit) return "identical";
    if (typeof score === "number") {
      if (score >= 0.9) return "almost_identical";
      if (score >= 0.75) return "close_enough";
    }
    return "potential_mismatch";
  }
  return "unresolved";
}

function leFor(item: ReviewItem): Record<string, unknown> {
  return ledger?.files?.[item.relPath] ?? {};
}

function decide(item: ReviewItem): string {
  return (leFor(item).decision as string | undefined) ?? "pending";
}

function hasShazamMeta(item: ReviewItem): boolean {
  const le = leFor(item);
  const artist = le.artist as string | undefined;
  const title = le.title as string | undefined;
  return !!artist && !!title && artist !== "Unknown Artist" && title !== "Unknown Title";
}

function matchPct(item: ReviewItem): number | null {
  if (item.status !== "downloaded") return null;
  const le = leFor(item);
  const bit = item.bitIdentical ?? le.audio_bit_identical;
  if (bit) return 100;
  const sim = item.similarityScore ?? le.similarity_score;
  return typeof sim === "number" ? Math.round(sim * 100) : null;
}

function unresolvedReason(item: ReviewItem): string {
  switch (item.status) {
    case "unidentified":
      return "Shazam could not identify this track";
    case "not_on_deezer":
      return "Identified, but not available on Deezer";
    case "download_failed":
      return `Download failed — Deezer ID: ${item.deezerId ?? "Unknown"}`;
    default:
      return "No upgrade available";
  }
}

function whyText(item: ReviewItem): string {
  if (item.status !== "downloaded") {
    return `<b>${unresolvedReason(item)}</b>`;
  }
  const pct = matchPct(item);
  const bit = item.bitIdentical ?? leFor(item).audio_bit_identical;
  if (bit) return "Bit-for-bit identical audio. <b>100% match</b> — safe to approve.";
  if (typeof pct === "number" && pct >= 90) {
    return `Acoustic fingerprint matches at <b>${pct}%</b> — almost certainly the same mix.`;
  }
  if (typeof pct === "number" && pct >= 75) {
    return `<b>${pct}% match</b> — same energy, possibly a different master. Listen closely.`;
  }
  return typeof pct === "number"
    ? `<b>${pct}% match</b> — under 75%. Verify: this may be a different recording.`
    : "Similarity not computed for this pair.";
}

function statusBadge(item: ReviewItem): string {
  const pct = matchPct(item);
  if (pct !== null) {
    if (pct >= 100) return `<span class="sc">${pct}%</span>`;
    if (pct >= 90) return `<span class="sc">${pct}%</span>`;
    if (pct >= 75) return `<span class="sc w">${pct}%</span>`;
    return `<span class="sc b">${pct}%</span>`;
  }
  const d = decide(item);
  if (d === "approved") return `<span class="sc">✓</span>`;
  if (d === "skipped") return `<span class="sc n">–</span>`;
  return `<span class="sc n">…</span>`;
}

/* ---------------- screen ---------------- */

function headMetaHtml(): string {
  return `
    <div class="diff">
      <span class="why" id="rv-why">Loading…</span>
    </div>
    <div class="frow hidden" id="rv-refetch-row">
      <button class="btn sm" id="rv-identify">Identify</button>
      <input class="field" id="rv-deezer-id" placeholder="Deezer ID…" autocomplete="off" />
      <button class="btn sm" id="rv-refetch">Refetch</button>
      <span class="kb" id="rv-feedback"></span>
    </div>
    <div class="sect" style="padding:8px 14px">
      <h3>File comparison</h3>
      <div class="kvr"><span class="v" id="rv-o-file">–</span><span class="k">File</span><span class="v n" id="rv-s-file">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-size">–</span><span class="k">Size</span><span class="v n" id="rv-s-size">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-format">–</span><span class="k">Format</span><span class="v n" id="rv-s-format">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-bitrate">–</span><span class="k">Bitrate</span><span class="v n" id="rv-s-bitrate">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-dur">–</span><span class="k">Time</span><span class="v n" id="rv-s-dur">–</span></div>
    </div>`;
}

function deckHtml(deck: DeckId): string {
  const orig = deck === "original";
  const cls = orig ? "dorig" : "dnew";
  const rbp = orig ? "Original" : "Upgrade";
  return `
    <div class="deck ${cls}" id="deck-${deck}">
      <div class="dh">
        <button class="play" id="play-${deck}" disabled title="Play / pause (Space)">${PLAY_SVG}</button>
        <span class="nm" id="rv-${deck[0]}-name">${orig ? "Original track" : "No upgrade"}</span>
        <span class="rbp">${rbp}</span>
        <span class="dur" id="rv-${deck[0]}-time">00:00</span>
      </div>
      <div class="wav" id="wave-${deck}">
        <div class="loading" id="rv-${deck[0]}-load">${orig ? "Loading original audio…" : ""}</div>
      </div>
      <div class="tr">
        <span class="fl" id="rv-${deck[0]}-fmt">—</span>
        <span class="time" id="rv-${deck[0]}-dur2">--:--</span>
      </div>
    </div>`;
}

function workspaceHtml(): string {
  return `
    <div class="cv">
      ${deckHtml("original")}
      ${deckHtml("staged")}
      ${headMetaHtml()}
      <div class="rev-foot">
        <span class="kb">Review keys · <kbd>Space</kbd> play/pause</span>
        <span class="kb">
          <kbd>↵</kbd> approve &nbsp;<kbd>⌫</kbd> skip &nbsp;<kbd>←→</kbd> seek &nbsp;<kbd>↑↓</kbd> focus
        </span>
        <span class="kb" id="rv-reviewed">—</span>
      </div>
    </div>`;
}

function queueGroupHtml(cat: CatId): string {
  const isOpen = expanded[cat];
  const items = queue
    .map((item, idx) => ({ item, idx, cat: getItemCategory(item) }))
    .filter((g) => g.cat === cat);
  if (items.length === 0) return "";

  const total = items.length;
  const done = items.filter(({ item }) => decide(item) !== "pending").length;
  const hasPending = done < total;
  const allowApprove = CATEGORY_ALLOW_APPROVE[cat];

  const acts = hasPending
    ? `<div class="qg-acts">
        ${allowApprove ? `<button class="btn iv" data-batch="approve" data-cat="${cat}">Approve remaining</button>` : ""}
        <button class="btn iv" data-batch="skip" data-cat="${cat}">${allowApprove ? "Skip remaining" : "Keep remaining"}</button>
       </div>`
    : "";

  const rows = items
    .map(({ item, idx }) => {
      const name = esc(filenameOf(item.relPath));
      const badge = statusBadge(item);
      return `<div class="qr ${idx === currentIndex ? "on" : ""}" data-idx="${idx}" title="${esc(item.relPath)}">
        <span class="tt">${name}</span>${badge}
      </div>`;
    })
    .join("");

  return `<div class="qg ${isOpen ? "open" : ""}" data-cat="${cat}">
    <button><span class="tri">▶</span><span class="tt">${CATEGORY_LABELS[cat]}</span><span class="cnt">${done}/${total}</span></button>
    ${isOpen ? `<div class="qrows">${acts}${rows}</div>` : ""}
  </div>`;
}

function renderQueue(): void {
  const body = document.getElementById("insp-body");
  if (!body) return;
  body.innerHTML =
    `<div class="isec">
       <h4>Review queue</h4>
       <p class="muted small" id="rv-qhead">${queue.length} tracks · ${countReviewed()} reviewed</p>
     </div>` +
    CATEGORY_ORDER.map(queueGroupHtml).join("");
  bindQueue(body);
}

function updateQueueRow(index: number): void {
  const item = queue[index];
  if (!item) return;

  const row = document.querySelector<HTMLElement>(`#insp-body .qr[data-idx="${index}"]`);
  if (row) {
    const badge = statusBadge(item);
    const existingBadge = row.querySelector(".sc");
    if (existingBadge) {
      existingBadge.outerHTML = badge;
    } else {
      row.insertAdjacentHTML("beforeend", badge);
    }
  }

  const cat = getItemCategory(item);
  const catGroup = document.querySelector<HTMLElement>(`#insp-body .qg[data-cat="${cat}"]`);
  if (catGroup) {
    const catItems = queue.filter((i) => getItemCategory(i) === cat);
    const total = catItems.length;
    const done = catItems.filter((i) => decide(i) !== "pending").length;
    const cnt = catGroup.querySelector(".cnt");
    if (cnt) cnt.textContent = `${done}/${total}`;
    if (done >= total) {
      catGroup.querySelector(".qg-acts")?.remove();
    }
  }
}

function countReviewed(): number {
  return queue.filter((item) => decide(item) !== "pending").length;
}

function bindQueue(body: HTMLElement): void {
  body.querySelectorAll<HTMLElement>("[data-cat] > button").forEach((btn) => {
    const group = btn.parentElement;
    if (!group) return;
    btn.addEventListener("click", () => {
      const cat = group.dataset.cat as CatId;
      const wasOpen = expanded[cat];
      (Object.keys(expanded) as CatId[]).forEach((k) => (expanded[k] = false));
      if (!wasOpen) expanded[cat] = true;
      renderQueue();
    });
  });
  body.querySelectorAll<HTMLElement>("[data-batch]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat as CatId;
      const kind = btn.dataset.batch;
      if (kind === "approve") clearCategory(cat, true);
      else clearCategory(cat, false);
    });
  });
  body.querySelectorAll<HTMLElement>(".qr").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = parseInt(row.dataset.idx ?? "-1", 10);
      if (idx >= 0 && idx < queue.length) void loadTrack(idx);
    });
  });
}

function refreshDock(): void {
  const total = queue.length;
  const reviewed = countReviewed();
  const allDone = total > 0 && reviewed === total;
  setSession({
    progressLabel: total > 0 ? `${reviewed}/${total} reviewed` : null,
  });
  renderDock(
    allDone
      ? `All ${total} tracks reviewed — ready to apply changes.`
      : `${reviewed} of ${total} reviewed`,
    [
      {
        id: "rv-back",
        label: "Back to results",
        variant: "ghost",
        onClick: () => {
          leaveReview();
          cb?.onBack();
        },
      },
      {
        id: "rv-reset",
        label: "Reset session",
        variant: "danger-ghost",
        onClick: () => void onReset(),
      },
      {
        id: "rv-close",
        label: "Close session",
        variant: "ghost",
        onClick: () => {
          leaveReview();
          cb?.onClose();
        },
      },
      {
        id: "rv-apply",
        label: "Apply All Changes",
        variant: "primary",
        disabled: !allDone,
        onClick: () => openCommitModal(),
      },
    ],
  );
  const rv = id<HTMLElement>("#rv-reviewed");
  if (rv) rv.textContent = `${reviewed} / ${total} reviewed`;
  const qh = document.getElementById("rv-qhead");
  if (qh) qh.textContent = `${total} tracks · ${reviewed} reviewed`;
}

async function onReset(): Promise<void> {
  if (!res) return;
  let confirmed = true;
  try {
    const { showConfirmDialog } = await import("../api.js");
    confirmed = await showConfirmDialog(
      "Reset session?",
      "This deletes staged files and progress for this session. Originals are untouched.",
    );
  } catch {
    confirmed = window.confirm(
      "Reset this session? This deletes staging, ledger, and logs.",
    );
  }
  if (!confirmed) return;
  await resetSession(res.rootPath, res.isSessionDir);
  clearSession();
  leaveReview();
  cb?.onFinish();
}

/* ---------------- read ledger + boot ---------------- */

async function readLedgerAndBoot(): Promise<void> {
  if (!res) return;
  try {
    ledger = JSON.parse(await readLedgerFile(res.ledgerPath)) as Ledger;
  } catch (err) {
    const body = document.getElementById("insp-body");
    if (body) {
      body.innerHTML = `<div class="empty">Ledger failed to load.<br /><span class="sub">${esc(String(err))}</span></div>`;
    }
    return;
  }

  queue = [];
  const files = ledger.files ?? {};
  for (const relPath of Object.keys(files)) {
    const entry = files[relPath];
    const hasDecision = !!entry.decision && entry.decision !== "pending";
    if (
      entry.status !== "committed" &&
      entry.status !== "skipped" &&
      (["downloaded", "unidentified", "not_on_deezer", "download_failed"].includes(entry.status) || hasDecision)
    ) {
      queue.push({
        relPath,
        status: entry.status,
        deezerId: entry.deezer_id as number | null | undefined,
        proxyPath: entry.proxy_path as string | null | undefined,
        bitIdentical: entry.audio_bit_identical as boolean | undefined,
        similarityScore: entry.similarity_score as number | undefined,
      });
    }
  }
  queue.forEach((item) => {
    if (!leFor(item).decision) leFor(item).decision = "pending";
  });

  if (queue.length === 0) {
    const body = document.getElementById("insp-body");
    if (body) {
      body.innerHTML = `<div class="empty">Nothing to review.<br /><span class="sub">No downloads, failures, or pending decisions remain.</span></div>`;
    }
    const why = id<HTMLElement>("#rv-why");
    if (why) why.innerHTML = "<b>No tracks available to review.</b>";
    refreshDock();
    return;
  }

  const firstUndecided = queue.findIndex((item) => decide(item) === "pending");
  currentIndex = firstUndecided >= 0 ? firstUndecided : 0;
  initWaveSurfers();
  renderQueue();
  refreshDock();
  await loadTrack(currentIndex);
  checkWavWarningModal();
}

function checkWavWarningModal(): void {
  if (wavWarningShown) return;
  if (ledger?.output_format?.toLowerCase() !== "wav") return;
  wavWarningShown = true;

  const root = document.createElement("div");
  root.className = "modal-backdrop show";
  root.id = "rv-wav-warning-modal";
  root.innerHTML = `
    <div class="modal" role="dialog" aria-label="WAV Format Warning" style="width:min(500px,92vw)">
      <div class="modal-title" style="color:var(--orange)">WAV Format Warning</div>
      <p class="muted small" style="margin:8px 0 16px;line-height:1.5">
        Warning: WAV files do not reliably support custom ID3 tags. Genre, rating, and comment fields may be dropped by your playback software. Consider using FLAC for lossless quality with full tag support.
      </p>
      <div class="modal-actions">
        <button class="btn primary" id="wav-warning-dismiss">I Understand</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const close = () => root.remove();
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === root || t.closest("#wav-warning-dismiss")) {
      close();
    }
  });
}

export function renderReviewScreen(
  el: HTMLElement,
  source: SourceResolution,
  callbacks: ReviewCallbacks,
): void {
  leaveReview();
  res = source;
  cb = callbacks;
  active = true;
  el.className = "screen on";
  el.innerHTML = workspaceHtml();
  renderUpgraderStage(2);
  renderInspector(`<div class="empty">Reading session ledger…</div>`);
  refreshDock();
  bindDeckButtons(el);
  bindRefetchRow(el);
  void readLedgerAndBoot();
}

export function leaveReview(): void {
  active = false;
  destroyPlayers();
  if (watchdogTimer !== null) {
    window.clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  if (lockInterval !== null) {
    window.clearInterval(lockInterval);
    lockInterval = null;
  }
  document.getElementById("rv-wav-warning-modal")?.remove();
  wavWarningShown = false;
  res = null;
  cb = null;
  ledger = null;
  queue = [];
  currentIndex = -1;
  (Object.keys(expanded) as CatId[]).forEach((k) => (expanded[k] = false));
}

/** Safe teardown for route-level navigation (e.g. leaving the module). */
export function teardownReview(): boolean {
  if (!active) return false;
  leaveReview();
  return true;
}

function destroyPlayers(): void {
  if (wsOrig) {
    try { wsOrig.destroy(); } catch { /* noop */ }
    wsOrig = null;
  }
  if (wsStaged) {
    try { wsStaged.destroy(); } catch { /* noop */ }
    wsStaged = null;
  }
}

function bindDeckButtons(el: HTMLElement): void {
  const play = (deck: DeckId) => {
    el.querySelector<HTMLButtonElement>(`#play-${deck}`)?.addEventListener("click", () => {
      if (deck === "staged" && queue[currentIndex]?.status !== "downloaded") return;
      setFocus(deck);
      togglePlayPause();
    });
  };
  play("original");
  play("staged");

  const setPlayGlyph = (deck: DeckId, playing: boolean): void => {
    const btn = el.querySelector<HTMLButtonElement>(`#play-${deck}`);
    if (btn) btn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  };
  (window as unknown as Record<string, unknown>).__setPlayGlyph = setPlayGlyph;
}

/* ---------------- wavesurfer ---------------- */

function initWaveSurfers(): void {
  destroyPlayers();
  const w = waveSurfer();
  if (!w) return;
  const hasDecode = isWs7();

  wsOrig = w.create({
    container: "#wave-original",
    waveColor: "#8b6a45",
    progressColor: "#ff9500",
    cursorColor: "#ff9500",
    height: 80,
    responsive: true,
    backend: "WebAudio",
    dragToSeek: true,
  });
  wsStaged = w.create({
    container: "#wave-staged",
    waveColor: "#8b6a45",
    progressColor: "#34c759",
    cursorColor: "#34c759",
    height: 80,
    responsive: true,
    backend: "WebAudio",
    dragToSeek: true,
  });

  wsOrig.on("timeupdate", (time) => {
    const t = wsOrig?.getDuration() ?? 0;
    const h = id<HTMLElement>("#rv-o-dur2");
    if (h) h.textContent = `${fmtTime(time as number)} / ${fmtTime(t)}`;
    const ht = id<HTMLElement>("#rv-o-time");
    if (ht) ht.textContent = fmtTime(time as number);
  });
  wsOrig.on("ready", () => {
    const dur = wsOrig?.getDuration() ?? 0;
    const h = id<HTMLElement>("#rv-o-dur");
    if (h) h.textContent = fmtTime(dur);
    const h2 = id<HTMLElement>("#rv-o-dur2");
    if (h2) h2.textContent = `00:00 / ${fmtTime(dur)}`;
    readyState.original.ready = true;
    if (!hasDecode) {
      readyState.original.decode = true;
      window.setTimeout(() => checkUsable("original"), 150);
    } else {
      checkUsable("original");
    }
  });
  if (hasDecode) {
    wsOrig.on("decode", () => {
      readyState.original.decode = true;
      checkUsable("original");
    });
  }
  wsOrig.on("play", () => setGlyph("original", true));
  wsOrig.on("pause", () => setGlyph("original", false));
  wsOrig.on("finish", () => setGlyph("original", false));
  wsOrig.on("error", (err) => {
    console.error("Original WaveSurfer error:", err);
    const lo = id<HTMLElement>("#rv-o-load");
    if (lo) {
      lo.classList.remove("hidden");
      lo.textContent = "Could not load this audio file.";
    }
  });

  wsStaged.on("timeupdate", (time) => {
    const tr = queue[currentIndex];
    if (!tr || tr.status !== "downloaded") return;
    const t = wsStaged?.getDuration() ?? 0;
    const h = id<HTMLElement>("#rv-s-dur2");
    if (h) h.textContent = `${fmtTime(time as number)} / ${fmtTime(t)}`;
    const ht = id<HTMLElement>("#rv-s-time");
    if (ht) ht.textContent = fmtTime(time as number);
  });
  wsStaged.on("ready", () => {
    const tr = queue[currentIndex];
    if (!tr || tr.status !== "downloaded") return;
    const dur = wsStaged?.getDuration() ?? 0;
    const h = id<HTMLElement>("#rv-s-dur");
    if (h) h.textContent = fmtTime(dur);
    const h2 = id<HTMLElement>("#rv-s-dur2");
    if (h2) h2.textContent = `00:00 / ${fmtTime(dur)}`;
    readyState.staged.ready = true;
    if (!hasDecode) {
      readyState.staged.decode = true;
      window.setTimeout(() => checkUsable("staged"), 150);
    } else {
      checkUsable("staged");
    }
  });
  if (hasDecode) {
    wsStaged.on("decode", () => {
      const tr = queue[currentIndex];
      if (!tr || tr.status !== "downloaded") return;
      readyState.staged.decode = true;
      checkUsable("staged");
    });
  }
  wsStaged.on("play", () => setGlyph("staged", true));
  wsStaged.on("pause", () => setGlyph("staged", false));
  wsStaged.on("finish", () => setGlyph("staged", false));
  wsStaged.on("error", (err) => console.error("Staged WaveSurfer error:", err));
}

function setGlyph(deck: DeckId, playing: boolean): void {
  const fn = (window as unknown as Record<string, unknown>).__setPlayGlyph as
    | ((d: DeckId, p: boolean) => void)
    | undefined;
  fn?.(deck, playing);
}

function isUsable(deck: DeckId): boolean {
  return readyState[deck].ready && readyState[deck].decode;
}

function checkUsable(deck: DeckId): void {
  if (!isUsable(deck)) return;
  const btn = id<HTMLButtonElement>(`#play-${deck}`);
  const wav = id<HTMLElement>(`#wave-${deck}`);
  if (deck === "staged" && queue[currentIndex]?.status !== "downloaded") return;
  if (btn) btn.removeAttribute("disabled");
  if (wav) wav.style.pointerEvents = "auto";
  const load = id<HTMLElement>(`#rv-${deck[0]}-load`);
  if (load) load.classList.add("hidden");
  setFocus(deck === "original" ? "original" : "staged");
}

function setFocus(deck: DeckId): void {
  focus = deck;
  id<HTMLElement>("#deck-original")?.classList.toggle("focused", deck === "original");
  id<HTMLElement>("#deck-staged")?.classList.toggle("focused", deck === "staged");
}

function activeWs(): Ws | null {
  return focus === "original" ? wsOrig : wsStaged;
}

function ctxOf(ws: Ws): AudioContext | null {
  // The bundled player exposes the context as a property; real WaveSurfer
  // builds expose getAudioContext(). Support both, tolerate neither.
  const w = ws as unknown as {
    audioContext?: AudioContext | null;
    getAudioContext?: () => AudioContext | null;
  };
  if (w.audioContext) return w.audioContext;
  if (typeof w.getAudioContext === "function") {
    try {
      return w.getAudioContext();
    } catch {
      return null;
    }
  }
  return null;
}

async function playWs(ws: Ws | null): Promise<void> {
  if (!ws) return;
  try {
    const ctx = ctxOf(ws);
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch { /* resume is best-effort; player resumes itself too */ }
    }
    await ws.play();
  } catch (err) {
    console.error("Playback failed:", err);
  }
}

async function playActive(): Promise<void> {
  await playWs(activeWs());
}

function togglePlayPause(): void {
  const ws = activeWs();
  if (!ws) return;
  if (ws.isPlaying()) ws.pause();
  else void playActive();
}

/* ---------------- track loading & decisions ---------------- */

async function loadTrack(index: number): Promise<void> {
  if (index < 0 || index >= queue.length) return;
  currentIndex = index;
  // Stop previous audio and reset both playheads to zero first: the
  // player's position otherwise survives into the new track (stale
  // progress overlay + time readout until the new decode lands).
  try { wsOrig?.stop(); } catch { /* player may be empty */ }
  try { wsStaged?.stop(); } catch { /* player may be empty */ }
  const track = queue[index];
  const le = leFor(track);

  const cat = getItemCategory(track);
  if (!expanded[cat]) {
    (Object.keys(expanded) as CatId[]).forEach((k) => (expanded[k] = false));
    expanded[cat] = true;
    renderQueue();
  }
  highlightActive();
  scrollActiveIntoView();

  readyState.original.ready = false;
  readyState.original.decode = false;
  readyState.staged.ready = false;
  readyState.staged.decode = false;

  const playO = id<HTMLButtonElement>("#play-original");
  const playS = id<HTMLButtonElement>("#play-staged");
  playO?.setAttribute("disabled", "true");
  playS?.setAttribute("disabled", "true");
  const wavO = id<HTMLElement>("#wave-original");
  const wavS = id<HTMLElement>("#wave-staged");
  if (wavO) wavO.style.pointerEvents = "none";
  if (wavS) wavS.style.pointerEvents = "none";
  const lo = id<HTMLElement>("#rv-o-load");
  const ls = id<HTMLElement>("#rv-s-load");
  if (lo) {
    lo.classList.remove("hidden");
    lo.textContent = "Loading original audio…";
  }
  [["#rv-o-dur2", "00:00"], ["#rv-o-time", "00:00"]].forEach(([sel, txt]) => {
    const h = id<HTMLElement>(sel);
    if (h) h.textContent = txt;
  });

  if (wsStaged?.empty) wsStaged.empty();
  [["#rv-s-dur", "-"], ["#rv-s-dur2", "--:--"], ["#rv-s-time", "--:--"], ["#rv-s-fmt", "—"]].forEach(([sel, txt]) => {
    const h = id<HTMLElement>(sel);
    if (h) h.textContent = txt;
  });

  // header
  const name = filenameOf(track.relPath);
  const on = id<HTMLElement>("#rv-o-name");
  if (on) on.textContent = name;
  const sn = id<HTMLElement>("#rv-s-name");
  const hasMeta = hasShazamMeta(track);
  if (track.status === "downloaded") {
    sn && (sn.textContent = `${le.artist ?? "Known"} — ${le.title ?? "upgrade"}`);
  } else if (hasMeta) {
    let status = "Identified, not on Deezer";
    if (track.status === "download_failed") status = `Download failed — ID ${track.deezerId ?? "?"}`;
    sn && (sn.textContent = `${le.title} (${status})`);
  } else {
    sn && (sn.textContent = "No upgrade");
  }

  // feedback + refetch pre-fill
  const input = id<HTMLInputElement>("#rv-deezer-id");
  if (input) input.value = track.deezerId ? String(track.deezerId) : "";
  const fb = id<HTMLElement>("#rv-feedback");
  if (fb) fb.textContent = "";
  const refetchRow = id<HTMLElement>("#rv-refetch-row");
  if (refetchRow) refetchRow.classList.toggle("hidden", track.status === "downloaded");

  // why + badge
  const why = id<HTMLElement>("#rv-why");
  if (why) why.innerHTML = whyText(track);

  // original path
  const originalAbs =
    (le.original_abs_path as string | undefined) ?? joinPath(res?.rootPath ?? "", track.relPath);
  const origExt = track.relPath.split(".").pop()?.toLowerCase() ?? "";
  const ofmt = id<HTMLElement>("#rv-o-format");
  const ofmtFl = id<HTMLElement>("#rv-o-fmt");
  if (ofmt) ofmt.textContent = origExt.toUpperCase() || "—";
  if (ofmtFl) ofmtFl.textContent = origExt.toUpperCase() || "—";
  id<HTMLElement>("#rv-o-file") && (id<HTMLElement>("#rv-o-file")!.textContent = name);
  const oBitrate = le.original_bitrate as number | undefined;
  const obt = id<HTMLElement>("#rv-o-bitrate");
  if (obt) {
    obt.textContent = isLosslessExt(track.relPath)
      ? "lossless"
      : oBitrate
        ? `${oBitrate} kbps`
        : "—";
  }
  id<HTMLElement>("#rv-o-size") && (id<HTMLElement>("#rv-o-size")!.textContent = fmtBytes(null));
  void getFileSize(originalAbs).then((sz) => {
    const h = id<HTMLElement>("#rv-o-size");
    if (h && typeof sz === "number") h.textContent = fmtBytes(sz);
  }).catch(() => undefined);

  if (wsOrig?.load && isTauri()) {
    try {
      void wsOrig.load(convertFileSrc(originalAbs));
    } catch (err) {
      if (lo) lo.textContent = `Error loading original: ${err}`;
    }
  }
  // Watchdog: if the player never reports ready for THIS track (silent
  // fetch/decode stall), retry the load once instead of leaving the
  // play buttons dead.
  if (watchdogTimer !== null) {
    window.clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  watchdogRetried = false;
  const myIndex = index;
  const myOriginalUrl = isTauri() ? convertFileSrc(originalAbs) : "";
  let myStagedUrl = "";

  if (track.status === "downloaded") {
    if (ls) {
      ls.classList.remove("hidden");
      ls.textContent = "Loading upgrade audio…";
    }
    playS?.removeAttribute("disabled");

    const stagedRel = (le.proxy_path as string | undefined) || (le.staged_path as string | undefined);
    const stagedAbs = stagedRel
      ? stagedRel.startsWith("/") || stagedRel.includes(":")
        ? stagedRel
        : `${res?.rootPath ?? ""}/${stagedRel}`
      : "";
    myStagedUrl = stagedAbs && isTauri() ? convertFileSrc(stagedAbs) : "";
    if (stagedAbs && wsStaged?.load && isTauri()) {
      try {
        void wsStaged.load(convertFileSrc(stagedAbs));
      } catch (err) {
        if (ls) ls.textContent = `Error loading upgrade: ${err}`;
      }
    }
    id<HTMLElement>("#rv-s-file") && (id<HTMLElement>("#rv-s-file")!.textContent = filenameOf(le.staged_path as string ?? ""));
    const sFmt = filenameOf(le.staged_path as string ?? "").split(".").pop()?.toUpperCase() ?? "—";
    id<HTMLElement>("#rv-s-format")!.textContent = sFmt;
    const sFmtFl = id<HTMLElement>("#rv-s-fmt");
    if (sFmtFl) sFmtFl.textContent = sFmt;
    const sBitrate = le.staged_bitrate as number | undefined;
    const sbt = id<HTMLElement>("#rv-s-bitrate");
    if (sbt) {
      sbt.textContent = isLosslessExt(le.staged_path as string ?? "")
        ? "lossless"
        : sBitrate
          ? `${sBitrate} kbps`
          : "—";
    }
    if (stagedAbs) {
      void getFileSize(stagedAbs).then((sz) => {
        const h = id<HTMLElement>("#rv-s-size");
        if (h && typeof sz === "number") h.textContent = fmtBytes(sz);
      }).catch(() => undefined);
    }
    setFocus("original");
  } else {
    if (ls) {
      ls.classList.remove("hidden");
      ls.textContent = unresolvedReason(track);
    }
    setFocus("original");
  }

  watchdogTimer = window.setTimeout(() => {
    watchdogTimer = null;
    if (!active || !res || currentIndex !== myIndex || watchdogRetried) return;
    const needOrig = myOriginalUrl && !readyState.original.ready;
    const needStaged =
      myStagedUrl && track.status === "downloaded" && !readyState.staged.ready;
    if (!needOrig && !needStaged) return;
    watchdogRetried = true;
    try {
      if (needOrig && wsOrig) void wsOrig.load(myOriginalUrl);
      if (needStaged && wsStaged) void wsStaged.load(myStagedUrl);
    } catch { /* error listeners surface load failures */ }
  }, 8000);

  highlightActive();
  refreshDock();
}

function highlightActive(): void {
  document.querySelectorAll<HTMLElement>("#insp-body .qr").forEach((row) => {
    row.classList.toggle("on", parseInt(row.dataset.idx ?? "-1", 10) === currentIndex);
  });
}

function scrollActiveIntoView(): void {
  const rows = document.querySelectorAll<HTMLElement>("#insp-body .qr");
  rows.forEach((row) => {
    if (parseInt(row.dataset.idx ?? "-1", 10) === currentIndex) {
      row.scrollIntoView({ block: "nearest" });
    }
  });
}

function getNextInCategory(fromIndex: number): number {
  const current = queue[fromIndex];
  if (!current) return -1;
  const cat = getItemCategory(current);
  const candidates: number[] = [];
  queue.forEach((item, idx) => {
    if (idx === fromIndex) return;
    if (getItemCategory(item) !== cat) return;
    if (decide(item) === "pending") candidates.push(idx);
  });
  if (candidates.length === 0) return -1;
  const after = candidates.find((i) => i > fromIndex);
  return after !== undefined ? after : candidates[candidates.length - 1];
}

async function saveDecision(relPath: string, decision: string): Promise<void> {
  const le = leFor({ relPath } as ReviewItem);
  le.decision = decision;
  if (!res) return;
  void saveLedgerDecision(res.ledgerPath, relPath, decision).catch((err) =>
    console.error("Failed to save ledger decision:", err),
  );
}

function pauseAll(): void {
  if (wsOrig) wsOrig.pause();
  if (wsStaged) wsStaged.pause();
  const setGlyph = (window as unknown as Record<string, unknown>).__setPlayGlyph as
    | ((deck: DeckId, playing: boolean) => void)
    | undefined;
  if (setGlyph) {
    setGlyph("original", false);
    setGlyph("staged", false);
  }
}

async function approveCurrent(): Promise<void> {
  const track = queue[currentIndex];
  if (!track) return;
  const d = track.status === "downloaded" || hasShazamMeta(track) ? "approved" : "skipped";
  await saveDecision(track.relPath, d);
  pauseAll();
  updateQueueRow(currentIndex);
  refreshDock();
  const next = getNextInCategory(currentIndex);
  if (next !== -1) await loadTrack(next);
  else scrollActiveIntoView();
}

async function skipCurrent(): Promise<void> {
  const track = queue[currentIndex];
  if (!track) return;
  await saveDecision(track.relPath, "skipped");
  pauseAll();
  updateQueueRow(currentIndex);
  refreshDock();
  const next = getNextInCategory(currentIndex);
  if (next !== -1) await loadTrack(next);
  else scrollActiveIntoView();
}

async function clearCategory(cat: CatId, approve: boolean): Promise<void> {
  let changed = false;
  for (const item of queue) {
    if (getItemCategory(item) !== cat) continue;
    if (decide(item) !== "pending") continue;
    let d: string;
    if (approve) d = item.status === "downloaded" || hasShazamMeta(item) ? "approved" : "skipped";
    else d = "skipped";
    await saveDecision(item.relPath, d);
    changed = true;
  }
  if (!changed) return;
  pauseAll();
  renderQueue();
  refreshDock();
  if (currentIndex !== -1) await loadTrack(currentIndex);
}

/* ---------------- manual identify / refetch ---------------- */

function showFeedback(text: string, color: "ok" | "warn" | "err"): void {
  const fb = id<HTMLElement>("#rv-feedback");
  if (!fb) return;
  fb.textContent = text;
  fb.style.color =
    color === "ok" ? "var(--green)" : color === "warn" ? "var(--orange)" : "var(--red)";
  window.setTimeout(() => { if (fb.textContent === text) fb.textContent = ""; }, 4000);
}

function bindRefetchRow(el: HTMLElement): void {
  el.querySelector("#rv-identify")?.addEventListener("click", () => void onIdentify());
  el.querySelector("#rv-refetch")?.addEventListener("click", () => void onRefetch());
  el.querySelector<HTMLInputElement>("#rv-deezer-id")?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).blur();
      void onRefetch();
    }
  });
}

async function onIdentify(): Promise<void> {
  const track = queue[currentIndex];
  if (!track || !res) return;
  const btn = id<HTMLButtonElement>("#rv-identify");
  const orig = btn?.textContent ?? "";
  if (btn) { btn.disabled = true; btn.textContent = "Identifying…"; }
  try {
    const result = JSON.parse(await identifyTrack(res.rootPath, track.relPath)) as {
      artist?: string;
      title?: string;
      deezer_id?: number | string;
    };
    if (result.artist || result.title) {
      ledgSet(track, "artist", result.artist ?? null);
      ledgSet(track, "title", result.title ?? null);
      if (result.deezer_id) {
        ledgSet(track, "deezer_id", Number(result.deezer_id));
        track.deezerId = Number(result.deezer_id);
        const input = id<HTMLInputElement>("#rv-deezer-id");
        if (input) input.value = String(result.deezer_id);
        showFeedback("✓ Found on Deezer", "ok");
      } else {
        ledgSet(track, "status", "not_on_deezer");
        track.status = "not_on_deezer";
        showFeedback("⚠ Not on Deezer", "warn");
      }
      renderQueue();
      await loadTrack(currentIndex);
    } else {
      showFeedback("✗ Not identified", "err");
    }
  } catch (err) {
    const msg = String(err);
    showFeedback(msg.includes("unidentified") ? "✗ Not identified" : `✗ ${msg}`, "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

function ledgSet(item: ReviewItem, key: string, value: unknown): void {
  const le = leFor(item);
  (le as Record<string, unknown>)[key] = value;
}

async function onRefetch(): Promise<void> {
  const track = queue[currentIndex];
  if (!track || !res) return;
  const input = id<HTMLInputElement>("#rv-deezer-id");
  const raw = input?.value.trim() ?? "";
  if (!/^\d+$/.test(raw)) {
    showFeedback("Enter a numeric Deezer ID", "warn");
    return;
  }
  const targetId = parseInt(raw, 10);
  const le = leFor(track);
  const artist = (le.artist as string | undefined) ?? "Unknown Artist";
  const title = (le.title as string | undefined) ?? "Unknown Title";

  const btn = id<HTMLButtonElement>("#rv-refetch");
  const orig = btn?.textContent ?? "";
  if (btn) { btn.disabled = true; btn.textContent = "Fetching…"; }

  const prevSim = le.similarity_score;
  const prevBit = le.audio_bit_identical;
  ledgSet(track, "similarity_score", undefined);
  ledgSet(track, "audio_bit_identical", undefined);
  renderQueue();

  try {
    const result = JSON.parse(
      await downloadTrackById(
        res.rootPath,
        ledger?.output_format ?? "flac",
        track.relPath,
        targetId,
        artist,
        title,
      ),
    ) as Record<string, unknown>;

    ledgSet(track, "status", "downloaded");
    ledgSet(track, "deezer_id", targetId);
    ledgSet(track, "staged_path", result.staged_path ?? null);
    ledgSet(track, "proxy_path", result.proxy_path ?? null);
    ledgSet(track, "staged_bitrate", result.staged_bitrate ?? null);
    if (typeof result.artist === "string") ledgSet(track, "artist", result.artist);
    if (typeof result.title === "string") ledgSet(track, "title", result.title);
    ledgSet(track, "decision", "pending");
    ledgSet(track, "similarity_score",
      typeof result.similarity_score === "number" ? result.similarity_score : undefined);
    ledgSet(track, "audio_bit_identical",
      typeof result.audio_bit_identical === "boolean" ? result.audio_bit_identical : false);

    track.status = "downloaded";
    track.deezerId = targetId;
    track.proxyPath = (result.proxy_path as string | null | undefined) ?? null;

    const newCat = getItemCategory(track);
    (Object.keys(expanded) as CatId[]).forEach((k) => (expanded[k] = false));
    expanded[newCat] = true;

    renderQueue();
    refreshDock();
    await loadTrack(currentIndex);

    // re-read ledger so persisted similarity flows into the UI
    ledgSetFromDisk(track.relPath);
    renderQueue();
    await loadTrack(currentIndex);
    showFeedback("✓ Downloaded", "ok");
  } catch (err) {
    ledgSet(track, "similarity_score", prevSim);
    ledgSet(track, "audio_bit_identical", prevBit);
    renderQueue();
    showFeedback(`✗ ${err}`, "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

async function ledgSetFromDisk(relPath: string): Promise<void> {
  if (!res) return;
  try {
    ledger = JSON.parse(await readLedgerFile(res.ledgerPath)) as Ledger;
    const entry = queue.find((i) => i.relPath === relPath);
    if (entry) {
      const le = leFor(entry);
      entry.bitIdentical = le.audio_bit_identical as boolean | undefined;
      entry.similarityScore = le.similarity_score as number | undefined;
    }
  } catch { /* keep in-memory */ }
}

/* ---------------- commit ---------------- */

function openCommitModal(): void {
  if (!res || !ledger) return;
  renderUpgraderStage(3);

  const root = document.createElement("div");
  root.className = "modal-backdrop show";
  const isDb = res.sourceKind === "db";
  const isXml = res.sourceKind === "xml" && !!res.xmlPath;

  const defaultSuggestion = suggestedDestPath(res.rootPath);

  root.innerHTML = `
    <div class="modal" role="dialog" aria-label="Apply changes">
      <div class="modal-title">Apply All Changes</div>
      <p class="muted small" style="margin:0">
        Approved pairs copy to the library; skipped tracks keep their originals. Choose how files are placed on disk and whether Rekordbox paths are updated.
      </p>
      <div class="isec" style="margin:0">
        <h4>Output strategy</h4>
        <label class="opt">
          <input type="radio" class="chk" name="commit-output-strategy" value="replace" checked />
          <span class="of">Replace in library<span class="ob">Overwrites original files in place with the upgraded copy. Rekordbox paths stay valid.</span></span>
        </label>
        <label class="opt">
          <input type="radio" class="chk" name="commit-output-strategy" value="custom" />
          <span class="of">Consolidate to folder<span class="ob">Copies the final library (approved upgrades + retained originals) into a chosen output folder. Rekordbox paths are rewritten to it.</span></span>
        </label>
        <div class="frow hidden" id="commit-destination-container" style="margin-top:8px">
          <input class="field" id="commit-destination-input" readonly placeholder="Choose output folder…" value="${escAttr(defaultSuggestion)}" />
          <button class="btn sm" id="commit-destination-browse-btn">Choose…</button>
        </div>
      </div>
      <div class="isec" style="margin:0">
        <h4>Rekordbox</h4>
        <label class="opt">
          <input type="radio" class="chk" name="commit-rekordbox-action" value="db" ${isDb ? "checked" : "disabled"} />
          <span class="of">Update database directly<span class="ob">Syncs rewritten track paths straight into master.db. Only available when the source is the live database.</span></span>
        </label>
        ${isXml ? `
        <label class="opt">
          <input type="radio" class="chk" name="commit-rekordbox-action" value="xml" checked />
          <span class="of">Export upgraded XML<span class="ob">Generates a new Rekordbox XML with updated track paths and lossless audio specs.</span></span>
        </label>` : ""}
        <label class="opt">
          <input type="radio" class="chk" name="commit-rekordbox-action" value="none" ${isDb || isXml ? "" : "checked"} />
          <span class="of">Leave Rekordbox alone<span class="ob">Files move on disk; Rekordbox is not touched.</span></span>
        </label>
        <p class="muted small" style="margin:8px 0 0;font-size:11px">ℹ Cue points, hot cues, beatgrids, and playlists are preserved. (If a new master differs in silence lead-in, beatgrid alignment can be fine-tuned in Rekordbox).</p>
        <p id="commit-rekordbox-lock-warning" class="warn-text hidden" style="margin:6px 0 0">Rekordbox is running. Close it before updating the database, or choose “Leave Rekordbox alone”.</p>
      </div>
      <div class="modal-actions">
        <button class="btn" id="commit-config-cancel">Cancel</button>
        <button class="btn primary" id="commit-config-confirm">Apply</button>
      </div>
    </div>`;

  document.body.appendChild(root);

  const destContainer = () =>
    root.querySelector<HTMLElement>("#commit-destination-container");
  const destInput = () =>
    root.querySelector<HTMLInputElement>("#commit-destination-input");
  const confirmBtn = () =>
    root.querySelector<HTMLButtonElement>("#commit-config-confirm");
  const warningEl = () =>
    root.querySelector<HTMLElement>("#commit-rekordbox-lock-warning");
  const rbAction = () =>
    (root.querySelector<HTMLInputElement>('input[name="commit-rekordbox-action"]:checked')?.value ?? "none");

  const close = () => {
    if (lockInterval !== null) {
      window.clearInterval(lockInterval);
      lockInterval = null;
    }
    root.remove();
  };

  const updateLockWarning = async () => {
    const runDb = rbAction() === "db" && isDb;
    if (runDb) {
      const status = await checkRekordboxStatus().catch(() => null);
      if (status?.running) {
        warningEl()?.classList.remove("hidden");
        confirmBtn()?.setAttribute("disabled", "true");
        return;
      }
    }
    warningEl()?.classList.add("hidden");
    confirmBtn()?.removeAttribute("disabled");
  };

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === root) { close(); return; }
    if (t.closest("#commit-config-cancel")) { close(); return; }
    if (t.closest("#commit-destination-browse-btn")) {
      void (async () => {
        const picked = await selectOutputDirectory(destInput()?.value).catch(() => null);
        if (picked && destInput()) destInput()!.value = picked;
      })();
    }
    if (t.closest("#commit-config-confirm")) {
      void runCommit(close);
    }
  });
  root.querySelectorAll<HTMLInputElement>('input[name="commit-output-strategy"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      destContainer()?.classList.toggle("hidden", radio.value === "replace");
    });
  });
  root.querySelectorAll<HTMLInputElement>('input[name="commit-rekordbox-action"]').forEach((radio) => {
    radio.addEventListener("change", () => void updateLockWarning());
  });

  void updateLockWarning();
  lockInterval = window.setInterval(() => void updateLockWarning(), 1000);

  function escAttr(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }
}

function suggestedDestPath(rootPath: string): string {
  const parts = rootPath.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  const folder = rootPath.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  if (parts.length > 0 && folder) return `${parts.join("/")}/${folder}-upgraded`;
  return "";
}

async function runCommit(closeModal: () => void): Promise<void> {
  if (!res || !ledger) return;
  const strategyEl = document.querySelector<HTMLInputElement>(
    'input[name="commit-output-strategy"]:checked',
  );
  const strategy = strategyEl?.value ?? "replace";
  const destEl = document.querySelector<HTMLInputElement>("#commit-destination-input");
  const outputPath = strategy === "replace" ? "" : (destEl?.value.trim() ?? "");
  if (strategy !== "replace" && !outputPath) {
    destContainerWarning();
    return;
  }
  const rbAction = document.querySelector<HTMLInputElement>(
    'input[name="commit-rekordbox-action"]:checked',
  )?.value ?? "none";

  closeModal();
  const backdrop = showCommitResults();

  const decisions: Record<string, string> = {};
  queue.forEach((item) => {
    decisions[item.relPath] = decide(item) || "skipped";
  });

  let commitResult: { committed: number; skipped: number; failed: Array<{ relPath: string; error: string }> } | null = null;
  let exportedXmlPath: string | null = null;
  try {
    setCommitStatus(backdrop, "Applying high-quality replacements to your library files. Please do not close the app.");
    commitResult = await commitChanges(res.ledgerPath, decisions, outputPath, strategy);

    if (rbAction === "db" && res.sourceKind === "db") {
      setCommitStatus(backdrop, "Updating Rekordbox library directly…");
      await updateRekordboxDbDirectly(res.ledgerPath, decisions, outputPath, strategy);
    } else if (rbAction === "xml" && res.sourceKind === "xml" && res.xmlPath) {
      setCommitStatus(backdrop, "Exporting upgraded Rekordbox XML…");
      exportedXmlPath = await updateRekordboxXml(res.xmlPath, res.ledgerPath, decisions);
    }

    renderCommitResult(
      backdrop,
      commitResult.committed,
      commitResult.skipped,
      commitResult.failed,
      rbAction === "db" && res.sourceKind === "db",
      undefined,
      exportedXmlPath,
    );
  } catch (err) {
    const committed = commitResult ? commitResult.committed : 0;
    const skipped = commitResult ? commitResult.skipped : 0;
    const failed = commitResult ? commitResult.failed : [];
    renderCommitResult(backdrop, committed, skipped, failed, false, `Error during commit: ${err}`);
  }
}

function destContainerWarning(): void {
  const dest = document.getElementById("commit-destination-input");
  if (!dest) return;
  dest.style.borderColor = "var(--red)";
  window.setTimeout(() => dest.removeAttribute("style"), 2500);
}

function showCommitResults(): HTMLElement {
  removeAnyResultsModal();
  const root = document.createElement("div");
  root.className = "modal-backdrop show";
  root.id = "rv-commit-results";
  root.innerHTML = `
    <div class="modal" style="width:min(620px,92vw)">
      <div class="modal-title" id="rv-commit-title">Committing Upgrades</div>
      <div id="rv-commit-body">
        <div style="text-align:center;padding:22px 0">
          <div class="spinner"></div>
          <p id="rv-commit-loading" class="muted small" style="margin-top:12px">Preparing…</p>
        </div>
      </div>
      <div class="modal-actions hidden" id="rv-commit-actions">
        <button class="btn primary" id="rv-commit-close">Done</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  return root;
}

function removeAnyResultsModal(): void {
  document.getElementById("rv-commit-results")?.remove();
}

function setCommitStatus(root: HTMLElement, text: string): void {
  const el = root.querySelector<HTMLElement>("#rv-commit-loading");
  if (el) el.textContent = text;
}

function renderCommitResult(
  root: HTMLElement,
  committed: number,
  skipped: number,
  failed: Array<{ relPath: string; error: string }>,
  dbUpdated: boolean,
  error?: string,
  xmlExportPath?: string | null,
): void {
  const title = root.querySelector<HTMLElement>("#rv-commit-title");
  const body = root.querySelector<HTMLElement>("#rv-commit-body");
  const actions = root.querySelector<HTMLElement>("#rv-commit-actions");
  if (title) {
    title.textContent = error ? "Commit Issue" : "✔ Upgrades Applied";
    title.style.color = error ? "var(--red)" : "var(--green)";
  }
  if (body) {
    if (error) {
      body.innerHTML = `
        <div class="danger-text" style="font-family:var(--mono);font-size:12px;padding:10px;background:var(--red-bg);border:1px solid var(--red);border-radius:6px;margin-bottom:12px">${esc(error)}</div>
        ${committed > 0 ? `<p class="muted small" style="margin-bottom:8px">${committed} track(s) were replaced on disk, but Rekordbox sync failed. Your progress ledger is safely preserved so no work is lost.</p>` : "<p class=\"muted small\">Your session ledger has been preserved.</p>"}
      `;
    } else {
      body.innerHTML = `
        <div class="stats" style="margin-top:4px">
          <div class="stat"><div class="v">${committed}</div><div class="l">Committed</div></div>
          <div class="stat"><div class="v">${skipped}</div><div class="l">Skipped</div></div>
          <div class="stat"><div class="v">${failed.length}</div><div class="l">Failed</div></div>
        </div>
        ${dbUpdated ? `<p class="ok-text small" style="margin:10px 0 0">Rekordbox library updated successfully.</p>` : ""}
        ${xmlExportPath ? `<p class="ok-text small" style="margin:10px 0 0">Upgraded Rekordbox XML exported to:<br /><code style="font-family:var(--mono);font-size:11px;word-break:break-all">${esc(xmlExportPath)}</code></p>` : ""}
        ${failed.length > 0 ? `
          <div style="max-height:140px;overflow:auto;margin-top:12px;padding:10px 12px;background:var(--red-bg);border:1px solid var(--line2);border-radius:6px">
            <p class="danger-text small" style="margin:0 0 6px">Commit failures</p>
            ${failed.map((f) => `<div style="font-family:var(--mono);font-size:11px;color:var(--red);margin-bottom:5px"><b>${esc(f.relPath)}</b>: ${esc(f.error)}</div>`).join("")}
          </div>
        ` : ""}`;
    }
  }
  actions?.classList.remove("hidden");
  const closeBtn = root.querySelector<HTMLButtonElement>("#rv-commit-close");
  if (closeBtn) {
    if (error) closeBtn.textContent = "Close (Keep Session)";
    closeBtn.addEventListener("click", () => {
      root.remove();
      if (error) {
        // Do not wipe the ledger on failure — leave review or let user retry
        leaveReview();
        cb?.onClose();
      } else {
        void finishSession();
      }
    });
  }
}

async function finishSession(): Promise<void> {
  if (!res) return;
  try {
    await resetSession(res.rootPath, res.isSessionDir);
  } catch (err) {
    console.error("Failed to delete ledger on finish:", err);
  }
  clearSession();
  leaveReview();
  cb?.onFinish();
}

/* ---------------- global keyboard ---------------- */

function anyModalOpen(): boolean {
  return document.querySelectorAll(".modal-backdrop.show").length > 0;
}

window.addEventListener("keydown", (e) => {
  if (!active) return;
  if (!res || !ledger) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
  if (anyModalOpen()) return;
  if (e.key === "Enter") e.preventDefault();
  if (currentIndex < 0 || currentIndex >= queue.length) return;

  const track = queue[currentIndex];
  switch (e.key) {
    case " ":
      e.preventDefault();
      if (track.status === "downloaded") togglePlayPause();
      else if (wsOrig) {
        if (wsOrig.isPlaying()) wsOrig.pause();
        else void playWs(wsOrig);
      }
      break;
    case "ArrowUp":
      e.preventDefault();
      if (track.status === "downloaded") setFocus("original");
      break;
    case "ArrowDown":
      e.preventDefault();
      if (track.status === "downloaded") setFocus("staged");
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekHand(track, -(e.metaKey || e.ctrlKey ? 20 : 5));
      break;
    case "ArrowRight":
      e.preventDefault();
      seekHand(track, e.metaKey || e.ctrlKey ? 20 : 5);
      break;
    case "Enter":
      e.preventDefault();
      if (track.status === "downloaded" || hasShazamMeta(track)) void approveCurrent();
      break;
    case "Backspace":
      e.preventDefault();
      void skipCurrent();
      break;
  }
});

window.addEventListener("blur", () => {
  if (!active) return;
  pauseAll();
});

function seekHand(track: ReviewItem, sec: number): void {
  const ws = track.status === "downloaded" ? activeWs() : wsOrig;
  if (!ws) return;
  const media = ws.getMediaElement();
  const dur = media?.duration ?? ws.getDuration();
  const next = Math.max(0, Math.min(dur, ws.getCurrentTime() + sec));
  ws.setTime(next);
}