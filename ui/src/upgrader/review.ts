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
  resolveDeezerLink,
} from "../api.js";
import { clearSession, getSession, setSession, updateSession } from "../store.js";
import {
  renderDock,
  renderInspector,
  renderUpgraderStage,
} from "../chrome.js";
import {
  esc,
  extractDeezerTrackId,
  isPotentialDeezerUrl,
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
  offset_ms?: number | null;
  is_transcode?: boolean | null;
  orig_rms?: number | null;
  staged_rms?: number | null;
}

export interface ReviewCallbacks {
  onBack: () => void;
  onFinish: () => void;
  onClose: () => void;
}

interface Ws {
  destroy(): void;
  empty(): void;
  load(url: string, peaks?: number[] | number[][], duration?: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seekTo(fraction: number): void;
  setTime(t: number): void;
  setVolume?(volume: number): void;
  getVolume?(): number;
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
let linkedScrub = false;
let matchGain = false;
let isSyncingSeek = false;
let decisionHistory: Array<{ index: number; prevDecision: string }> = [];

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
  let baseWhy = "";
  const pct = matchPct(item);
  const bit = item.bitIdentical ?? leFor(item).audio_bit_identical;
  if (bit) {
    baseWhy = "Bit-for-bit identical audio. <b>100% match</b> — safe to approve.";
  } else if (typeof pct === "number" && pct >= 90) {
    baseWhy = `Acoustic fingerprint matches at <b>${pct}%</b> — almost certainly the same mix.`;
  } else if (typeof pct === "number" && pct >= 75) {
    baseWhy = `<b>${pct}% match</b> — same energy, possibly a different master. Listen closely.`;
  } else if (typeof pct === "number") {
    baseWhy = `<b>${pct}% match</b> — under 75%. Verify: this may be a different recording.`;
  } else {
    const simErr = (leFor(item).similarity_error as string | undefined);
    if (simErr) {
      baseWhy = `<b>Acoustic comparison failed</b> (${esc(simErr)}). Verify manually by listening.`;
    } else {
      baseWhy = "Similarity not computed for this pair.";
    }
  }

  const le = leFor(item);
  const offset = item.offset_ms ?? (le.offset_ms as number | null | undefined);
  const isTranscode = item.is_transcode ?? (le.is_transcode as boolean | null | undefined);

  let badges = "";
  if (offset !== undefined && offset !== null) {
    const offsetStr = offset === 0 ? "0 ms aligned" : (offset > 0 ? `Offset: +${offset} ms` : `Offset: ${offset} ms`);
    badges += ` <span class="badge" style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15);" title="Acoustic lead-in delta (Δt)">${offsetStr}</span>`;
  }
  if (isTranscode) {
    badges += ` <span class="badge warn" style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; background:rgba(255,159,10,0.15); color:var(--accent-orange, #ff9f0a); border:1px solid rgba(255,159,10,0.3);" title="Spek Guard detected brickwall lowpass cutoff ~16 kHz in original file">⚠ Fake Lossless</span>`;
  }

  return baseWhy + badges;
}

function statusBadge(item: ReviewItem): string {
  const d = decide(item);
  const pct = matchPct(item);
  const hasCalcErr = !item.bitIdentical && pct === null && Boolean(leFor(item).similarity_error);

  if (d === "approved") {
    if (pct !== null) return `<span class="sc approved" title="Approved (Will upgrade)">✓ ${pct}%</span>`;
    if (hasCalcErr) return `<span class="sc approved" title="Approved (Acoustic check failed)">✓ ⚠</span>`;
    return `<span class="sc approved" title="Approved">✓</span>`;
  }
  if (d === "skipped") {
    if (pct !== null) return `<span class="sc n skipped" title="Skipped (Keep original)">– ${pct}%</span>`;
    if (hasCalcErr) return `<span class="sc n skipped" title="Skipped (Acoustic check failed)">– ⚠</span>`;
    return `<span class="sc n skipped" title="Skipped (Keep original)">–</span>`;
  }

  // Pending decision:
  if (pct !== null) {
    if (pct >= 90) return `<span class="sc" title="Pending: ${pct}% match">${pct}%</span>`;
    if (pct >= 75) return `<span class="sc w" title="Pending: ${pct}% match">${pct}%</span>`;
    return `<span class="sc b" title="Pending: ${pct}% match">${pct}%</span>`;
  }
  if (hasCalcErr) {
    return `<span class="sc w" title="Acoustic check failed: ${esc(String(leFor(item).similarity_error))}">⚠ Calc</span>`;
  }
  return `<span class="sc n" title="Pending review">…</span>`;
}

function updateDecisionPill(track: ReviewItem): void {
  const pill = id<HTMLElement>("#rv-decision-pill");
  if (!pill) return;
  const d = decide(track);
  if (d === "approved") {
    pill.className = "decision-pill approved";
    pill.textContent = track.status === "downloaded" ? "✓ Approved · Will upgrade" : "✓ Approved · Keep original";
  } else if (d === "skipped") {
    pill.className = "decision-pill skipped";
    pill.textContent = "– Skipped · Keep original";
  } else {
    pill.className = "decision-pill pending";
    pill.textContent = "● Pending decision";
  }
}

/* ---------------- screen ---------------- */

function headMetaHtml(): string {
  return `
    <div class="diff">
      <span class="why" id="rv-why">Loading…</span>
      <div class="decision-actions">
        <button class="decision-btn approve" id="rv-btn-approve" title="Approve upgrade (Enter)">✓ Approve</button>
        <button class="decision-btn skip" id="rv-btn-skip" title="Skip upgrade (Backspace)">✕ Skip</button>
        <span class="decision-pill pending" id="rv-decision-pill">● Pending decision</span>
        <button class="link-btn small" id="rv-override-toggle" title="Override match with Deezer URL or track ID" style="display:none">Wrong match? Paste Deezer URL</button>
      </div>
    </div>
    <div class="frow hidden" id="rv-refetch-row">
      <button class="btn sm" id="rv-identify">Identify</button>
      <input class="field" id="rv-deezer-id" placeholder="Deezer URL or ID…" autocomplete="off" />
      <button class="btn sm" id="rv-refetch">Refetch</button>
      <span class="kb" id="rv-feedback"></span>
    </div>
    <div class="sect" style="padding:8px 14px">
      <h3>File comparison</h3>
      <div class="kvr"><span class="v" id="rv-o-file">–</span><span class="k">File</span><span class="v n" id="rv-s-file">–</span></div>
      <div class="kvr" id="rv-row-artist"><span class="v" id="rv-o-artist">–</span><span class="k">Artist / Title</span><span class="v n" id="rv-s-artist">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-size">–</span><span class="k">Size</span><span class="v n" id="rv-s-size">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-format">–</span><span class="k">Format</span><span class="v n" id="rv-s-format">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-bitrate">–</span><span class="k">Bitrate</span><span class="v n" id="rv-s-bitrate">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-dur">–</span><span class="k">Time</span><span class="v n" id="rv-s-dur">–</span></div>
    </div>`;
}

function updateArtistRowVisibility(
  origFileName: string,
  origArtistTitle: string,
  stagedFileName: string,
  stagedArtistTitle: string,
  isMismatch: boolean,
): void {
  const row = id<HTMLElement>("#rv-row-artist");
  if (!row) return;

  if (isMismatch) {
    row.style.display = "";
    return;
  }

  const clean = (s: string) =>
    s
      .replace(/\.[^/.]+$/, "")
      .replace(/[\s\-_—–]+/g, " ")
      .trim()
      .toLowerCase();

  const origBase = clean(origFileName);
  const origArt = clean(origArtistTitle);
  const origRedundant = origBase === origArt;

  const stagedBase = clean(stagedFileName);
  const stagedArt = clean(stagedArtistTitle);
  const stagedRedundant =
    !stagedFileName ||
    !stagedArtistTitle ||
    stagedArtistTitle === "—" ||
    stagedArtistTitle === "-" ||
    stagedBase === stagedArt;

  if (origRedundant && stagedRedundant) {
    row.style.display = "none";
  } else {
    row.style.display = "";
  }
}

function skeletonHtml(label: string): string {
  const bars = Array.from({ length: 25 }, () => "<span></span>").join("");
  return `<div class="wave-skeleton">${bars}</div><div>${esc(label)}</div>`;
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
      </div>
      <div class="wav" id="wave-${deck}">
        <div class="loading" id="rv-${deck[0]}-load">${orig ? skeletonHtml("Loading original audio…") : ""}</div>
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
        <span class="kb">Review keys · <kbd>Space</kbd> play &nbsp;<kbd>↵</kbd> approve &nbsp;<kbd>⌫</kbd> skip &nbsp;<kbd>Z</kbd> undo</span>
        <span class="kb">
          <kbd>←→</kbd> scrub &nbsp;<kbd>↑↓</kbd> deck &nbsp;
          <button class="link-btn" id="rv-toggle-link" title="Toggle synchronized scrub between decks (L)"><kbd>L</kbd> Link</button>
          <button class="link-btn" id="rv-toggle-gain" title="Toggle RMS Gain Matching between decks (G)"><kbd>G</kbd> Match Gain</button>
          <button class="help-btn" id="rv-help" title="Keyboard shortcuts (?)">?</button>
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
      const d = decide(item);
      const dCls = d === "approved" ? "approved" : d === "skipped" ? "skipped" : "pending";
      return `<div class="qr ${idx === currentIndex ? "on" : ""} ${dCls}" data-idx="${idx}" title="${esc(item.relPath)}">
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
  const html =
    `<div class="isec">
       <h4>Review queue</h4>
       <p class="muted small" id="rv-qhead">${queue.length} tracks · ${countReviewed()} reviewed</p>
     </div>` +
    CATEGORY_ORDER.map(queueGroupHtml).join("");
  renderInspector(html);
  const body = document.getElementById("insp-body");
  if (body) bindQueue(body);
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
    const d = decide(item);
    row.classList.toggle("approved", d === "approved");
    row.classList.toggle("skipped", d === "skipped");
    row.classList.toggle("pending", d === "pending");
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
      if (document.activeElement instanceof HTMLElement && document.activeElement.tagName === "INPUT") {
        document.activeElement.blur();
      }
      const idx = parseInt(row.dataset.idx ?? "-1", 10);
      if (idx >= 0 && idx < queue.length) void loadTrack(idx);
    });
  });
}

function refreshDock(): void {
  const total = queue.length;
  const reviewed = countReviewed();
  const allDone = total > 0 && reviewed === total;
  const cur = getSession();
  if (cur) {
    updateSession(cur.id, {
      status: allDone ? "done" : "review",
      hasFollowUps: !allDone,
      progressLabel: total > 0 ? `${reviewed}/${total} reviewed` : null,
    });
  } else {
    setSession({
      progressLabel: total > 0 ? `${reviewed}/${total} reviewed` : null,
    });
  }
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
    renderInspector(`<div class="empty">Ledger failed to load.<br /><span class="sub">${esc(String(err))}</span></div>`);
    return;
  }

  queue = [];
  decisionHistory = [];
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
        offset_ms: entry.offset_ms as number | null | undefined,
        is_transcode: entry.is_transcode as boolean | null | undefined,
        orig_rms: entry.orig_rms as number | null | undefined,
        staged_rms: entry.staged_rms as number | null | undefined,
      });
    }
  }
  queue.forEach((item) => {
    if (!leFor(item).decision) leFor(item).decision = "pending";
  });

  if (queue.length === 0) {
    renderInspector(`<div class="empty">Nothing to review.<br /><span class="sub">No downloads, failures, or pending decisions remain.</span></div>`);
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
  renderUpgraderStage(3);
  renderInspector(`<div class="empty">Reading session ledger…</div>`);
  refreshDock();
  bindDeckButtons(el);
  bindRefetchRow(el);
  bindReviewFooter(el);
  void readLedgerAndBoot();
}

export function leaveReview(): void {
  active = false;
  stopAllReviewAudio();
  destroyPlayers();
  if (typeof window !== "undefined") {
    delete (window as unknown as Record<string, unknown>).__setPlayGlyph;
  }
  if (watchdogTimer !== null) {
    window.clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  if (lockInterval !== null) {
    window.clearInterval(lockInterval);
    lockInterval = null;
  }
  document.getElementById("rv-wav-warning-modal")?.remove();
  removeAnyShortcutsModal();
  wavWarningShown = false;
  decisionHistory = [];
  res = null;
  cb = null;
  ledger = null;
  queue = [];
  currentIndex = -1;
  (Object.keys(expanded) as CatId[]).forEach((k) => (expanded[k] = false));
}

function bindReviewFooter(el: HTMLElement): void {
  el.querySelector("#rv-toggle-link")?.addEventListener("click", () => {
    toggleLinkedScrub();
  });
  el.querySelector("#rv-toggle-gain")?.addEventListener("click", () => {
    toggleMatchGain();
  });
  el.querySelector("#rv-help")?.addEventListener("click", () => {
    openShortcutsModal();
  });
  updateLinkButtonState();
  updateGainButtonState();
}

function toggleLinkedScrub(): void {
  linkedScrub = !linkedScrub;
  updateLinkButtonState();
}

function updateLinkButtonState(): void {
  const btn = id<HTMLButtonElement>("#rv-toggle-link");
  if (!btn) return;
  btn.classList.toggle("on", linkedScrub);
  btn.setAttribute("aria-pressed", String(linkedScrub));
  btn.innerHTML = `<kbd>L</kbd> ${linkedScrub ? "Link: ON" : "Link"}`;
}

function toggleMatchGain(): void {
  matchGain = !matchGain;
  applyGainMatching();
  updateGainButtonState();
}

function updateGainButtonState(): void {
  const btn = id<HTMLButtonElement>("#rv-toggle-gain");
  if (!btn) return;
  btn.classList.toggle("on", matchGain);
  btn.setAttribute("aria-pressed", String(matchGain));
  btn.innerHTML = `<kbd>G</kbd> ${matchGain ? "Gain: ON" : "Match Gain"}`;
}

function applyGainMatching(): void {
  if (!wsOrig || !wsStaged) return;
  if (!matchGain) {
    try { wsOrig.setVolume?.(1.0); } catch { /* noop */ }
    try { wsStaged.setVolume?.(1.0); } catch { /* noop */ }
    return;
  }
  const tr = queue[currentIndex];
  if (!tr || tr.status !== "downloaded") return;
  const le = leFor(tr);
  const oRms = tr.orig_rms ?? (le.orig_rms as number | undefined);
  const sRms = tr.staged_rms ?? (le.staged_rms as number | undefined);

  if (oRms && sRms && oRms > 0 && sRms > 0) {
    if (oRms > sRms) {
      // Original is louder; attenuate original
      const factor = Math.min(1.0, sRms / oRms);
      try { wsOrig.setVolume?.(factor); } catch { /* noop */ }
      try { wsStaged.setVolume?.(1.0); } catch { /* noop */ }
    } else {
      // Staged is louder; attenuate staged
      const factor = Math.min(1.0, oRms / sRms);
      try { wsOrig.setVolume?.(1.0); } catch { /* noop */ }
      try { wsStaged.setVolume?.(factor); } catch { /* noop */ }
    }
  } else {
    try { wsOrig.setVolume?.(1.0); } catch { /* noop */ }
    try { wsStaged.setVolume?.(1.0); } catch { /* noop */ }
  }
}

function openShortcutsModal(): void {
  if (document.getElementById("rv-shortcuts-modal")) {
    removeAnyShortcutsModal();
    return;
  }
  const root = document.createElement("div");
  root.className = "modal-backdrop show";
  root.id = "rv-shortcuts-modal";
  root.innerHTML = `
    <div class="modal" role="dialog" aria-label="Review Keyboard Shortcuts" style="width:min(460px,92vw)">
      <div class="modal-title" style="margin-bottom:12px">Review Shortcuts</div>
      <div class="shortcut-grid">
        <div class="sc-row"><span class="k">Play / Pause</span><span class="v"><kbd>Space</kbd></span></div>
        <div class="sc-row"><span class="k">Switch Deck Focus</span><span class="v"><kbd>↑</kbd> <kbd>↓</kbd></span></div>
        <div class="sc-row"><span class="k">Seek Audio</span><span class="v"><kbd>←</kbd> <kbd>→</kbd> <span class="muted small">(±5s)</span></span></div>
        <div class="sc-row"><span class="k">Fast Seek</span><span class="v"><kbd>⌘←</kbd> <kbd>⌘→</kbd> <span class="muted small">(±20s)</span></span></div>
        <div class="sc-row"><span class="k">Approve Replacement</span><span class="v"><kbd>↵</kbd> <span class="muted small">Enter</span></span></div>
        <div class="sc-row"><span class="k">Skip (Keep Original)</span><span class="v"><kbd>⌫</kbd> <span class="muted small">Backspace</span></span></div>
        <div class="sc-row"><span class="k">Undo Last Decision</span><span class="v"><kbd>Z</kbd> / <kbd>⌘Z</kbd></span></div>
        <div class="sc-row"><span class="k">Toggle Linked Scrub</span><span class="v"><kbd>L</kbd></span></div>
        <div class="sc-row"><span class="k">Match RMS Loudness</span><span class="v"><kbd>G</kbd></span></div>
        <div class="sc-row"><span class="k">Shortcuts Help</span><span class="v"><kbd>?</kbd> / <kbd>h</kbd></span></div>
        <div class="sc-row"><span class="k">Dismiss Dialog</span><span class="v"><kbd>Esc</kbd></span></div>
      </div>
      <div class="modal-actions" style="margin-top:16px">
        <button class="btn primary" id="rv-shortcuts-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const close = () => root.remove();
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === root || t.closest("#rv-shortcuts-close")) {
      close();
    }
  });
}

function removeAnyShortcutsModal(): void {
  document.getElementById("rv-shortcuts-modal")?.remove();
}

/**
 * Unconditionally stops and silences all audio playback across both decks,
 * halts WebAudio buffer sources, pauses underlying media elements, suspends
 * active AudioContexts, and resets deck play glyphs. Safe to call repeatedly.
 */
export function stopAllReviewAudio(): void {
  const stopPlayer = (ws: Ws | null) => {
    if (!ws) return;
    try {
      if (typeof ws.isPlaying === "function" && ws.isPlaying()) {
        ws.pause();
      }
    } catch { /* best effort */ }
    try {
      if (typeof ws.stop === "function") {
        ws.stop();
      }
    } catch { /* best effort */ }
    try {
      if (typeof ws.pause === "function") {
        ws.pause();
      }
    } catch { /* best effort */ }

    // Inspect underlying media element or WebAudioPlayer wrapper
    try {
      const raw = ws as unknown as {
        media?: {
          pause?: () => void;
          currentTime?: number;
          destroy?: () => void;
          bufferNode?: AudioBufferSourceNode | null;
          disconnect?: () => void;
        };
        getMediaElement?: () => (HTMLMediaElement & {
          destroy?: () => void;
          bufferNode?: AudioBufferSourceNode | null;
        }) | null;
      };
      const m = raw.getMediaElement?.() ?? raw.media;
      if (m) {
        try { m.pause?.(); } catch { /* best effort */ }
        try { if ("currentTime" in m) m.currentTime = 0; } catch { /* best effort */ }
        if (m.bufferNode) {
          try { m.bufferNode.onended = null; } catch { /* best effort */ }
          try { m.bufferNode.stop(); } catch { /* best effort */ }
          try { m.bufferNode.disconnect(); } catch { /* best effort */ }
          m.bufferNode = null;
        }
        try { m.destroy?.(); } catch { /* best effort */ }
      }
    } catch { /* best effort */ }

    // Suspend or close WebAudio AudioContext
    try {
      const ctx = ctxOf(ws);
      if (ctx) {
        if (ctx.state === "running") {
          void ctx.suspend().catch(() => {});
        }
        if (typeof ctx.close === "function") {
          void ctx.close().catch(() => {});
        }
      }
    } catch { /* best effort */ }
  };

  stopPlayer(wsOrig);
  stopPlayer(wsStaged);

  // Fallback safety sweep: pause any HTMLAudioElements or media tags anywhere in the document
  try {
    document.querySelectorAll("audio, video").forEach((el) => {
      try {
        const media = el as HTMLMediaElement;
        media.pause();
        media.currentTime = 0;
        media.removeAttribute("src");
        media.load();
      } catch { /* best effort */ }
    });
  } catch { /* best effort */ }

  // Reset UI play buttons
  try {
    setGlyph("original", false);
    setGlyph("staged", false);
  } catch { /* best effort */ }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", stopAllReviewAudio);
  window.addEventListener("beforeunload", stopAllReviewAudio);
}

/** Safe teardown for route-level navigation (e.g. leaving the module). */
export function teardownReview(): boolean {
  stopAllReviewAudio();
  if (!active) return false;
  leaveReview();
  return true;
}

function destroyPlayers(): void {
  stopAllReviewAudio();
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
  const bindDeck = (deck: DeckId) => {
    const deckEl = el.querySelector<HTMLElement>(`#deck-${deck}`);
    deckEl?.addEventListener("click", (e) => {
      if (document.activeElement instanceof HTMLElement && document.activeElement.tagName === "INPUT") {
        document.activeElement.blur();
      }
      const isPlayBtn = (e.target as HTMLElement).closest(`#play-${deck}`);
      if (deck === "staged" && queue[currentIndex]?.status !== "downloaded") return;
      setFocus(deck);
      if (isPlayBtn) {
        togglePlayPause();
      }
    });
  };
  bindDeck("original");
  bindDeck("staged");

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
  });
  wsOrig.on("ready", () => {
    const dur = wsOrig?.getDuration() ?? 0;
    const h2 = id<HTMLElement>("#rv-o-dur2");
    if (h2) h2.textContent = `00:00 / ${fmtTime(dur)}`;
    updateDurationDiff();
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
  wsOrig.on("seek", () => {
    setFocus("original");
    syncSeek(wsOrig!, wsStaged, "staged");
  });
  wsOrig.on("interaction", () => {
    setFocus("original");
  });
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
  });
  wsStaged.on("ready", () => {
    const tr = queue[currentIndex];
    if (!tr || tr.status !== "downloaded") return;
    const dur = wsStaged?.getDuration() ?? 0;
    const h2 = id<HTMLElement>("#rv-s-dur2");
    if (h2) h2.textContent = `00:00 / ${fmtTime(dur)}`;
    updateDurationDiff();
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
  wsStaged.on("seek", () => {
    if (queue[currentIndex]?.status === "downloaded") {
      setFocus("staged");
    }
    syncSeek(wsStaged!, wsOrig, "original");
  });
  wsStaged.on("interaction", () => {
    if (queue[currentIndex]?.status === "downloaded") {
      setFocus("staged");
    }
  });
  wsStaged.on("play", () => setGlyph("staged", true));
  wsStaged.on("pause", () => setGlyph("staged", false));
  wsStaged.on("finish", () => setGlyph("staged", false));
  wsStaged.on("error", (err) => console.error("Staged WaveSurfer error:", err));
}

function syncSeek(sourceWs: Ws, targetWs: Ws | null, targetDeck: DeckId): void {
  if (!linkedScrub || isSyncingSeek || !targetWs) return;
  if (!isUsable(targetDeck)) return;
  const durSrc = sourceWs.getDuration();
  const durTgt = targetWs.getDuration();
  if (durSrc <= 0 || durTgt <= 0) return;
  const time = sourceWs.getCurrentTime();
  isSyncingSeek = true;
  try {
    const tr = queue[currentIndex];
    const offsetSec = ((tr?.offset_ms ?? (leFor(tr).offset_ms as number | undefined)) ?? 0) / 1000.0;
    const delta = targetDeck === "staged" ? offsetSec : -offsetSec;
    targetWs.setTime(Math.max(0, Math.min(durTgt, time + delta)));
  } catch {
    /* best effort */
  } finally {
    isSyncingSeek = false;
  }
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
  if (queue[currentIndex]?.status === "downloaded") {
    if (deck === "staged" && focus !== "original") {
      setFocus("staged");
    }
  } else {
    setFocus("original");
  }
}

function setFocus(deck: DeckId): void {
  if (focus === deck) return;
  const prevDeck = focus;
  focus = deck;
  id<HTMLElement>("#deck-original")?.classList.toggle("focused", deck === "original");
  id<HTMLElement>("#deck-staged")?.classList.toggle("focused", deck === "staged");

  // Seamless live hot-swap if currently playing
  const prevWs = prevDeck === "original" ? wsOrig : wsStaged;
  const newWs = deck === "original" ? wsOrig : wsStaged;
  if (prevWs && newWs && prevWs.isPlaying() && isUsable(deck)) {
    const time = prevWs.getCurrentTime();
    prevWs.pause();
    const tr = queue[currentIndex];
    const offsetSec = ((tr?.offset_ms ?? (leFor(tr).offset_ms as number | undefined)) ?? 0) / 1000.0;
    const dur = newWs.getDuration();
    const delta = deck === "staged" ? offsetSec : -offsetSec;
    const targetTime = Math.max(0, Math.min(dur, time + delta));
    newWs.setTime(targetTime);
    void playWs(newWs);
  }
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

function checkMetadataMismatch(origStr: string, artist?: string, title?: string): boolean {
  if (!artist || !title) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const o = norm(origStr);
  const a = norm(artist);
  const t = norm(title);
  const aTokens = a.split(/\s+/).filter((w) => w.length > 2);
  const tTokens = t.split(/\s+/).filter((w) => w.length > 2);
  const hasArtist = aTokens.some((tok) => o.includes(tok));
  const hasTitle = tTokens.some((tok) => o.includes(tok));
  return !hasArtist && !hasTitle;
}

function updateDurationDiff(): void {
  const oDur = wsOrig?.getDuration() ?? 0;
  const sDur = wsStaged?.getDuration() ?? 0;
  const tr = queue[currentIndex];
  const ho = id<HTMLElement>("#rv-o-dur");
  const hs = id<HTMLElement>("#rv-s-dur");
  if (ho && oDur > 0) {
    ho.textContent = fmtTime(oDur);
  }
  if (!hs) return;
  if (!tr || tr.status !== "downloaded" || sDur <= 0) {
    hs.textContent = "–";
    hs.className = "v n";
    hs.title = "";
    return;
  }
  if (oDur > 0) {
    const delta = Math.round(sDur - oDur);
    if (Math.abs(delta) > 2) {
      const sign = delta > 0 ? "+" : "";
      hs.textContent = `${fmtTime(sDur)} (${sign}${delta}s Δ)`;
      hs.className = "v n dur-delta";
      hs.title = `Duration difference of ${Math.abs(delta)}s from original`;
    } else {
      hs.textContent = fmtTime(sDur);
      hs.className = "v n";
      hs.title = "Duration matches original within 2s";
    }
  } else {
    hs.textContent = fmtTime(sDur);
    hs.className = "v n";
    hs.title = "";
  }
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
    lo.innerHTML = skeletonHtml("Loading original audio…");
  }
  [["#rv-o-dur2", "00:00"]].forEach(([sel, txt]) => {
    const h = id<HTMLElement>(sel);
    if (h) h.textContent = txt;
  });

  if (wsStaged?.empty) wsStaged.empty();
  [["#rv-s-dur", "-"], ["#rv-s-dur2", "--:--"], ["#rv-s-fmt", "—"]].forEach(([sel, txt]) => {
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
  const overrideToggle = id<HTMLButtonElement>("#rv-override-toggle");
  if (track.status === "downloaded") {
    if (refetchRow) refetchRow.classList.add("hidden");
    if (overrideToggle) {
      overrideToggle.style.display = "inline-block";
      overrideToggle.textContent = "Wrong match? Paste Deezer URL";
    }
  } else {
    if (refetchRow) refetchRow.classList.remove("hidden");
    if (overrideToggle) {
      overrideToggle.style.display = "none";
    }
  }

  // why + badge
  const why = id<HTMLElement>("#rv-why");
  if (why) why.innerHTML = whyText(track);
  updateDecisionPill(track);
  applyGainMatching();

  // original path
  const originalAbs =
    (le.original_abs_path as string | undefined) ?? joinPath(res?.rootPath ?? "", track.relPath);
  const origExt = track.relPath.split(".").pop()?.toLowerCase() ?? "";
  const ofmt = id<HTMLElement>("#rv-o-format");
  const ofmtFl = id<HTMLElement>("#rv-o-fmt");
  if (ofmt) ofmt.textContent = origExt.toUpperCase() || "—";
  if (ofmtFl) ofmtFl.textContent = origExt.toUpperCase() || "—";
  id<HTMLElement>("#rv-o-file") && (id<HTMLElement>("#rv-o-file")!.textContent = name);
  const origArtistTitle = name.replace(/\.[^/.]+$/, "");
  const oArtistEl = id<HTMLElement>("#rv-o-artist");
  if (oArtistEl) oArtistEl.textContent = origArtistTitle;

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

  const origPeaks = Array.isArray(le.peaks) && le.peaks.length > 0 ? le.peaks : undefined;
  const stagedPeaks = Array.isArray(le.staged_peaks) && le.staged_peaks.length > 0 ? le.staged_peaks : undefined;

  if (wsOrig?.load && isTauri()) {
    try {
      if (origPeaks) {
        void wsOrig.load(convertFileSrc(originalAbs), origPeaks);
      } else {
        void wsOrig.load(convertFileSrc(originalAbs));
      }
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
      ls.innerHTML = skeletonHtml("Loading upgrade audio…");
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
        if (stagedPeaks) {
          void wsStaged.load(convertFileSrc(stagedAbs), stagedPeaks);
        } else {
          void wsStaged.load(convertFileSrc(stagedAbs));
        }
      } catch (err) {
        if (ls) ls.textContent = `Error loading upgrade: ${err}`;
      }
    }
    const sFile = filenameOf((le.staged_path as string) ?? "");
    id<HTMLElement>("#rv-s-file") && (id<HTMLElement>("#rv-s-file")!.textContent = sFile);
    let sArtistTitle = "—";
    let isMismatch = false;
    const sArtistEl = id<HTMLElement>("#rv-s-artist");
    if (sArtistEl) {
      const art = (le.artist as string | undefined)?.trim();
      const tit = (le.title as string | undefined)?.trim();
      sArtistTitle = art && tit ? `${art} — ${tit}` : (tit || art || "—");
      sArtistEl.textContent = sArtistTitle;
      isMismatch = checkMetadataMismatch(origArtistTitle, art, tit);
      sArtistEl.className = isMismatch ? "v n diff-mismatch" : "v n";
      sArtistEl.title = isMismatch ? "Recording credit differs from original filename" : "";
    }
    updateArtistRowVisibility(name, origArtistTitle, sFile, sArtistTitle, isMismatch);
    const sFmt = sFile.split(".").pop()?.toUpperCase() ?? "—";
    id<HTMLElement>("#rv-s-format")!.textContent = sFmt;
    const sFmtFl = id<HTMLElement>("#rv-s-fmt");
    if (sFmtFl) sFmtFl.textContent = sFmt;
    const sBitrate = le.staged_bitrate as number | undefined;
    const sbt = id<HTMLElement>("#rv-s-bitrate");
    if (sbt) {
      const isLossless = isLosslessExt((le.staged_path as string) ?? "");
      const isOriginalLossless = isLosslessExt(track.relPath);
      const isUpgrade = isLossless && !isOriginalLossless
        ? true
        : !isLossless && typeof sBitrate === "number" && typeof oBitrate === "number" && sBitrate > oBitrate;

      sbt.textContent = isLossless
        ? "lossless"
        : sBitrate
          ? `${sBitrate} kbps`
          : "—";
      sbt.className = isUpgrade ? "v n bitrate-upgrade" : "v n";
      sbt.title = isUpgrade
        ? (isLossless ? "Lossless audio upgrade" : `Bitrate upgrade (${sBitrate} kbps vs ${oBitrate ?? "?"} kbps)`)
        : "";
    }
    if (stagedAbs) {
      void getFileSize(stagedAbs).then((sz) => {
        const h = id<HTMLElement>("#rv-s-size");
        if (h && typeof sz === "number") h.textContent = fmtBytes(sz);
      }).catch(() => undefined);
    }
    setFocus("staged");
  } else {
    updateArtistRowVisibility(name, origArtistTitle, "", "", false);
    const sArtistEl = id<HTMLElement>("#rv-s-artist");
    if (sArtistEl) {
      sArtistEl.textContent = "—";
      sArtistEl.className = "v n";
      sArtistEl.title = "";
    }
    const sbt = id<HTMLElement>("#rv-s-bitrate");
    if (sbt) {
      sbt.textContent = "—";
      sbt.className = "v n";
      sbt.title = "";
    }
    const sDurEl = id<HTMLElement>("#rv-s-dur");
    if (sDurEl) {
      sDurEl.textContent = "–";
      sDurEl.className = "v n";
      sDurEl.title = "";
    }
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
      if (needOrig && wsOrig) {
        if (origPeaks) void wsOrig.load(myOriginalUrl, origPeaks);
        else void wsOrig.load(myOriginalUrl);
      }
      if (needStaged && wsStaged) {
        if (stagedPeaks) void wsStaged.load(myStagedUrl, stagedPeaks);
        else void wsStaged.load(myStagedUrl);
      }
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

function getNextReviewIndex(fromIndex: number): number {
  if (queue.length === 0) return -1;
  if (queue.length === 1) return fromIndex;

  const current = queue[fromIndex];
  const currentCat = current ? getItemCategory(current) : null;

  // 1. Look for next pending track in the current category after fromIndex
  if (currentCat) {
    for (let i = fromIndex + 1; i < queue.length; i++) {
      if (getItemCategory(queue[i]) === currentCat && decide(queue[i]) === "pending") {
        return i;
      }
    }
    // Check pending in current category before fromIndex (wrap around within category)
    for (let i = 0; i < fromIndex; i++) {
      if (getItemCategory(queue[i]) === currentCat && decide(queue[i]) === "pending") {
        return i;
      }
    }
  }

  // 2. Look for any pending track in subsequent categories / anywhere in queue after fromIndex
  for (let i = fromIndex + 1; i < queue.length; i++) {
    if (decide(queue[i]) === "pending") {
      return i;
    }
  }
  // Wrap around to any pending track in the queue before fromIndex
  for (let i = 0; i < fromIndex; i++) {
    if (decide(queue[i]) === "pending") {
      return i;
    }
  }

  // 3. Fallback: all tracks are reviewed! Advance to next track in queue (wrap around)
  return (fromIndex + 1) % queue.length;
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
  const prevDecision = decide(track);
  decisionHistory.push({ index: currentIndex, prevDecision });
  const d = track.status === "downloaded" || hasShazamMeta(track) ? "approved" : "skipped";
  await saveDecision(track.relPath, d);
  pauseAll();
  updateQueueRow(currentIndex);
  updateDecisionPill(track);
  refreshDock();
  const next = getNextReviewIndex(currentIndex);
  if (next !== -1 && next !== currentIndex) {
    await loadTrack(next);
  } else {
    scrollActiveIntoView();
  }
}

async function skipCurrent(): Promise<void> {
  const track = queue[currentIndex];
  if (!track) return;
  const prevDecision = decide(track);
  decisionHistory.push({ index: currentIndex, prevDecision });
  await saveDecision(track.relPath, "skipped");
  pauseAll();
  updateQueueRow(currentIndex);
  updateDecisionPill(track);
  refreshDock();
  const next = getNextReviewIndex(currentIndex);
  if (next !== -1 && next !== currentIndex) {
    await loadTrack(next);
  } else {
    scrollActiveIntoView();
  }
}

async function undoLastDecision(): Promise<void> {
  if (decisionHistory.length === 0) return;
  const last = decisionHistory.pop()!;
  const track = queue[last.index];
  if (!track) return;
  await saveDecision(track.relPath, last.prevDecision);
  pauseAll();
  updateQueueRow(last.index);
  refreshDock();
  await loadTrack(last.index);
}

async function clearCategory(cat: CatId, approve: boolean): Promise<void> {
  let changed = false;
  for (let idx = 0; idx < queue.length; idx++) {
    const item = queue[idx];
    if (getItemCategory(item) !== cat) continue;
    if (decide(item) !== "pending") continue;
    decisionHistory.push({ index: idx, prevDecision: decide(item) });
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
  el.querySelector("#rv-btn-approve")?.addEventListener("click", () => void approveCurrent());
  el.querySelector("#rv-btn-skip")?.addEventListener("click", () => void skipCurrent());
  el.querySelector("#rv-override-toggle")?.addEventListener("click", () => {
    const row = id<HTMLElement>("#rv-refetch-row");
    const toggleBtn = id<HTMLButtonElement>("#rv-override-toggle");
    if (!row || !toggleBtn) return;
    const isHidden = row.classList.contains("hidden");
    row.classList.toggle("hidden", !isHidden);
    toggleBtn.textContent = isHidden ? "Hide Deezer URL input" : "Wrong match? Paste Deezer URL";
    if (isHidden) {
      id<HTMLInputElement>("#rv-deezer-id")?.focus();
    }
  });

  el.querySelector("#rv-identify")?.addEventListener("click", () => void onIdentify());
  el.querySelector("#rv-refetch")?.addEventListener("click", () => void onRefetch());
  const input = el.querySelector<HTMLInputElement>("#rv-deezer-id");
  if (input) {
    const handleUrlInput = async () => {
      const val = input.value.trim();
      if (!val) return;
      const directId = extractDeezerTrackId(val);
      if (directId && String(directId) !== val) {
        input.value = String(directId);
        showFeedback(`✓ Extracted Track ID: ${directId}`, "ok");
        return;
      }
      if (!directId && isPotentialDeezerUrl(val)) {
        showFeedback("Resolving link…", "warn");
        try {
          const res = await resolveDeezerLink(val);
          if (res?.track_id && res.track_id > 0) {
            input.value = String(res.track_id);
            showFeedback(`✓ Resolved to ID: ${res.track_id}`, "ok");
          } else {
            showFeedback("Could not find track in link", "err");
          }
        } catch {
          // best-effort background resolution
        }
      }
    };

    input.addEventListener("paste", () => {
      window.setTimeout(() => void handleUrlInput(), 50);
    });

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).blur();
        void onRefetch();
      }
    });
  }
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
  let targetId = extractDeezerTrackId(raw);

  if ((!targetId || targetId <= 0) && isPotentialDeezerUrl(raw)) {
    const btn = id<HTMLButtonElement>("#rv-refetch");
    const orig = btn?.textContent ?? "";
    if (btn) { btn.disabled = true; btn.textContent = "Resolving…"; }
    showFeedback("Resolving link…", "warn");
    try {
      const resolved = await resolveDeezerLink(raw);
      if (resolved?.track_id && resolved.track_id > 0) {
        targetId = resolved.track_id;
      }
    } catch (err) {
      console.warn("Link resolution failed:", err);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  if (!targetId || targetId <= 0) {
    showFeedback("Enter a numeric Deezer ID or paste a Deezer URL", "warn");
    return;
  }
  if (input) {
    input.value = String(targetId);
  }
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
      entry.offset_ms = le.offset_ms as number | null | undefined;
      entry.is_transcode = le.is_transcode as boolean | null | undefined;
      entry.orig_rms = le.orig_rms as number | null | undefined;
      entry.staged_rms = le.staged_rms as number | null | undefined;
    }
  } catch { /* keep in-memory */ }
}

/* ---------------- commit ---------------- */

function openCommitModal(): void {
  if (!res || !ledger) return;
  stopAllReviewAudio();
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
        <div style="margin-top:8px">
          <label class="opt">
            <input type="checkbox" class="chk" id="commit-auto-shift-cues" checked />
            <span class="of">Auto-shift Rekordbox beatgrids & cue points by acoustic offset (Δt)<span class="ob">Keeps cues and beatgrids locked to transients even when lead-in silence differs.</span></span>
          </label>
        </div>
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

    const autoShiftCues = document.querySelector<HTMLInputElement>("#commit-auto-shift-cues")?.checked ?? true;

    if (rbAction === "db" && res.sourceKind === "db") {
      setCommitStatus(backdrop, "Updating Rekordbox library directly…");
      await updateRekordboxDbDirectly(res.ledgerPath, decisions, outputPath, strategy, autoShiftCues);
    } else if (rbAction === "xml" && res.sourceKind === "xml" && res.xmlPath) {
      setCommitStatus(backdrop, "Exporting upgraded Rekordbox XML…");
      exportedXmlPath = await updateRekordboxXml(res.xmlPath, res.ledgerPath, decisions, autoShiftCues);
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

  if (document.getElementById("rv-shortcuts-modal")) {
    if (e.key === "Escape" || e.key === "?" || e.key === "h" || e.key === "H") {
      e.preventDefault();
      removeAnyShortcutsModal();
      return;
    }
  }

  if (anyModalOpen()) return;

  if (e.key === "?" || ((e.key === "h" || e.key === "H") && !e.metaKey && !e.ctrlKey)) {
    e.preventDefault();
    openShortcutsModal();
    return;
  }

  if ((e.key === "z" || e.key === "Z") && !e.shiftKey) {
    e.preventDefault();
    void undoLastDecision();
    return;
  }

  if ((e.key === "l" || e.key === "L") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    toggleLinkedScrub();
    return;
  }

  if ((e.key === "g" || e.key === "G") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    toggleMatchGain();
    return;
  }

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
      void approveCurrent();
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
  if (linkedScrub && track.status === "downloaded") {
    const other = ws === wsOrig ? wsStaged : wsOrig;
    const otherDeck: DeckId = ws === wsOrig ? "staged" : "original";
    syncSeek(ws, other, otherDeck);
  }
}