/* Library Audit: pick → run → results. Full sessions like the other
 * pipeline tools: the run opens a sidebar session (identity = tool +
 * library folder), live progress while auditing, restorable summary after.
 * Deleting a session removes the record only — never files. */
import { clearChrome, renderDock } from "../chrome.js";
import { phaseHead } from "../components.js";
import { detachAll, jobProgressHtml, paintJobProgress, watchJobEvent, } from "../jobs.js";
import { auditLibrary, auditSuggestedRoots, deleteAuditPaths, removeEmptyFolders, selectDirectory, showConfirmDialog, } from "../api.js";
import { loadPrefs } from "../policy.js";
import { closeSession, getSession, openSession, updateSession } from "../store.js";
import { esc, fmtBytes } from "../upgrader/utils.js";
import { loadAuditRun, loadSearchRoots, parentFolders, removeAuditRun, saveAuditRun, saveSearchRoots, summarizeAudit, toggleSelected, } from "./settings.js";
export { removeAuditRun };
const prefs = loadPrefs();
const state = {
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
const expandedLists = new Set();
const expandedTwinGroups = new Set();
function formatMiddleEllipsis(path, maxLength = 80) {
    if (path.length <= maxLength)
        return path;
    const parts = path.split("/");
    if (parts.length > 3) {
        const head = parts.slice(0, 2).join("/");
        const tail = parts.slice(-2).join("/");
        const candidate = `${head}/…/${tail}`;
        if (candidate.length <= maxLength)
            return candidate;
    }
    const half = Math.floor((maxLength - 1) / 2);
    return `${path.slice(0, half)}…${path.slice(-half)}`;
}
let viewEl = null;
let runActive = false;
let resumeRequested = false;
export function requestAuditResume() {
    resumeRequested = true;
}
export function resetAuditView() {
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
    expandedLists.clear();
    expandedTwinGroups.clear();
}
export function renderAudit(el) {
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
function restoreSessionScreen() {
    const s = getSession();
    if (!s || s.tool !== "audit")
        return false;
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
        if (s.rootPath)
            state.libraryRoot = s.rootPath;
        state.error =
            "The previous audit never finished (the app was restarted or closed mid-run). Run it again.";
        updateSession(s.id, { progressLabel: "Interrupted — run again" });
        return true;
    }
    return false;
}
function paint() {
    if (!viewEl)
        return;
    const head = phaseHead("05 · AUDIT", "Library Audit", "The library folder must hold exactly what Rekordbox references — nothing more.");
    const body = state.phase === "pick"
        ? pickHtml()
        : state.phase === "running"
            ? jobProgressHtml("au-fill", "au-text", "Auditing")
            : resultsHtml();
    viewEl.innerHTML = `<div class="ov"><div class="mx">${head}${body}</div></div>`;
    if (state.phase === "results") {
        renderDock(`Audit complete · ${state.selected.length} file${state.selected.length === 1 ? "" : "s"} selected for trash`, [
            {
                id: "au-dock-delete",
                label: `Move ${state.selected.length} file${state.selected.length === 1 ? "" : "s"} to Trash`,
                variant: "danger",
                disabled: state.selected.length === 0,
                onClick: () => void deleteSelected(),
            },
            {
                id: "au-dock-rerun",
                label: "Re-run audit",
                variant: "ghost",
                onClick: () => void runAudit(),
            },
            {
                id: "au-dock-close",
                label: "Close session",
                variant: "ghost",
                onClick: () => {
                    clearChrome();
                    closeSession();
                    resetAuditView();
                    paint();
                },
            },
        ]);
    }
    else {
        document.getElementById("dock")?.classList.add("hidden");
    }
    bind();
}
function errHtml() {
    return state.error ? `<p class="warn-text">${esc(state.error)}</p>` : "";
}
function runBannerHtml() {
    if (!runActive || state.phase === "running")
        return "";
    return `<p class="warn-text">An audit is still running in the background — follow it on its session.</p>`;
}
/* ---- pick ---- */
function pickHtml() {
    const roots = state.searchRoots.length === 0
        ? `<p class="muted small">No search folders yet — twins can only be found inside searched folders.</p>`
        : `<div class="kv-list">${state.searchRoots
            .map((r) => `<div class="kv-row"><span class="k-value" title="${esc(r)}">${esc(r)}</span>
              <button class="x" data-unroot="${esc(r)}" title="Remove">×</button></div>`)
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
function resultsHtml() {
    const r = state.report;
    if (!r)
        return errHtml();
    const s = summarizeAudit(r);
    const cov = s.twinFolders > 0
        ? `<p class="muted small">Twin coverage: ${r.twins_found_extra} of ${r.twins_total_extra} known extra links found${r.twins_total_extra > r.twins_found_extra ? " — the rest live outside your searched folders" : ""}.</p>`
        : "";
    const duplicates = r.leftovers.filter((l) => l.kind === "duplicate");
    const orphans = r.leftovers.filter((l) => l.kind !== "duplicate");
    const allDupesSelected = duplicates.length > 0 && duplicates.every((d) => state.selected.includes(d.path));
    const duplicatesSection = duplicates.length === 0
        ? `<div class="sect"><h3>Provable Duplicates</h3><p class="ok-text">✓ No duplicates — every file in the folder is unique.</p></div>`
        : `<div class="sect">
          <div class="frow" style="align-items:center;justify-content:space-between;margin-bottom:8px">
            <h3 style="margin:0">Provable Duplicates (${duplicates.length})</h3>
            <label class="opt" style="padding:0">
              <input type="checkbox" class="chk" id="au-toggle-all-dupes" ${allDupesSelected ? "checked" : ""} />
              <span class="of">Select all ${duplicates.length} duplicate${duplicates.length === 1 ? "" : "s"}</span>
            </label>
          </div>
          <p class="muted small" style="margin-top:0">Identical audio stream matches another track in Rekordbox. Pre-ticked and safe to move to Trash.</p>
          <div class="kv-list">${duplicates
            .slice(0, 200)
            .map((l) => `<div class="kv-row">
                <label class="opt"><input type="checkbox" class="chk" data-sel="${esc(l.path)}" ${state.selected.includes(l.path) ? "checked" : ""} />
                <span class="of">${esc(l.path.split("/").pop() ?? l.path)}<span class="ob">duplicate of ${esc((l.dupe_of ?? "").split("/").pop() ?? "")} · ${esc(fmtBytes(l.size))}</span></span></label></div>`)
            .join("")}</div>${duplicates.length > 200 ? `<p class="muted small">…and ${duplicates.length - 200} more — delete in batches, then re-run.</p>` : ""}
        </div>`;
    const allOrphansSelected = orphans.length > 0 && orphans.every((o) => state.selected.includes(o.path));
    const orphansSection = orphans.length === 0
        ? `<div class="sect"><h3>Unreferenced Orphans</h3><p class="ok-text">✓ No unreferenced orphans — every file in the folder is tracked in Rekordbox.</p></div>`
        : `<div class="sect">
          <div class="frow" style="align-items:center;justify-content:space-between;margin-bottom:8px">
            <h3 style="margin:0">Unreferenced Orphans (${orphans.length})</h3>
            <label class="opt" style="padding:0">
              <input type="checkbox" class="chk" id="au-toggle-all-orphans" ${allOrphansSelected ? "checked" : ""} />
              <span class="of">Select all ${orphans.length} orphan${orphans.length === 1 ? "" : "s"}</span>
            </label>
          </div>
          <p class="muted small" style="margin-top:0">Files living in your library folder that are not referenced by any playlist or database row. Unticked by default — tick only what you recognise as junk.</p>
          <div class="kv-list">${orphans
            .slice(0, 200)
            .map((l) => `<div class="kv-row">
                <label class="opt"><input type="checkbox" class="chk" data-sel="${esc(l.path)}" ${state.selected.includes(l.path) ? "checked" : ""} />
                <span class="of">${esc(l.path.split("/").pop() ?? l.path)}<span class="ob">orphan — in no playlist, matches nothing · ${esc(fmtBytes(l.size))}</span></span></label></div>`)
            .join("")}</div>${orphans.length > 200 ? `<p class="muted small">…and ${orphans.length - 200} more — delete in batches, then re-run.</p>` : ""}
        </div>`;
    const groups = r.stray_groups.length === 0
        ? `<p class="muted small">No stray hardlink twins inside the searched folders.</p>`
        : r.stray_groups
            .map((g) => {
            const allIn = g.files.length > 0 && g.files.every((f) => state.selected.includes(f));
            const isExpanded = expandedTwinGroups.has(g.folder);
            const displayFiles = isExpanded ? g.files : g.files.slice(0, 10);
            const toggleBtn = g.files.length > 10
                ? `<div style="margin-top:6px">
                    <button class="link-btn small" data-toggle-twin-group="${esc(g.folder)}">${isExpanded
                    ? `Show fewer (showing all ${g.files.length} twins)`
                    : `Show all ${g.files.length} twins (${g.files.length - 10} hidden) ⌄`}</button>
                  </div>`
                : "";
            return `<div class="sect" style="margin:8px 0 0">
              <div class="frow" style="align-items:center;justify-content:space-between">
                <h3 style="margin:0">${esc(g.folder)} (${g.files.length} twin${g.files.length === 1 ? "" : "s"})</h3>
              </div>
              <div class="frow" style="margin:6px 0">
                <label class="opt">
                  <input type="checkbox" class="chk" data-sel-group="${esc(g.folder)}" ${allIn ? "checked" : ""} />
                  <span class="of">Select all ${g.files.length} twin${g.files.length === 1 ? "" : "s"} in this folder tree<span class="ob">Twins share data blocks with your library — trashing frees the folder structure without deleting library audio.</span></span>
                </label>
              </div>
              <div class="kv-list">${displayFiles
                .map((f) => `<div class="kv-row">
                    <label class="opt"><input type="checkbox" class="chk" data-sel="${esc(f)}" ${state.selected.includes(f) ? "checked" : ""} />
                    <span class="of">${esc(f.split("/").pop() ?? f)}<span class="ob">${esc(f)}</span></span></label></div>`)
                .join("")}</div>
              ${toggleBtn}
            </div>`;
        })
            .join("");
    const infoList = (id, items, empty) => {
        if (items.length === 0) {
            return `<p class="muted small">${empty}</p>`;
        }
        const isExpanded = expandedLists.has(id);
        const displayItems = isExpanded ? items : items.slice(0, 20);
        const expandToggle = items.length > 20
            ? `<div style="margin-top:6px">
            <button class="link-btn small" data-toggle-list="${id}">${isExpanded
                ? `Show fewer (showing all ${items.length})`
                : `Show all ${items.length} items (${items.length - 20} hidden)`}</button>
          </div>`
            : "";
        return `<div class="kv-list">${displayItems
            .map((p) => `<div class="audit-path-row"><span class="audit-path-text" title="${esc(p)}">${esc(formatMiddleEllipsis(p))}</span></div>`)
            .join("")}</div>${expandToggle}`;
    };
    return `<div class="sect"><h3>Audit complete</h3>
      <div class="stats">
        <div class="stat"><div class="v">${s.audioFiles.toLocaleString()}</div><div class="l">files scanned</div></div>
        <div class="stat"><div class="v">${s.leftovers.toLocaleString()}</div><div class="l">leftovers (${s.dupes} dupes · ${s.orphans} orphans)</div></div>
        <div class="stat"><div class="v">${s.twinFiles.toLocaleString()}</div><div class="l">stray twins</div></div>
        <div class="stat"><div class="v">${esc(fmtBytes(s.wastedBytes))}</div><div class="l">reclaimable</div></div>
      </div>
      ${cov}</div>
    ${duplicatesSection}
    ${orphansSection}
    <div class="sect"><h3>Stray hardlink twins</h3>${groups}</div>
    ${state.deleteMsg ? `<p class="ok-text">${esc(state.deleteMsg)}</p>` : ""}
    ${state.emptiedFolders.length ? `<div class="frow"><span class="fl">Folders</span>
      <span class="muted small" style="flex:1">${state.emptiedFolders.length} folder${state.emptiedFolders.length === 1 ? " became" : "s became"} empty.</span>
      <button class="btn" id="au-rmdirs">Remove them</button></div>` : ""}
    ${state.foldersMsg ? `<p class="ok-text">${esc(state.foldersMsg)}</p>` : ""}
    <div class="sect">
      <div class="frow" style="align-items:center;justify-content:space-between">
        <h3 style="margin:0">Collected but elsewhere (${s.outside})</h3>
        ${r.outside_db.length > 0 ? `<button class="btn sm" id="au-consolidate-btn">Consolidate ${r.outside_db.length} external tracks →</button>` : ""}
      </div>
      ${infoList("outside_db", r.outside_db, "Everything collected lives inside the loaded folder.")}
      <div class="frow" style="align-items:center;justify-content:space-between;margin-top:14px">
        <h3 style="margin:0">Database rows pointing at missing files (${s.missing})</h3>
        ${r.missing_db.length > 0 ? `<button class="btn sm" id="au-export-missing-csv">Export missing (.csv)</button>` : ""}
      </div>
      ${infoList("missing_db", r.missing_db, "No stale rows — every database entry resolves to a file.")}
      ${r.fake_lossless && r.fake_lossless.length > 0 ? `
      <h3 style="margin-top:14px">Fake Lossless Transcodes (${r.fake_lossless.length})</h3>
      <p class="muted small" style="margin:0 0 6px">Spek Guard detected brickwall lowpass cutoffs at ~16 kHz in these files. They are likely upscaled lossy files pretending to be lossless.</p>
      <div class="kv-list">${r.fake_lossless.map(f => `
        <div class="kv-row" style="display:flex; justify-content:space-between; align-items:center;">
          <span class="of" style="flex:1;">
            <span class="badge warn" style="margin-right:6px;">⚠ Fake Lossless</span>
            ${esc(f.split("/").pop() ?? f)}
            <span class="ob" style="display:block;">${esc(f)}</span>
          </span>
          <button class="btn small" data-upgrade-fake="${esc(f)}">Upgrade in CrateUp</button>
        </div>
      `).join("")}</div>` : ""}
      ${r.streaming_db && r.streaming_db.length > 0 ? `
      <h3 style="margin-top:14px">Streaming / Cloud tracks (${r.streaming_db.length})</h3>
      <p class="muted small" style="margin:0 0 6px">Tracks streamed from online services (Spotify, Tidal, SoundCloud, etc.) do not have local audio files.</p>
      ${infoList("streaming_db", r.streaming_db, "No streaming tracks.")}` : ""}
      ${r.skipped_dirs.length ? `<h3 style="margin-top:14px">Unreadable folders (${r.skipped_dirs.length})</h3>${infoList("skipped_dirs", r.skipped_dirs, "")}` : ""}
    </div>
    ${errHtml()}`;
}
/* ---- wiring ---- */
function bind() {
    if (!viewEl)
        return;
    const q = (id) => viewEl.querySelector(`#${id}`);
    const on = (id, fn) => q(id)?.addEventListener("click", fn);
    on("au-pick-lib", () => void pickLibrary());
    on("au-add-root", () => void addRoot());
    on("au-run", () => void runAudit());
    on("au-rmdirs", () => void removeEmptiedFolders());
    on("au-consolidate-btn", () => {
        window.location.hash = "#/cleaner";
    });
    on("au-export-missing-csv", () => {
        const list = state.report?.missing_db ?? [];
        if (list.length === 0)
            return;
        const csvHeader = "File Path\n";
        const csvRows = list.map((p) => `"${p.replace(/"/g, '""')}"`).join("\n");
        const blob = new Blob([csvHeader + csvRows], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `crateup-missing-db-tracks-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
    viewEl.querySelectorAll("[data-toggle-list]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const listId = btn.dataset.toggleList;
            if (!listId)
                return;
            if (expandedLists.has(listId)) {
                expandedLists.delete(listId);
            }
            else {
                expandedLists.add(listId);
            }
            paint();
        });
    });
    viewEl.querySelectorAll("[data-toggle-twin-group]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const folder = btn.dataset.toggleTwinGroup;
            if (!folder)
                return;
            if (expandedTwinGroups.has(folder)) {
                expandedTwinGroups.delete(folder);
            }
            else {
                expandedTwinGroups.add(folder);
            }
            paint();
        });
    });
    q("au-toggle-all-dupes")?.addEventListener("change", (e) => {
        const checked = e.target.checked;
        const dupes = state.report?.leftovers.filter((l) => l.kind === "duplicate").map((l) => l.path) ?? [];
        if (dupes.length === 0)
            return;
        if (checked) {
            const set = new Set(state.selected);
            for (const p of dupes)
                set.add(p);
            state.selected = Array.from(set);
        }
        else {
            state.selected = state.selected.filter((p) => !dupes.includes(p));
        }
        paint();
    });
    q("au-toggle-all-orphans")?.addEventListener("change", (e) => {
        const checked = e.target.checked;
        const orphans = state.report?.leftovers.filter((l) => l.kind !== "duplicate").map((l) => l.path) ?? [];
        if (orphans.length === 0)
            return;
        if (checked) {
            const set = new Set(state.selected);
            for (const p of orphans)
                set.add(p);
            state.selected = Array.from(set);
        }
        else {
            state.selected = state.selected.filter((p) => !orphans.includes(p));
        }
        paint();
    });
    viewEl.querySelectorAll("[data-unroot]").forEach((b) => {
        b.addEventListener("click", () => {
            const r = b.dataset.unroot ?? "";
            state.searchRoots = state.searchRoots.filter((x) => x !== r);
            saveSearchRoots(state.searchRoots);
            paint();
        });
    });
    viewEl.querySelectorAll("[data-sel]").forEach((box) => {
        box.addEventListener("change", () => {
            const key = box.dataset.sel ?? "";
            state.selected = toggleSelected(state.selected, key);
            paint();
            refocus(`[data-sel="${cssEscape(key)}"]`);
        });
    });
    viewEl.querySelectorAll("[data-sel-group]").forEach((box) => {
        box.addEventListener("change", () => {
            const folder = box.dataset.selGroup ?? "";
            const group = state.report?.stray_groups.find((g) => g.folder === folder);
            if (!group)
                return;
            const allIn = group.files.every((f) => state.selected.includes(f));
            let sel = state.selected;
            for (const f of group.files) {
                const has = sel.includes(f);
                if (!allIn && !has)
                    sel = [...sel, f];
                if (allIn && has)
                    sel = sel.filter((p) => p !== f);
            }
            state.selected = sel;
            paint();
            refocus(`[data-sel-group="${cssEscape(folder)}"]`);
        });
    });
    viewEl.querySelectorAll("[data-upgrade-fake]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const filePath = btn.dataset.upgradeFake;
            if (filePath) {
                const folder = filePath.substring(0, filePath.lastIndexOf("/"));
                openSession({ tool: "upgrader", rootPath: folder || state.libraryRoot, sourceKind: "folder" });
                window.location.hash = "#/upgrader";
            }
        });
    });
}
/** Restore focus after a toggle repaint (keyboard users). */
function refocus(selector) {
    try {
        viewEl?.querySelector(selector)?.focus();
    }
    catch {
        // invalid selector edge — ignore
    }
}
function cssEscape(s) {
    try {
        return CSS.escape(s);
    }
    catch {
        return s.replace(/["\\]/g, "\\$&");
    }
}
async function pickLibrary() {
    try {
        const picked = await selectDirectory(loadPrefs().libraryRoot ?? undefined).catch(() => null);
        if (!picked)
            return;
        state.libraryRoot = picked;
        state.error = null;
    }
    catch (err) {
        state.error = `Could not pick a folder: ${errMsg(err)}`;
    }
    paint();
}
async function addRoot() {
    try {
        const picked = await selectDirectory().catch(() => null);
        if (!picked)
            return;
        if (!state.searchRoots.includes(picked)) {
            state.searchRoots = [...state.searchRoots, picked];
            saveSearchRoots(state.searchRoots);
        }
        state.error = null;
    }
    catch (err) {
        state.error = `Could not pick a folder: ${errMsg(err)}`;
    }
    paint();
}
const PHASE_LABELS = {
    scan: "Walking folders",
    match: "Matching content",
    sweep: "Sweeping hardlinks",
    done: "Finishing",
};
async function runAudit() {
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
    let detach = null;
    try {
        detach = await watchJobEvent("audit-progress", (p) => {
            const label = PHASE_LABELS[p.phase] ?? p.phase;
            paintJobProgress("au-fill", "au-text", p.processed, p.total, `${label} — ${p.processed}${p.total > 0 ? `/${p.total}` : ""}`);
            const pct = p.total > 0 ? Math.floor((p.processed / p.total) * 100) : -1;
            if (pct !== lastPct) {
                lastPct = pct;
                updateSession(runSessionId, { progressLabel: `${label} ${p.processed}${p.total > 0 ? `/${p.total}` : ""}` });
            }
        });
    }
    catch {
        // static progress; the result still lands
    }
    try {
        const report = await auditLibrary(state.libraryRoot, state.searchRoots);
        state.report = report;
        state.phase = "results";
        // Duplicates pre-ticked (provably redundant); orphans left unticked.
        state.selected = report.leftovers.filter((l) => l.kind === "duplicate").map((l) => l.path);
        for (const g of report.stray_groups)
            state.selected.push(...g.files);
        const s = summarizeAudit(report);
        updateSession(runSessionId, {
            status: s.leftovers > 0 || s.twinFiles > 0 ? "review" : "done",
            hasFollowUps: s.leftovers > 0 || s.twinFiles > 0,
            progressLabel: `${s.leftovers} leftovers · ${s.twinFiles} twins · ${fmtBytes(s.wastedBytes)}`,
        });
        saveAuditRun(runSessionId, {
            libraryRoot: state.libraryRoot,
            searchRoots: [...state.searchRoots],
            report,
        });
    }
    catch (err) {
        state.error = `Audit failed: ${errMsg(err)}`;
        state.phase = "pick";
        updateSession(runSessionId, { progressLabel: "Audit failed" });
    }
    finally {
        runActive = false;
        detachAll(detach);
        paint();
    }
}
async function confirmDialog(title, message) {
    try {
        return await showConfirmDialog(title, message);
    }
    catch {
        return window.confirm(`${title}\n\n${message}`);
    }
}
async function deleteSelected() {
    const targets = [...state.selected];
    if (targets.length === 0)
        return;
    const ok = await confirmDialog(`Delete ${targets.length} file${targets.length === 1 ? "" : "s"}?`, "Only unreferenced files and stray twins are deletable — collected paths are refused even if ticked. This cannot be undone.");
    if (!ok)
        return;
    state.deleteMsg = "Deleting…";
    state.foldersMsg = null;
    paint();
    try {
        const results = await deleteAuditPaths(targets);
        let deleted = 0;
        let refused = 0;
        let gone = 0;
        const deletedPaths = [];
        for (const res of results) {
            if (res.status === "deleted") {
                deleted++;
                deletedPaths.push(res.path);
            }
            else if (res.status === "refused_referenced")
                refused++;
            else
                gone++;
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
                const s = summarizeAudit(state.report);
                const hasRemaining = s.leftovers > 0 || s.twinFiles > 0;
                updateSession(cur.id, {
                    status: hasRemaining ? "review" : "done",
                    hasFollowUps: hasRemaining,
                    progressLabel: hasRemaining
                        ? `${s.leftovers} leftovers · ${s.twinFiles} twins · ${fmtBytes(s.wastedBytes)}`
                        : "Audit clean · 0 leftovers",
                });
                saveAuditRun(cur.id, {
                    libraryRoot: state.libraryRoot,
                    searchRoots: [...state.searchRoots],
                    report: state.report,
                });
            }
        }
        const bits = [`Deleted ${deleted} file${deleted === 1 ? "" : "s"}`];
        if (refused > 0)
            bits.push(`${refused} refused (collected)`);
        if (gone > 0)
            bits.push(`${gone} already gone/failed`);
        state.deleteMsg = bits.join(" · ") + ".";
        state.emptiedFolders = parentFolders(deletedPaths);
        state.foldersMsg = null;
    }
    catch (err) {
        state.deleteMsg = `Delete failed: ${errMsg(err)}`;
    }
    paint();
}
async function removeEmptiedFolders() {
    const folders = [...state.emptiedFolders];
    if (folders.length === 0)
        return;
    const ok = await confirmDialog(`Remove ${folders.length} empty folder${folders.length === 1 ? "" : "s"}?`, "Only folders that are actually empty are removed; anything refilled meanwhile is kept.");
    if (!ok)
        return;
    try {
        const results = await removeEmptyFolders(folders);
        const removed = results.filter((r) => r.status === "removed").length;
        const kept = results.length - removed;
        state.emptiedFolders = [];
        state.foldersMsg =
            removed > 0
                ? `Removed ${removed} empty folder${removed === 1 ? "" : "s"}${kept > 0 ? ` · ${kept} kept (not empty)` : ""}.`
                : "Nothing removed — the folders are not empty.";
    }
    catch (err) {
        state.foldersMsg = `Folder removal failed: ${errMsg(err)}`;
    }
    paint();
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
