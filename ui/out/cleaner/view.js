/* Library Cleaner: strategy → intake → options → run → summary.
 * Stateless like Compare (no sessions): the destination folder + the
 * backend's own `master.db` snapshot are the durable record.
 * Backend: xml.rs (safe-clone) + rekordbox.rs (db consolidation). */
import { clearChrome } from "../chrome.js";
import { phaseHead } from "../components.js";
import { detachAll, jobProgressHtml, paintJobProgress, watchJobEvent, } from "../jobs.js";
import { checkRekordboxStatus, executeBackupCleanup, executeDbConsolidation, executeSafeClone, fixRekordboxDbDuplicates, getDbBackups, getXmlTrackCount, openDirectory, parseAndValidateXml, rollbackToLatestBackup, selectDirectory, selectXmlFile, showConfirmDialog, } from "../api.js";
import { loadPrefs } from "../policy.js";
import { esc } from "../upgrader/utils.js";
import { closeSession, getSession, openSession, updateSession, } from "../store.js";
import { cleanupReportLine, loadCleanerModifiers, loadCleanerPaths, loadCleanerRun, loadCleanerStrategy, saveCleanerModifiers, saveCleanerPaths, saveCleanerRun, saveCleanerStrategy, summarizeCleanup, } from "./settings.js";
const savedPaths = loadCleanerPaths();
const state = {
    phase: "strategy",
    strategy: loadCleanerStrategy(),
    xmlPath: savedPaths.xmlPath,
    xmlCount: null,
    validated: null,
    validating: false,
    db: null,
    dbChecking: false,
    fixMsg: null,
    destPath: savedPaths.destPath,
    opts: loadCleanerModifiers(),
    result: null,
    error: null,
    backups: null,
    backupSel: "",
    actionMsg: null,
};
let viewEl = null;
/** True while a consolidation is in flight (module lifetime = app boot).
 *  Survives view resets: closing the screen never cancels the backend job. */
let runActive = false;
/** Set when the user clicks the session entry in the sidebar. */
let resumeRequested = false;
export function requestCleanerResume() {
    resumeRequested = true;
}
/** Drop screen state back to the fresh strategy picker. Never touches a
 *  live run: the backend job and its session updates keep going. */
export function resetCleanerView() {
    if (runActive) {
        // Screen only; the run's closure still owns its session id.
        state.phase = "strategy";
        state.error = null;
        state.actionMsg = null;
        return;
    }
    resumeRequested = false;
    state.phase = "strategy";
    state.validated = null;
    state.validating = false;
    state.result = null;
    state.error = null;
    state.actionMsg = null;
    state.backups = null;
    state.fixMsg = null;
}
export function renderCleaner(el) {
    viewEl = el;
    clearChrome();
    el.className = "screen on";
    // Another tool owns the open session: land fresh — unless our own run
    // is live (the run opened its session when it started).
    const open = getSession();
    if ((!open || open.tool !== "cleaner") && state.phase !== "running") {
        resetCleanerView();
    }
    if (resumeRequested) {
        resumeRequested = false;
        if (restoreSessionScreen()) {
            paint();
            void loadBackups().then(() => paint());
            return;
        }
    }
    paint();
}
/** Restore the done screen from the open session's run record.
 *  No record + active session means the run never finished:
 *  - same boot with the job alive (`runActive`) → back to the live view;
 *  - otherwise (restart, crash) → options with an "interrupted" notice. */
function restoreSessionScreen() {
    const s = getSession();
    if (!s || s.tool !== "cleaner")
        return false;
    const run = loadCleanerRun(s.id);
    if (run) {
        state.phase = "done";
        state.strategy = run.strategy;
        state.xmlPath = run.xmlPath;
        state.destPath = run.destPath;
        state.opts = { ...run.opts };
        state.result = { ...run.result };
        state.error = null;
        state.actionMsg = null;
        state.backups = null;
        state.backupSel = "";
        return true;
    }
    if (s.status === "active") {
        if (runActive) {
            state.phase = "running";
            state.error = null;
            return true;
        }
        // Fresh boot (or dead run): prefs survived in localStorage, the result
        // didn't. Land on intake with the story, keep the session for the retry.
        state.phase = "intake";
        state.strategy = s.sourceKind === "db" ? "db" : "xml";
        if (s.rootPath)
            state.destPath = s.rootPath;
        state.error = "The previous run never finished (the app was restarted or closed mid-run). Check the inputs and run again.";
        updateSession(s.id, { progressLabel: "Interrupted — re-run to complete" });
        return true;
    }
    return false;
}
function paint() {
    if (!viewEl)
        return;
    const head = phaseHead("02 / Cleaner", "Library Cleaner", "Consolidate and dedupe without losing Rekordbox metadata.");
    let body = "";
    if (state.phase === "strategy")
        body = strategyHtml();
    else if (state.phase === "intake")
        body = intakeHtml();
    else if (state.phase === "options")
        body = optionsHtml();
    else if (state.phase === "running")
        body = runningHtml();
    else
        body = doneHtml();
    viewEl.innerHTML = `<div class="ov"><div class="mx">${head}${body}</div></div>`;
    bind();
}
function errHtml() {
    return state.error ? `<p class="warn-text">${esc(state.error)}</p>` : "";
}
/** Shown on idle screens while a run continues in the background. */
function runBannerHtml() {
    if (!runActive || state.phase === "running")
        return "";
    return `<p class="warn-text">A consolidation is still running in the background — follow it on its session. Starting another run stays disabled until it finishes.</p>`;
}
/* ---- strategy ---- */
function strategyHtml() {
    const s = state.strategy;
    return `<div class="sect">
      <h3>Strategy</h3>
      <div class="seg" role="tablist">
        <button data-strat="xml" class="${s === "xml" ? "on" : ""}">XML Export Clone</button>
        <button data-strat="db" class="${s === "db" ? "on" : ""}">Direct Database</button>
      </div>
      <p class="muted small">${s === "db"
        ? "Writes paths directly into Rekordbox's live master.db (snapshot first). Close Rekordbox before running."
        : "Copies files to a new folder and writes a remapped crateup_collection.xml for manual import into Rekordbox."}</p>
      <div class="frow">
        <button class="btn primary" id="cl-to-intake" ${s ? "" : "disabled"}>Continue to inputs</button>
      </div>
    </div>
    ${runBannerHtml()}
    ${errHtml()}`;
}
/* ---- intake ---- */
function intakeHtml() {
    const isDb = state.strategy === "db";
    const intake = isDb ? dbIntakeHtml() : xmlIntakeHtml();
    const ready = isDb
        ? state.db !== null && state.db.db_exists && !state.db.running && state.destPath !== ""
        : state.validated !== null && state.destPath !== "";
    return `${intake}
    <div class="sect">
      <h3>Destination</h3>
      <div class="frow">
        <span class="fl">Folder</span>
        <input class="field" readonly value="${esc(state.destPath || "No folder selected (required)")}" style="flex:1" />
        <button class="btn" id="cl-pick-dest">Choose…</button>
      </div>
      <p class="muted small">Consolidated files land here, preserving quality: duplicates resolve to the best-quality copy.</p>
      <div class="frow">
        <button class="btn" id="cl-back-strategy">Back</button>
        <button class="btn primary" id="cl-to-options" ${ready ? "" : "disabled"}>Validate &amp; lock inputs</button>
      </div>
    </div>
    ${runBannerHtml()}
    ${errHtml()}`;
}
function xmlIntakeHtml() {
    const v = state.validated;
    const status = state.validating
        ? jobProgressHtml("cl-fill", "cl-text", "Validating XML")
        : v
            ? `<p class="ok-text">✓ ${v.healthy} healthy · ⚠ ${v.missing} missing on disk</p>`
            : state.xmlCount !== null
                ? `<p class="muted small">${state.xmlCount} tracks declared in XML — validate to check files on disk.</p>`
                : "";
    return `<div class="sect">
      <h3>Collection XML</h3>
      <div class="frow">
        <span class="fl">XML file</span>
        <input class="field" readonly value="${esc(state.xmlPath || "No file selected")}" style="flex:1" />
        <button class="btn" id="cl-pick-xml">Browse…</button>
        <button class="btn" id="cl-validate" ${state.xmlPath && !state.validating ? "" : "disabled"}>Validate</button>
      </div>
      ${status}
    </div>`;
}
function dbIntakeHtml() {
    const db = state.db;
    const status = state.dbChecking
        ? `<p class="muted small">Checking Rekordbox status…</p>`
        : db
            ? db.running
                ? `<p class="warn-text">⚠ Rekordbox is running — close it before consolidating (the database is locked).</p>`
                : db.db_exists
                    ? `<p class="ok-text">✓ master.db found<span class="muted"> — ${esc(db.db_path)}</span></p>`
                    : `<p class="warn-text">⚠ master.db not found at ${esc(db.db_path)}.</p>`
            : `<p class="muted small">Check that Rekordbox is closed and the live database is reachable.</p>`;
    return `<div class="sect">
      <h3>Live database</h3>
      ${status}
      <div class="frow">
        <button class="btn" id="cl-db-recheck" ${state.dbChecking ? "disabled" : ""}>↺ Recheck status</button>
        <button class="btn" id="cl-db-fixdupes" ${db && !db.running ? "" : "disabled"}>Repair duplicates</button>
      </div>
      ${state.fixMsg ? `<p class="ok-text">${esc(state.fixMsg)}</p>` : ""}
    </div>`;
}
/* ---- options ---- */
function optionsHtml() {
    const o = state.opts;
    const sel = (id, label, options, current) => `<div class="frow"><span class="fl">${label}</span><select class="pop" id="${id}">${options
        .map(([v, t]) => `<option value="${v}"${v === current ? " selected" : ""}>${t}</option>`)
        .join("")}</select></div>`;
    return `<div class="sect">
      <h3>Modifiers</h3>
      ${sel("cl-filemode", "File mode", [["copy", "Copy files"], ["move", "Move files"], ["link", "Hardlink"]], o.fileMode)}
      ${sel("cl-crossfmt", "Cross-format", [["smart", "Merge different formats"], ["strict", "Keep formats separated"]], o.crossFormat)}
      ${sel("cl-dedup", "Dedup", [["strict", "Exact same file"], ["standard", "Same artist + title"], ["fuzzy", "Audio comparison (>90%)"]], o.dedupDepth)}
      ${sel("cl-rename", "Renaming", [["preserve", "Native filenames"], ["clean", "Artist - Title"]], o.renamingRule)}
      <p class="muted small">${state.strategy === "db" ? "A dated master.db snapshot is taken automatically before any write." : "Missing tracks are skipped; the XML is rewritten to point at the copies."}</p>
      <div class="frow">
        <button class="btn" id="cl-back-intake">Back</button>
        <button class="btn primary" id="cl-run" ${runActive ? "disabled" : ""}>Consolidate library</button>
      </div>
    </div>
    ${runBannerHtml()}
    ${errHtml()}`;
}
/* ---- running / done ---- */
function runningHtml() {
    return jobProgressHtml("cl-fill", "cl-text", "Consolidating");
}
function doneHtml() {
    const r = state.result;
    if (!r)
        return errHtml();
    const metrics = `<div class="sect"><h3>Consolidation complete</h3>
      <div class="stats">
        <div><b>${r.healthy_count}</b><span>processed</span></div>
        <div><b>${r.duplicate_count}</b><span>duplicates remapped</span></div>
        <div><b>${r.missing_count}</b><span>missing skipped</span></div>
      </div></div>`;
    const actions = state.strategy === "db" ? dbDoneHtml(r) : xmlDoneHtml();
    return `${metrics}${actions}
    <div class="frow">
      <button class="btn" id="cl-rerun">Run again</button>
      <button class="btn" id="cl-start-over">Close session</button>
    </div>
    ${errHtml()}`;
}
function xmlDoneHtml() {
    return `<div class="sect">
      <h3>Output</h3>
      <p class="muted small">Files copied to the destination. Import <b>crateup_collection.xml</b> from the destination folder into Rekordbox (File → Import).</p>
      <div class="frow">
        <button class="btn" id="cl-open-dest">Open destination</button>
      </div>
    </div>`;
}
function dbDoneHtml(r) {
    const backupLine = r.backup_filename
        ? `<p class="muted small">Snapshot: <b>${esc(r.backup_filename)}</b> (next to the live master.db).</p>`
        : "";
    const backups = state.backups;
    const cleanup = backups === null
        ? ""
        : `<div class="frow"><span class="fl">Backup</span>
        <select class="pop" id="cl-backup-sel">${backups.map((b) => `<option value="${esc(b)}"${b === state.backupSel ? " selected" : ""}>${esc(b)}</option>`).join("")}</select>
        <button class="btn" id="cl-cleanup" ${state.backupSel ? "" : "disabled"}>Delete old files</button>
      </div>`;
    return `<div class="sect">
      <h3>Safety</h3>
      ${backupLine}
      <p class="muted small">Delete old files removes copies no longer referenced by the live database. Rollback restores the latest snapshot.</p>
      ${cleanup}
      ${state.actionMsg ? `<p class="ok-text">${esc(state.actionMsg)}</p>` : ""}
      <div class="frow">
        <button class="btn" id="cl-rollback">⚠ Rollback to backup</button>
      </div>
    </div>`;
}
/* ---- wiring ---- */
function bind() {
    if (!viewEl)
        return;
    const q = (id) => viewEl.querySelector(`#${id}`);
    const on = (id, fn) => q(id)?.addEventListener("click", fn);
    viewEl.querySelectorAll("[data-strat]").forEach((b) => {
        b.addEventListener("click", () => {
            state.strategy = b.dataset.strat;
            saveCleanerStrategy(state.strategy);
            if (state.strategy === "db" && !state.db && !state.dbChecking)
                void refreshDbStatus();
            paint();
        });
    });
    on("cl-to-intake", () => {
        state.phase = "intake";
        state.error = null;
        if (state.strategy === "db" && !state.db && !state.dbChecking)
            void refreshDbStatus();
        paint();
    });
    on("cl-back-strategy", () => {
        state.phase = "strategy";
        paint();
    });
    on("cl-pick-xml", () => void pickXml());
    on("cl-validate", () => void validateXml());
    on("cl-pick-dest", () => void pickDest());
    on("cl-db-recheck", () => void refreshDbStatus());
    on("cl-db-fixdupes", () => void fixDupes());
    on("cl-to-options", () => {
        state.phase = "options";
        state.error = null;
        paint();
    });
    on("cl-back-intake", () => {
        state.phase = "intake";
        paint();
    });
    on("cl-run", () => void runConsolidation());
    on("cl-open-dest", () => {
        if (state.destPath)
            void openDirectory(state.destPath).catch((e) => console.error(e));
    });
    on("cl-cleanup", () => void runCleanup());
    on("cl-rollback", () => void runRollback());
    on("cl-start-over", () => {
        // Non-destructive: the session (and its summary) stays in the sidebar.
        closeSession();
        resetCleanerView();
        paint();
    });
    on("cl-rerun", () => {
        state.phase = "options";
        state.result = null;
        state.error = null;
        state.actionMsg = null;
        paint();
    });
    const sel = (id, fn) => {
        viewEl.querySelector(`#${id}`)?.addEventListener("change", (e) => {
            fn(e.target.value);
        });
    };
    sel("cl-filemode", (v) => saveOpts({ fileMode: v }));
    sel("cl-crossfmt", (v) => saveOpts({ crossFormat: v }));
    sel("cl-dedup", (v) => saveOpts({ dedupDepth: v }));
    sel("cl-rename", (v) => saveOpts({ renamingRule: v }));
    sel("cl-backup-sel", (v) => {
        state.backupSel = v;
    });
}
function saveOpts(patch) {
    state.opts = { ...state.opts, ...patch };
    saveCleanerModifiers(state.opts);
}
async function pickXml() {
    try {
        const picked = await selectXmlFile();
        if (!picked)
            return;
        state.xmlPath = picked;
        state.validated = null;
        try {
            state.xmlCount = await getXmlTrackCount(picked);
        }
        catch {
            state.xmlCount = null;
        }
        saveCleanerPaths({ xmlPath: state.xmlPath, destPath: state.destPath });
    }
    catch (err) {
        state.error = `Could not pick an XML file: ${errMsg(err)}`;
    }
    paint();
}
async function validateXml() {
    if (!state.xmlPath)
        return;
    state.validating = true;
    state.validated = null;
    state.error = null;
    paint();
    let detach = null;
    try {
        detach = await watchJobEvent("xml-scan-progress", (p) => {
            paintJobProgress("cl-fill", "cl-text", p.processed, p.total, `${p.track_name} — ${p.processed}/${p.total}`);
        });
    }
    catch {
        // progress stays static; the result still lands
    }
    try {
        const raw = (await parseAndValidateXml(state.xmlPath));
        state.validated = { healthy: raw.healthy_count, missing: raw.missing_count };
    }
    catch (err) {
        state.error = `Validation failed: ${errMsg(err)}`;
    }
    finally {
        detachAll(detach);
        state.validating = false;
        paint();
    }
}
async function pickDest() {
    try {
        const picked = await selectDirectory(loadPrefs().libraryRoot ?? undefined).catch(() => null);
        if (!picked)
            return;
        state.destPath = picked;
        saveCleanerPaths({ xmlPath: state.xmlPath, destPath: state.destPath });
    }
    catch (err) {
        state.error = `Could not pick a destination: ${errMsg(err)}`;
    }
    paint();
}
async function refreshDbStatus() {
    state.dbChecking = true;
    state.error = null;
    paint();
    try {
        state.db = (await checkRekordboxStatus());
    }
    catch (err) {
        state.error = `Status check failed: ${errMsg(err)}`;
    }
    finally {
        state.dbChecking = false;
        paint();
    }
}
async function fixDupes() {
    state.fixMsg = null;
    state.error = null;
    paint();
    try {
        const n = await fixRekordboxDbDuplicates();
        state.fixMsg = n === 0 ? "No duplicate database rows found." : `Repaired ${n} duplicate row${n === 1 ? "" : "s"}.`;
    }
    catch (err) {
        state.error = `Duplicate repair failed: ${errMsg(err)}`;
    }
    paint();
}
async function runConsolidation() {
    if (runActive) {
        state.error = "A consolidation is already running — wait for it to finish before starting another.";
        paint();
        return;
    }
    if (!state.destPath) {
        state.error = "Pick a destination folder first.";
        state.phase = "options";
        paint();
        return;
    }
    if (state.strategy === "db") {
        try {
            const st = (await checkRekordboxStatus());
            state.db = st;
            if (st.running) {
                state.error = "Rekordbox is open — close it first (the database is locked).";
                state.phase = "options";
                paint();
                return;
            }
        }
        catch (err) {
            state.error = `Status check failed: ${errMsg(err)}`;
            state.phase = "options";
            paint();
            return;
        }
    }
    state.phase = "running";
    state.error = null;
    state.result = null;
    paint();
    // The run gets a sidebar session: identity is tool + destination, so
    // re-running the same folder resumes its record instead of duplicating.
    // The id is closure-owned: closing the screen mid-run must not stop the
    // session updates or the saved record when the job lands.
    const runSessionId = openSession({
        tool: "cleaner",
        rootPath: state.destPath,
        sourceKind: state.strategy,
    }).id;
    runActive = true;
    let lastPct = -1;
    updateSession(runSessionId, { status: "active", progressLabel: "Consolidating…" });
    let detach = null;
    try {
        detach = await watchJobEvent("rebuilder-consolidation-progress", (p) => {
            paintJobProgress("cl-fill", "cl-text", p.processed, p.total, `${p.filename} — ${p.processed}/${p.total}`);
            const pct = p.total > 0 ? Math.floor((p.processed / p.total) * 100) : -1;
            if (pct !== lastPct) {
                lastPct = pct;
                updateSession(runSessionId, { progressLabel: `${p.processed}/${p.total} consolidated` });
            }
        });
    }
    catch {
        // static progress; the result still lands
    }
    try {
        const opts = {
            destinationPath: state.destPath,
            ...state.opts,
            threshold: loadPrefs().match.acousticThreshold,
        };
        const raw = state.strategy === "db"
            ? await executeDbConsolidation(opts)
            : await executeSafeClone(state.xmlPath, opts);
        state.result = raw;
        state.phase = "done";
        if (state.strategy === "db")
            await loadBackups();
        if (state.result) {
            const r = state.result;
            updateSession(runSessionId, {
                status: "done",
                hasFollowUps: state.strategy === "db",
                progressLabel: `${r.healthy_count} processed · ${r.duplicate_count} dupes · ${r.missing_count} missing`,
            });
            saveCleanerRun(runSessionId, {
                strategy: state.strategy ?? "xml",
                xmlPath: state.xmlPath,
                destPath: state.destPath,
                opts: { ...state.opts },
                result: { ...r },
            });
        }
    }
    catch (err) {
        state.error = `Consolidation failed: ${errMsg(err)}`;
        state.phase = "options";
        updateSession(runSessionId, { progressLabel: "Run failed" });
    }
    finally {
        runActive = false;
        detachAll(detach);
        paint();
    }
}
async function loadBackups() {
    try {
        const list = await getDbBackups();
        state.backups = list;
        const own = state.result?.backup_filename ?? "";
        state.backupSel = own && list.includes(own) ? own : (list[list.length - 1] ?? "");
    }
    catch {
        state.backups = [];
    }
}
async function runCleanup() {
    if (!state.backupSel)
        return;
    const ok = await confirmDialog("Delete old files?", `Delete files referenced by ${state.backupSel} but no longer in the live database? This cannot be undone.`);
    if (!ok)
        return;
    state.actionMsg = "Cleaning up…";
    paint();
    try {
        const raw = (await executeBackupCleanup(state.backupSel));
        state.actionMsg = `Cleanup: ${cleanupReportLine(summarizeCleanup(raw.results ?? []))}.`;
    }
    catch (err) {
        state.actionMsg = `Cleanup failed: ${errMsg(err)}`;
    }
    paint();
}
async function runRollback() {
    const ok = await confirmDialog("Rollback to backup?", "Restore the latest master.db snapshot over the live database? Rekordbox must stay closed.");
    if (!ok)
        return;
    state.actionMsg = "Restoring backup…";
    paint();
    try {
        const name = await rollbackToLatestBackup();
        state.actionMsg = `Restored ${name} over the live database.`;
    }
    catch (err) {
        state.actionMsg = `Rollback failed: ${errMsg(err)}`;
    }
    paint();
}
async function confirmDialog(title, message) {
    try {
        return await showConfirmDialog(title, message);
    }
    catch {
        return window.confirm(`${title}\n\n${message}`);
    }
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
