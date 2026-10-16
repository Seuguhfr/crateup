/* Playlist Compare: pick two playlists from your Rekordbox library
   (XML export or live master.db) and see common tracks vs. tracks only
   in one side. Stateless utility — no sessions. */

import {
  comparePlaylistsAcoustic,
  isTauri,
  selectXmlFile,
  type AcousticCompareResult,
  type CompareAcousticProgress,
} from "../api.js";
import {
  jobProgressHtml,
  paintJobProgress,
  watchJobEvent,
} from "../jobs.js";
import { loadPrefs, thresholdLabel } from "../policy.js";
import {
  collectPlaylists,
  fetchTrackList,
  loadPlaylistTree,
  type LibrarySource,
  type PlaylistNode,
  type PlaylistOption,
} from "../source-access.js";
import { diffPlaylists, displayTrackName } from "./compare.js";
import { dedupeIdentities } from "../track-identity.js";
import { clearChrome, renderInspector } from "../chrome.js";
import { phaseHead } from "../components.js";
import { startFileListSession } from "../upgrader/view.js";
import { esc } from "../upgrader/utils.js";

type CompareSource = "xml" | "db";

let source: CompareSource = "xml";
let xmlPath: string | null = null;
let options: PlaylistOption[] = [];
let keyA: string | null = null;
let keyB: string | null = null;
let error: string | null = null;
let busy = false;

// Acoustic refinement state: pairs same-song files across the two sides
// (different encodings/paths of one recording).
let acoustic = new Map<string, AcousticCompareResult>();
let acousticBusyKey: string | null = null;
let pendingAcoustic: { key: string; a: string[]; b: string[] } | null = null;
let acousticUnlisten: (() => void) | null = null;

// Handover state for "Upgrade these": deduped path lists behind the
// Only-in-A / Only-in-B groups of the current render.
let pendingUpgrade: {
  key: string;
  aLabel: string;
  aPaths: string[];
  bLabel: string;
  bPaths: string[];
} | null = null;

let activeTab: "onlyA" | "onlyB" | "both" = "onlyA";

export function renderCompare(el: HTMLElement): void {
  const prevScrollTop = el.querySelector(".ov")?.scrollTop ?? 0;
  el.className = "screen on";
  const opts = (selected: string | null) =>
    options
      .map(
        (o) =>
          `<option value="${esc(o.key)}"${o.key === selected ? " selected" : ""}>${esc(o.label)}${o.nodeType === "folder" ? " (folder)" : ""}</option>`,
      )
      .join("");
  el.innerHTML = `
    <div class="ov">
      <div class="mx" style="max-width:760px">
        ${phaseHead(
          "04 · COMPARE",
          "Playlist Compare",
          "Two playlists from your Rekordbox library — XML export or live database. Common songs, and what each side has that the other doesn't.",
        )}
        <div class="sect">
          <h3>Library</h3>
          <div class="frow">
            <span class="fl">Source</span>
            <div class="seg" id="cmp-source-seg">
              <button data-src="xml"${source === "xml" ? ' class="on"' : ""}>XML file</button>
              <button data-src="db"${source === "db" ? ' class="on"' : ""}>Database</button>
            </div>
          </div>
          ${source === "xml" ? `
          <div class="frow">
            <span class="fl">Rekordbox XML</span>
            <input class="field" id="cmp-xml" readonly placeholder="Choose an .xml export…" value="${xmlPath ? esc(xmlPath) : ""}" />
            <button class="btn sm" id="cmp-browse">Choose…</button>
          </div>` : `
          <div class="frow">
            <span class="fl">master.db</span>
            <span class="muted small">Reads playlists straight from the live Rekordbox database.</span>
          </div>`}
        </div>
        ${
          options.length > 0
            ? `<div class="sect">
            <h3>Playlists</h3>
            <div class="frow">
              <span class="fl">Playlist A</span>
              <select class="pop" id="cmp-a">${opts(keyA)}</select>
            </div>
            <div class="frow">
              <span class="fl">Playlist B</span>
              <select class="pop" id="cmp-b">${opts(keyB)}</select>
            </div>
            ${soundActionHtml(optByKey(keyA), optByKey(keyB))}
          </div>
          <div id="cmp-results">${resultsHtml()}</div>`
            : ""
        }
        ${error ? `<p class="danger-text" id="cmp-error">${esc(error)}</p>` : ""}
        ${busy ? `<p class="muted small">Loading…</p>` : ""}
      </div>
    </div>`;
  clearChrome();
  renderInspector(`
    <div class="isec">
      <h4>How it works</h4>
      <p style="font-size:11.5px;color:var(--text3);line-height:1.45">Exact matches by file path (case-insensitive); folders aggregate every sub-playlist. "Match by sound" fingerprints the leftovers and pairs identical recordings at different paths. Nothing is written — this only reads your library.</p>
    </div>
  `);
  el.querySelector("#cmp-source-seg")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest?.("button[data-src]");
    const next = btn?.getAttribute("data-src");
    if (next !== "xml" && next !== "db") return;
    if (next === source) return;
    source = next;
    resetOptions();
    if (next === "db") void loadDb(el);
    else renderCompare(el);
  });
  el.querySelector("#cmp-browse")?.addEventListener("click", () => void pickXml(el));
  el.querySelector("#cmp-sound")?.addEventListener("click", () => void runAcoustic(el));
  wireResults(el);
  el.querySelector<HTMLSelectElement>("#cmp-a")?.addEventListener("change", (e) => {
    keyA = (e.target as HTMLSelectElement).value;
    renderCompare(el);
  });
  el.querySelector<HTMLSelectElement>("#cmp-b")?.addEventListener("change", (e) => {
    keyB = (e.target as HTMLSelectElement).value;
    renderCompare(el);
  });
  const newOv = el.querySelector(".ov");
  if (newOv && prevScrollTop > 0) newOv.scrollTop = prevScrollTop;
}

function wireResults(el: HTMLElement): void {
  const resEl = el.querySelector("#cmp-results");
  if (!resEl) return;
  resEl.querySelector("#cmp-upgrade-a")?.addEventListener("click", () => void upgradeThese(el, "a"));
  resEl.querySelector("#cmp-upgrade-b")?.addEventListener("click", () => void upgradeThese(el, "b"));
  resEl.querySelector("#cmp-tabs")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
    const next = btn?.dataset.tab;
    if (next === "onlyA" || next === "onlyB" || next === "both") {
      activeTab = next;
      const ov = el.querySelector(".ov");
      const prev = ov?.scrollTop ?? 0;
      resEl.innerHTML = resultsHtml();
      wireResults(el);
      if (ov) ov.scrollTop = prev;
    }
  });
}

function resetOptions(): void {
  options = [];
  keyA = null;
  keyB = null;
  error = null;
  activeTab = "onlyA";
}

function acceptTree(nodes: PlaylistNode[], tooFew: string): void {
  const list = collectPlaylists(nodes);
  if (list.length < 2) {
    error = tooFew;
    options = [];
  } else {
    options = list;
    if (!keyA || !options.some((o) => o.key === keyA)) keyA = options[0].key;
    if (!keyB || !options.some((o) => o.key === keyB))
      keyB = options.length > 1 ? options[1].key : options[0].key;
  }
}

function currentSource(): LibrarySource {
  return source === "db" ? { kind: "db" } : { kind: "xml", xmlPath: xmlPath ?? "" };
}

async function pickXml(el: HTMLElement): Promise<void> {
  if (!isTauri()) {
    error = "The Tauri bridge is not available.";
    renderCompare(el);
    return;
  }
  const picked = await selectXmlFile().catch(() => null);
  if (!picked) return;
  busy = true;
  error = null;
  renderCompare(el);
  try {
    xmlPath = picked;
    acceptTree(await loadPlaylistTree({ kind: "xml", xmlPath: picked }), "That XML has fewer than two playlists.");
  } catch (err) {
    error = `Could not read playlists: ${err instanceof Error ? err.message : String(err)}`;
    options = [];
  }
  busy = false;
  renderCompare(el);
}

async function loadDb(el: HTMLElement): Promise<void> {
  if (!isTauri()) {
    error = "The Tauri bridge is not available.";
    renderCompare(el);
    return;
  }
  busy = true;
  error = null;
  renderCompare(el);
  try {
    acceptTree(await loadPlaylistTree({ kind: "db" }), "The database has fewer than two playlists.");
  } catch (err) {
    error = `Could not read the Rekordbox database (is Rekordbox closed?): ${err instanceof Error ? err.message : String(err)}`;
    options = [];
  }
  busy = false;
  renderCompare(el);
}

function optByKey(key: string | null): PlaylistOption | null {
  return options.find((o) => o.key === key) ?? null;
}

/** "Upgrade these" action for an Only-in group. Hands the listed files to
 *  the Quality Upgrader as a new session (same-song duplicates collapsed
 *  to the preferred file at click time). */
function upgradeAction(side: "a" | "b", tracks: string[]): string {
  if (tracks.length === 0) return "";
  return `<div style="margin-top:10px"><button class="btn sm" id="cmp-upgrade-${side}">Upgrade these ${tracks.length} track${tracks.length === 1 ? "" : "s"}</button></div>`;
}

async function upgradeThese(el: HTMLElement, side: "a" | "b"): Promise<void> {
  const job = pendingUpgrade;
  if (!job || !isTauri()) return;
  const label = side === "a" ? job.aLabel : job.bLabel;
  const paths = dedupeIdentities(side === "a" ? job.aPaths : job.bPaths);
  if (paths.length === 0) return;
  const ok = await startFileListSession(el, `Upgrade ${label}`, paths);
  if (ok && !window.location.hash.includes("upgrader")) {
    window.location.hash = "#/upgrader";
  }
}

function cacheKey(a: PlaylistOption, b: PlaylistOption): string {
  const src = source === "db" ? "db" : `xml:${xmlPath ?? ""}`;
  return `${src}||${a.nodeType}:${a.name}||${b.nodeType}:${b.name}`;
}

function soundActionHtml(a: PlaylistOption | null, b: PlaylistOption | null): string {
  if (!a || !b || a.key === b.key) return "";
  const key = cacheKey(a, b);
  const cached = cache.get(key);
  if (!cached) return "";
  const { onlyA, onlyB } = cached;
  const sound = acoustic.get(key);
  if (sound) {
    return `<div class="frow" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);align-items:center">
      <span class="ok-text small">✓ Acoustic matching paired ${sound.pairs.length} identical track${sound.pairs.length === 1 ? "" : "s"}${sound.skipped.length > 0 ? ` (${sound.skipped.length} missing skipped)` : ""}.</span>
    </div>`;
  }
  if (onlyA.length === 0 || onlyB.length === 0) return "";
  if (acousticBusyKey === key) {
    return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
      ${jobProgressHtml("cmp-sound-fill", "cmp-sound-text", "Matching leftovers by sound…")}
    </div>`;
  }
  pendingAcoustic = { key, a: onlyA, b: onlyB };
  const pct = thresholdLabel(loadPrefs().match.acousticThreshold);
  return `
    <div class="frow" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);align-items:center;justify-content:space-between">
      <span class="muted small" style="flex:1;min-width:0;padding-right:12px">Pair identical recordings at different paths (${onlyA.length} × ${onlyB.length} comparisons, ${pct} match)</span>
      <button class="btn sm" id="cmp-sound">Match leftovers by sound</button>
    </div>`;
}

function resultsHtml(): string {
  // Rendered synchronously from cached track lists.
  const a = optByKey(keyA);
  const b = optByKey(keyB);
  if (!a || !b) return "";
  if (source === "xml" && !xmlPath) return "";
  if (a.key === b.key) {
    return `<div class="sect"><h3>Pick two different playlists</h3><p class="muted" style="margin:0">A and B are the same playlist.</p></div>`;
  }
  const key = cacheKey(a, b);
  const cached = cache.get(key);
  if (!cached) {
    void loadAndPaint(key, a, b);
    return `<p class="muted small">Loading tracks…</p>`;
  }
  const { common, onlyA, onlyB } = cached;

  // Acoustic refinement for the leftovers: same song, different file.
  pendingAcoustic = null;
  pendingUpgrade = null;
  let restA = onlyA;
  let restB = onlyB;
  let skippedHtml = "";
  const sound = acoustic.get(key);
  if (sound) {
    if (sound.pairs.length > 0) {
      const pairedA = new Set(sound.pairs.map((p) => p.a));
      const pairedB = new Set(sound.pairs.map((p) => p.b));
      restA = onlyA.filter((p) => !pairedA.has(p));
      restB = onlyB.filter((p) => !pairedB.has(p));
    }
    if (sound.skipped.length > 0) {
      skippedHtml = `<p class="muted small" style="margin-top:8px">Skipped ${sound.skipped.length} missing file${sound.skipped.length === 1 ? "" : "s"}.</p>`;
    }
  }

  pendingUpgrade = { key, aLabel: a.label, aPaths: restA, bLabel: b.label, bPaths: restB };

  let tabContentHtml = "";
  if (activeTab === "onlyA") {
    tabContentHtml =
      restA.length === 0
        ? `<p class="muted" style="margin:0">Everything in ${esc(a.label)} is also in ${esc(b.label)}.</p>`
        : `<div class="tree-box">${restA
            .map(
              (p) =>
                `<div class="tree-row"><span class="tree-name" title="${esc(p)}">${esc(displayTrackName(p))}</span></div>`,
            )
            .join("")}</div>${upgradeAction("a", restA)}`;
  } else if (activeTab === "onlyB") {
    tabContentHtml =
      restB.length === 0
        ? `<p class="muted" style="margin:0">Everything in ${esc(b.label)} is also in ${esc(a.label)}.</p>`
        : `<div class="tree-box">${restB
            .map(
              (p) =>
                `<div class="tree-row"><span class="tree-name" title="${esc(p)}">${esc(displayTrackName(p))}</span></div>`,
            )
            .join("")}</div>${upgradeAction("b", restB)}`;
  } else {
    // "both" tab: show common exact matches plus acoustic pairs if any
    const totalBoth = common.length + (sound?.pairs.length ?? 0);
    if (totalBoth === 0) {
      tabContentHtml = `<p class="muted" style="margin:0">No shared tracks between these playlists.</p>`;
    } else {
      tabContentHtml = `
        <div class="tree-box">
          ${common
            .map(
              (p) =>
                `<div class="tree-row"><span class="tree-name" title="${esc(p)}">${esc(displayTrackName(p))}</span></div>`,
            )
            .join("")}
          ${
            sound && sound.pairs.length > 0
              ? sound.pairs
                  .map(
                    (p) =>
                      `<div class="tree-row" style="background:var(--segBg)"><span class="tree-name" title="${esc(p.a)} ↔ ${esc(p.b)}">${esc(displayTrackName(p.a))} <span class="muted">↔</span> ${esc(displayTrackName(p.b))} <span class="c ok-text">${Math.round(p.score * 100)}% acoustic</span></span></div>`,
                  )
                  .join("")
              : ""
          }
        </div>${skippedHtml}`;
    }
  }

  const bothCount = common.length + (sound?.pairs.length ?? 0);
  return `
    <div class="sect">
      <div class="seg" id="cmp-tabs" style="margin-bottom:12px;display:inline-flex">
        <button data-tab="onlyA"${activeTab === "onlyA" ? ' class="on"' : ""}>Only in ${esc(a.label)} (${restA.length})</button>
        <button data-tab="onlyB"${activeTab === "onlyB" ? ' class="on"' : ""}>Only in ${esc(b.label)} (${restB.length})</button>
        <button data-tab="both"${activeTab === "both" ? ' class="on"' : ""}>In Both (${bothCount})</button>
      </div>
      ${tabContentHtml}
    </div>`;
}

const cache = new Map<string, { common: string[]; onlyA: string[]; onlyB: string[] }>();

async function fetchTracks(opt: PlaylistOption): Promise<string[]> {
  return fetchTrackList(currentSource(), opt.name, opt.nodeType);
}

async function loadAndPaint(key: string, optA: PlaylistOption, optB: PlaylistOption): Promise<void> {
  try {
    const [a, b] = await Promise.all([fetchTracks(optA), fetchTracks(optB)]);
    cache.set(key, diffPlaylists(a, b));
  } catch (err) {
    console.error("Compare failed:", err);
  }
  repaintIfCompare();
}

function repaintIfCompare(): void {
  const view = document.getElementById("view");
  if (view && document.contains(view) && view.querySelector("#cmp-a")) {
    renderCompare(view);
  }
}

async function runAcoustic(el: HTMLElement): Promise<void> {
  const job = pendingAcoustic;
  if (!job || acousticBusyKey || !isTauri()) return;
  acousticBusyKey = job.key;
  renderCompare(el);
  try {
    acousticUnlisten?.();
  } catch {
    // no previous listener — ignore
  }
  acousticUnlisten = null;
  try {
    acousticUnlisten = await watchJobEvent<CompareAcousticProgress>(
      "compare-acoustic-progress",
      (p) =>
        paintJobProgress(
          "cmp-sound-fill",
          "cmp-sound-text",
          p.processed,
          p.total,
          `Fingerprinting ${p.processed} / ${p.total} files…`,
        ),
    );
  } catch {
    // progress events unavailable — the run still completes
  }
  try {
    const threshold = loadPrefs().match.acousticThreshold;
    acoustic.set(job.key, await comparePlaylistsAcoustic(job.a, job.b, threshold));
  } catch (err) {
    console.error("Acoustic compare failed:", err);
    error = `Sound matching failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  acousticBusyKey = null;
  try {
    acousticUnlisten?.();
  } catch {
    // ignore
  }
  acousticUnlisten = null;
  renderCompare(el);
}
