/* Library Audit: pick → run → results. Full sessions like the other
 * pipeline tools: the run opens a sidebar session (identity = tool +
 * library folder), live progress while auditing, restorable summary after.
 * Deleting a session removes the record only — never files. */

import { clearChrome } from "../chrome.js";
import { phaseHead } from "../components.js";
import {
  detachAll,
  jobProgressHtml,
  paintJobProgress,
  watchJobEvent,
} from "../jobs.js";
import {
  auditLibrary,
  auditSuggestedRoots,
  deleteAuditPaths,
  removeEmptyFolders,
  selectDirectory,
  showConfirmDialog,
  type AuditProgress,
  type AuditReport,
} from "../api.js";
import { loadPrefs } from "../policy.js";
import { closeSession, getSession, openSession, updateSession } from "../store.js";
import { esc, fmtBytes } from "../upgrader/utils.js";
import {
  loadAuditRun,
  loadSearchRoots,
  parentFolders,
  removeAuditRun,
  saveAuditRun,
  saveSearchRoots,
  summarizeAudit,
  toggleSelected,
} from "./settings.js";

export { removeAuditRun };

type Phase = "pick" | "running" | "results";

interface State {
  phase: Phase;
  libraryRoot: string;
  searchRoots: string[];
  suggestedTried: boolean;
  report: AuditReport | null;
  selected: string[];
  deleteMsg: string | null;
  emptiedFolders: string[];
  foldersMsg: string | null;
  error: string | null;
}

const prefs = loadPrefs();

const state: State = {
  phase: "pick",
  libraryRoot: prefs.libraryRoot ?? "",
  searchRoots: loadSearchRoots(),
  suggestedTried: false,
  report: null,
  selected: [],
  deleteMsg: null,
  emptiedFolders: [],
  foldersMsg: null,
  error: null,
};

let viewEl: HTMLElement | null = null;
let runActive = false;
let resumeRequested = false;

export function requestAuditResume(): void {
  resumeRequested = true;
}

export function resetAuditView(): void {
  if (runActive) {
    state.phase = "pick";
    state.error = null;
    return;
  }
  resumeRequested = false;
  state.phase = "pick";
  state.report = null;
  state.selected = [];
  state.deleteMsg = null;
  state.emptiedFolders = [];
  state.foldersMsg = null;
  state.error = null;
}

export function renderAudit(el: HTMLElement): void {
  viewEl = el;
  clearChrome();
  el.className = "screen on";
  const open = getSession();
  if (state.phase !== "running" && (!open || open.tool !== "audit")) {
    if (state.phase === "results") {
      // Fresh tool entry: workbench only, never a stale result screen.
      state.phase = "pick";
      state.report = null;
      state.selected = [];
      state.deleteMsg = null;
      state.emptiedFolders = [];
      state.foldersMsg = null;
      state.error = null;
    }
  }
  if (resumeRequested) {
    resumeRequested = false;
    if (restoreSessionScreen()) {
      paint();
      return;
    }
  }
  if (state.phase === "pick" && !state.suggestedTried && state.searchRoots.length === 0) {
    state.suggestedTried = true;
    void auditSuggestedRoots()
      .then((roots) => {
        if (state.searchRoots.length === 0 && roots.length > 0) {
          state.searchRoots = roots;
          saveSearchRoots(roots);
          paint();
        }
      })
      .catch(() => {
        // no suggestions — user adds roots manually
      });
  }
  paint();
}

function restoreSessionScreen(): boolean {
  const s = getSession();
  if (!s || s.tool !== "audit") return false;
  const run = loadAuditRun(s.id);
  if (run?.report) {
    state.phase = "results";
    state.libraryRoot = run.libraryRoot;
    state.searchRoots = [...run.searchRoots];
    state.report = run.report;
    state.selected = [];
    state.deleteMsg = null;
    state.emptiedFolders = [];
    state.foldersMsg = null;
    state.error = null;
    return true;
  }
  if (s.status === "active") {
    if (runActive) {
      state.phase = "running";
      state.error = null;
      return true;
    }
    state.phase = "pick";
    if (s.rootPath) state.libraryRoot = s.rootPath;
    state.error =
      "The previous audit never finished (the app was restarted or closed mid-run). Run it again.";
    updateSession(s.id, { progressLabel: "Interrupted — run again" });
    return true;
  }
  return false;
}

function paint(): void {
  if (!viewEl) return;
  const head = phaseHead(
    "04 / Audit",
    "Library Audit",
    "The library folder must hold exactly what Rekordbox references — nothing more.",
  );
  const body =
    state.phase === "pick"
      ? pickHtml()
      : state.phase === "running"
        ? jobProgressHtml("au-fill", "au-text", "Auditing")
        : resultsHtml();
  viewEl.innerHTML = `<div class="ov"><div class="mx">${head}${body}</div></div>`;
  bind();
}

function errHtml(): string {
  return state.error ? `<p class="warn-text">${esc(state.error)}</p>` : "";
}

function runBannerHtml(): string {
  if (!runActive || state.phase === "running") return "";
  return `<p class="warn-text">An audit is still running in the background — follow it on its session.</p>`;
}

/* ---- pick ---- */

function pickHtml(): string {
  const roots =
    state.searchRoots.length === 0
      ? `<p class="muted small">No search folders yet — twins can only be found inside searched folders.</p>`
      : `<div class="kv-list">${state.searchRoots
          .map(
            (r) => `<div class="kv-row"><span class="k-value" title="${esc(r)}">${esc(r)}</span>
              <button class="x" data-unroot="${esc(r)}" title="Remove">×</button></div>`,
          )
          .join("")}</div>`;
  return `<div class="sect">
      <h3>Library folder</h3>
      <div class="frow"><span class="fl">Folder</span>
        <input class="field" readonly style="flex:1" value="${esc(state.libraryRoot || "No folder selected (required)")}" />
        <button class="btn" id="au-pick-lib">Choose…</button></div>
      <p class="muted small">This folder should contain exactly your collected music — every unreferenced audio file in it is a leftover.</p>
    </div>
    <div class="sect">
      <h3>Stray-link search folders</h3>
      ${roots}
      <div class="frow"><button class="btn" id="au-add-root">Add folder…</button></div>
      <p class="muted small">Hardlink twins of library files are hunted here (same disk only — links can't cross filesystems). Try Downloads, staging and deemix folders.</p>
    </div>
    <div class="frow">
      <button class="btn primary" id="au-run" ${state.libraryRoot && !runActive ? "" : "disabled"}>Run library audit</button>
    </div>
    ${runBannerHtml()}
    ${errHtml()}`;
}

/* ---- results ---- */

function resultsHtml(): string {
  const r = state.report;
  if (!r) return errHtml();
  const s = summarizeAudit(r);
  const cov =
    s.twinFolders > 0
      ? `<p class="muted small">Twin coverage: ${r.twins_found_extra} of ${r.twins_total_extra} known extra links found${r.twins_total_extra > r.twins_found_extra ? " — the rest live outside your searched folders" : ""}.</p>`
      : "";
  const leftovers =
    r.leftovers.length === 0
      ? `<p class="ok-text">✓ No leftovers — the folder matches the database.</p>`
      : `<div class="kv-list">${r.leftovers
          .slice(0, 200)
          .map(
            (l) => `<div class="kv-row">
              <label class="opt"><input type="checkbox" class="chk" data-sel="${esc(l.path)}" ${state.selected.includes(l.path) ? "checked" : ""} />
              <span class="of">${esc(l.path.split("/").pop() ?? l.path)}<span class="ob">${
                l.kind === "duplicate"
                  ? `duplicate of ${esc((l.dupe_of ?? "").split("/").pop() ?? "")}`
                  : "orphan — in no playlist, matches nothing"
              } · ${esc(fmtBytes(l.size))}</span></span></label></div>`,
          )
          .join("")}</div>${r.leftovers.length > 200 ? `<p class="muted small">…and ${r.leftovers.length - 200} more — delete in batches, then re-run.</p>` : ""}`;
  const groups =
    r.stray_groups.length === 0
      ? `<p class="muted small">No stray hardlink twins inside the searched folders.</p>`
      : r.stray_groups
          .map(
            (g) => `<div class="sect" style="margin:8px 0 0"><h3>${esc(g.folder)} (${g.files.length})</h3>
              <div class="frow"><label class="opt"><input type="checkbox" class="chk" data-sel-group="${esc(g.folder)}" ${g.files.every((f) => state.selected.includes(f)) && g.files.length > 0 ? "checked" : ""} />
              <span class="of">Select all in this folder<span class="ob">Twins share data blocks — deleting frees 0 bytes, it frees the folder.</span></span></label></div>
              <div class="kv-list">${g.files
                .slice(0, 30)
                .map(
                  (f) => `<div class="kv-row">
                    <label class="opt"><input type="checkbox" class="chk" data-sel="${esc(f)}" ${state.selected.includes(f) ? "checked" : ""} />
                    <span class="of">${esc(f.split("/").pop() ?? f)}</span></label></div>`,
                )
                .join("")}${g.files.length > 30 ? `<p class="muted small">…and ${g.files.length - 30} more (select-all covers them).</p>` : ""}</div></div>`,
          )
          .join("");
  const infoList = (items: string[], empty: string) =>
    items.length === 0
      ? `<p class="muted small">${empty}</p>`
      : `<div class="kv-list">${items
          .slice(0, 20)
          .map((p) => `<div class="kv-row"><span class="k-value">${esc(p)}</span></div>`)
          .join("")}${items.length > 20 ? `<p class="muted small">…and ${items.length - 20} more.</p>` : ""}</div>`;
  return `<div class="sect"><h3>Audit complete</h3>
      <div class="stats">
        <div><b>${s.audioFiles}</b><span>files scanned</span></div>
        <div><b>${s.leftovers}</b><span>leftovers (${s.dupes} dupes · ${s.orphans} orphans)</span></div>
        <div><b>${s.twinFiles}</b><span>stray twins</span></div>
        <div><b>${esc(fmtBytes(s.wastedBytes))}</b><span>reclaimable</span></div>
      </div>
      ${cov}</div>
    <div class="sect"><h3>Leftovers in the library folder</h3>
      <p class="muted small">Duplicates are pre-ticked (provably redundant). Orphans are unticked — tick only what you recognise as junk.</p>
      ${leftovers}</div>
    <div class="sect"><h3>Stray hardlink twins</h3>${groups}</div>
    <div class="frow">
      <button class="btn primary" id="au-delete" ${state.selected.length ? "" : "disabled"}>
        Delete selected (${state.selected.length})</button>
      <button class="btn" id="au-rerun">Re-run audit</button>
      <button class="btn" id="au-close">Close session</button>
    </div>
    ${state.deleteMsg ? `<p class="ok-text">${esc(state.deleteMsg)}</p>` : ""}
    ${state.emptiedFolders.length ? `<div class="frow"><span class="fl">Folders</span>
      <span class="muted small" style="flex:1">${state.emptiedFolders.length} folder${state.emptiedFolders.length === 1 ? " became" : "s became"} empty.</span>
      <button class="btn" id="au-rmdirs">Remove them</button></div>` : ""}
    ${state.foldersMsg ? `<p class="ok-text">${esc(state.foldersMsg)}</p>` : ""}
    <div class="sect"><h3>Collected but elsewhere (${s.outside})</h3>
      ${infoList(r.outside_db, "Everything collected lives inside the loaded folder.")}
      <h3 style="margin-top:10px">Database rows pointing at missing files (${s.missing})</h3>
      ${infoList(r.missing_db, "No stale rows — every database entry resolves to a file.")}
      ${r.skipped_dirs.length ? `<h3 style="margin-top:10px">Unreadable folders (${r.skipped_dirs.length})</h3>${infoList(r.skipped_dirs, "")}` : ""}
    </div>
    ${errHtml()}`;
}

/* ---- wiring ---- */

function bind(): void {
  if (!viewEl) return;
  const q = (id: string) => viewEl!.querySelector<HTMLElement>(`#${id}`);
  const on = (id: string, fn: () => void) => q(id)?.addEventListener("click", fn);

  on("au-pick-lib", () => void pickLibrary());
  on("au-add-root", () => void addRoot());
  on("au-run", () => void runAudit());
  on("au-delete", () => void deleteSelected());
  on("au-rmdirs", () => void removeEmptiedFolders());
  on("au-rerun", () => void runAudit());
  on("au-close", () => {
    closeSession();
    resetAuditView();
    paint();
  });

  viewEl.querySelectorAll("[data-unroot]").forEach((b) => {
    b.addEventListener("click", () => {
      const r = (b as HTMLElement).dataset.unroot ?? "";
      state.searchRoots = state.searchRoots.filter((x) => x !== r);
      saveSearchRoots(state.searchRoots);
      paint();
    });
  });
  viewEl.querySelectorAll<HTMLInputElement>("[data-sel]").forEach((box) => {
    box.addEventListener("change", () => {
      const key = box.dataset.sel ?? "";
      state.selected = toggleSelected(state.selected, key);
      paint();
      refocus(`[data-sel="${cssEscape(key)}"]`);
    });
  });
  viewEl.querySelectorAll<HTMLInputElement>("[data-sel-group]").forEach((box) => {
    box.addEventListener("change", () => {
      const folder = box.dataset.selGroup ?? "";
      const group = state.report?.stray_groups.find((g) => g.folder === folder);
      if (!group) return;
      const allIn = group.files.every((f) => state.selected.includes(f));
      let sel = state.selected;
      for (const f of group.files) {
        const has = sel.includes(f);
        if (!allIn && !has) sel = [...sel, f];
        if (allIn && has) sel = sel.filter((p) => p !== f);
      }
      state.selected = sel;
      paint();
      refocus(`[data-sel-group="${cssEscape(folder)}"]`);
    });
  });
}

/** Restore focus after a toggle repaint (keyboard users). */
function refocus(selector: string): void {
  try {
    viewEl?.querySelector<HTMLElement>(selector)?.focus();
  } catch {
    // invalid selector edge — ignore
  }
}

function cssEscape(s: string): string {
  try {
    return CSS.escape(s);
  } catch {
    return s.replace(/["\\]/g, "\\$&");
  }
}

async function pickLibrary(): Promise<void> {
  try {
    const picked = await selectDirectory(loadPrefs().libraryRoot ?? undefined).catch(() => null);
    if (!picked) return;
    state.libraryRoot = picked;
    state.error = null;
  } catch (err) {
    state.error = `Could not pick a folder: ${errMsg(err)}`;
  }
  paint();
}

async function addRoot(): Promise<void> {
  try {
    const picked = await selectDirectory().catch(() => null);
    if (!picked) return;
    if (!state.searchRoots.includes(picked)) {
      state.searchRoots = [...state.searchRoots, picked];
      saveSearchRoots(state.searchRoots);
    }
    state.error = null;
  } catch (err) {
    state.error = `Could not pick a folder: ${errMsg(err)}`;
  }
  paint();
}

const PHASE_LABELS: Record<string, string> = {
  scan: "Walking folders",
  match: "Matching content",
  sweep: "Sweeping hardlinks",
  done: "Finishing",
};

async function runAudit(): Promise<void> {
  if (runActive) {
    state.error = "An audit is already running — wait for it to finish.";
    paint();
    return;
  }
  if (!state.libraryRoot) {
    state.error = "Pick the library folder first.";
    paint();
    return;
  }
  state.phase = "running";
  state.error = null;
  state.report = null;
  state.selected = [];
  state.deleteMsg = null;
  state.emptiedFolders = [];
  state.foldersMsg = null;
  paint();
  const runSessionId = openSession({ tool: "audit", rootPath: state.libraryRoot }).id;
  runActive = true;
  let lastPct = -1;
  updateSession(runSessionId, { status: "active", progressLabel: "Auditing…" });
  let detach: (() => void) | null = null;
  try {
    detach = await watchJobEvent<AuditProgress>("audit-progress", (p) => {
      const label = PHASE_LABELS[p.phase] ?? p.phase;
      paintJobProgress("au-fill", "au-text", p.processed, p.total, `${label} — ${p.processed}${p.total > 0 ? `/${p.total}` : ""}`);
      const pct = p.total > 0 ? Math.floor((p.processed / p.total) * 100) : -1;
      if (pct !== lastPct) {
        lastPct = pct;
        updateSession(runSessionId, { progressLabel: `${label} ${p.processed}${p.total > 0 ? `/${p.total}` : ""}` });
      }
    });
  } catch {
    // static progress; the result still lands
  }
  try {
    const report = await auditLibrary(state.libraryRoot, state.searchRoots);
    state.report = report;
    state.phase = "results";
    // Duplicates pre-ticked (provably redundant); orphans left unticked.
    state.selected = report.leftovers.filter((l) => l.kind === "duplicate").map((l) => l.path);
    for (const g of report.stray_groups) state.selected.push(...g.files);
    const s = summarizeAudit(report);
    updateSession(runSessionId, {
      status: "done",
      hasFollowUps: s.leftovers > 0 || s.twinFiles > 0,
      progressLabel: `${s.leftovers} leftovers · ${s.twinFiles} twins · ${fmtBytes(s.wastedBytes)}`,
    });
    saveAuditRun(runSessionId, {
      libraryRoot: state.libraryRoot,
      searchRoots: [...state.searchRoots],
      report,
    });
  } catch (err) {
    state.error = `Audit failed: ${errMsg(err)}`;
    state.phase = "pick";
    updateSession(runSessionId, { progressLabel: "Audit failed" });
  } finally {
    runActive = false;
    detachAll(detach);
    paint();
  }
}

async function confirmDialog(title: string, message: string): Promise<boolean> {
  try {
    return await showConfirmDialog(title, message);
  } catch {
    return window.confirm(`${title}\n\n${message}`);
  }
}

async function deleteSelected(): Promise<void> {
  const targets = [...state.selected];
  if (targets.length === 0) return;
  const ok = await confirmDialog(
    `Delete ${targets.length} file${targets.length === 1 ? "" : "s"}?`,
    "Only unreferenced files and stray twins are deletable — collected paths are refused even if ticked. This cannot be undone.",
  );
  if (!ok) return;
  state.deleteMsg = "Deleting…";
  state.foldersMsg = null;
  paint();
  try {
    const results = await deleteAuditPaths(targets);
    let deleted = 0;
    let refused = 0;
    let gone = 0;
    const deletedPaths: string[] = [];
    for (const res of results) {
      if (res.status === "deleted") {
        deleted++;
        deletedPaths.push(res.path);
      } else if (res.status === "refused_referenced") refused++;
      else gone++;
    }
    state.selected = state.selected.filter((p) => !deletedPaths.includes(p));
    // Drop deleted rows from the painted report.
    if (state.report) {
      const goneSet = new Set(deletedPaths);
      state.report = {
        ...state.report,
        leftovers: state.report.leftovers.filter((l) => !goneSet.has(l.path)),
        stray_groups: state.report.stray_groups
          .map((g) => ({ ...g, files: g.files.filter((f) => !goneSet.has(f)) }))
          .filter((g) => g.files.length > 0),
      };
      // Keep the resumed summary honest.
      const cur = getSession();
      if (cur && cur.tool === "audit") {
        saveAuditRun(cur.id, {
          libraryRoot: state.libraryRoot,
          searchRoots: [...state.searchRoots],
          report: state.report,
        });
      }
    }
    const bits = [`Deleted ${deleted} file${deleted === 1 ? "" : "s"}`];
    if (refused > 0) bits.push(`${refused} refused (collected)`);
    if (gone > 0) bits.push(`${gone} already gone/failed`);
    state.deleteMsg = bits.join(" · ") + ".";
    state.emptiedFolders = parentFolders(deletedPaths);
    state.foldersMsg = null;
  } catch (err) {
    state.deleteMsg = `Delete failed: ${errMsg(err)}`;
  }
  paint();
}

async function removeEmptiedFolders(): Promise<void> {
  const folders = [...state.emptiedFolders];
  if (folders.length === 0) return;
  const ok = await confirmDialog(
    `Remove ${folders.length} empty folder${folders.length === 1 ? "" : "s"}?`,
    "Only folders that are actually empty are removed; anything refilled meanwhile is kept.",
  );
  if (!ok) return;
  try {
    const results = await removeEmptyFolders(folders);
    const removed = results.filter((r) => r.status === "removed").length;
    const kept = results.length - removed;
    state.emptiedFolders = [];
    state.foldersMsg =
      removed > 0
        ? `Removed ${removed} empty folder${removed === 1 ? "" : "s"}${kept > 0 ? ` · ${kept} kept (not empty)` : ""}.`
        : "Nothing removed — the folders are not empty.";
  } catch (err) {
    state.foldersMsg = `Folder removal failed: ${errMsg(err)}`;
  }
  paint();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
