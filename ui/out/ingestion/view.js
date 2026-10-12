/* Ingestion Hub: single-page workbench (stage → configure → run → summary).
 * Full sessions like the Cleaner: the run opens a sidebar session (identity
 * = tool + output XML path), live progress while running, restorable summary
 * after. Deleting a session keeps the destination folder and XML. */
import { clearChrome } from "../chrome.js";
import { phaseHead } from "../components.js";
import { detachAll, jobProgressHtml, paintJobProgress, watchJobEvent, } from "../jobs.js";
import { executePlaylistIngestion, expandAudioPaths, getFileSize, openDirectory, selectAudioFiles, selectDirectory, selectSaveXmlFile, } from "../api.js";
import { loadPrefs } from "../policy.js";
import { closeSession, getSession, openSession, updateSession } from "../store.js";
import { esc } from "../upgrader/utils.js";
import { addStagedTracks, defaultXmlName, loadIngestDest, loadIngestionRun, loadLibraryCheck, loadStagedPaths, removeStagedTrack, saveIngestDest, saveIngestionRun, saveLibraryCheck, saveStagedPaths, stagedFromPaths, trackFromPath, validateIngestInputs, } from "./settings.js";
import { loadCleanerModifiers, saveCleanerModifiers } from "../cleaner/settings.js";
const state = {
    phase: "workbench",
    // Always boot empty: staged paths persist only for in-app navigation
    // (see persistStaged). A restart is a fresh workbench, never a
    // resurrection — closing must actually close.
    staged: [],
    playlistName: "",
    destPath: loadIngestDest(),
    opts: loadCleanerModifiers(),
    libraryCheck: loadLibraryCheck(),
    xmlSavePath: "",
    importing: false,
    result: null,
    error: null,
};
function persistStaged() {
    saveStagedPaths(state.staged.map((t) => t.path));
}
// Boot wipes navigation memory: anything persisted belongs to a previous
// app lifetime and must not resurrect (see above).
persistStaged();
let viewEl = null;
let runActive = false;
let resumeRequested = false;
export function requestIngestionResume() {
    resumeRequested = true;
}
export function resetIngestionView() {
    if (runActive) {
        state.phase = "workbench";
        state.error = null;
        return;
    }
    // Explicit fresh start (close/delete/nav): workbench memory is wiped —
    // entering the tool must never resurrect a closed session's files.
    resumeRequested = false;
    state.phase = "workbench";
    state.staged = [];
    persistStaged();
    state.playlistName = "";
    state.result = null;
    state.error = null;
    state.xmlSavePath = "";
}
export function renderIngestion(el) {
    viewEl = el;
    clearChrome();
    el.className = "screen on";
    const open = getSession();
    if (state.phase !== "running") {
        if (!open || open.tool !== "ingestion") {
            // Fresh tool entry without a session: workbench memory only (staged
            // files survive plain navigation), never a result screen.
            state.phase = "workbench";
            state.staged = stagedFromPaths(loadStagedPaths());
            state.result = null;
            state.error = null;
            state.xmlSavePath = "";
        }
    }
    if (resumeRequested) {
        resumeRequested = false;
        if (restoreSessionScreen()) {
            paint();
            return;
        }
    }
    paint();
}
function restoreSessionScreen() {
    const s = getSession();
    if (!s || s.tool !== "ingestion")
        return false;
    const run = loadIngestionRun(s.id);
    if (run) {
        state.phase = "done";
        state.playlistName = run.playlistName;
        state.destPath = run.destPath;
        state.xmlSavePath = run.xmlSavePath;
        state.staged = stagedFromPaths(run.stagedFiles);
        state.opts = { ...run.opts };
        state.result = { ...run.result };
        state.error = null;
        return true;
    }
    if (s.status === "active") {
        if (runActive) {
            state.phase = "running";
            state.error = null;
            return true;
        }
        state.phase = "workbench";
        if (s.playlistName)
            state.playlistName = s.playlistName;
        if (s.rootPath) {
            state.destPath = s.rootPath;
            saveIngestDest(s.rootPath);
        }
        state.staged = stagedFromPaths(loadStagedPaths());
        state.error =
            state.staged.length > 0
                ? "The previous run never finished (the app was restarted or closed mid-run). Check the inputs and run again."
                : "The previous run never finished (the app was restarted or closed mid-run). Stage the files again and run.";
        updateSession(s.id, { progressLabel: "Interrupted — retry the run" });
        return true;
    }
    return false;
}
function paint() {
    if (!viewEl)
        return;
    const head = phaseHead("03 / Ingestion", "Ingestion Hub", "Loose tracks in, clean playlist out.");
    const body = state.phase === "workbench"
        ? workbenchHtml()
        : state.phase === "running"
            ? jobProgressHtml("ig-fill", "ig-text", "Ingesting")
            : doneHtml();
    viewEl.innerHTML = `<div class="ov"><div class="mx">${head}${body}</div></div>`;
    bind();
}
function errHtml() {
    return state.error ? `<p class="warn-text">${esc(state.error)}</p>` : "";
}
function runBannerHtml() {
    if (!runActive || state.phase === "running")
        return "";
    return `<p class="warn-text">An ingestion is still running in the background — follow it on its session. Starting another run stays disabled until it finishes.</p>`;
}
function workbenchHtml() {
    const rows = state.staged.length === 0
        ? `<p class="muted small">Nothing staged yet.</p>`
        : `<div class="kv-list">${state.staged
            .map((t) => `<div class="kv-row"><span class="k-label">${esc(t.format || "—")}</span>
              <span class="k-value" title="${esc(t.path)}">${esc(t.name)} <span class="muted">· ${esc(t.size)}</span></span>
              <button class="x" data-unstage="${esc(t.path)}" title="Remove">×</button></div>`)
            .join("")}</div>`;
    const v = validateIngestInputs(state.staged.length, state.playlistName, state.destPath);
    const o = state.opts;
    return `<div class="sect">
      <h3>Stage tracks</h3>
      <div id="ig-drop" class="ig-drop" title="Click to browse, or drag files here">
        <b>${state.importing ? "Reading files…" : state.staged.length === 0 ? "Drop audio files here or click to browse" : `＋ Add more files (${state.staged.length} staged)`}</b>
        <span class="muted small">MP3 · WAV · FLAC · AIFF · M4A — folders expand non-recursively</span>
      </div>
      <div class="frow">
        <button class="btn" id="ig-clear" ${state.staged.length ? "" : "disabled"}>Clear staged</button>
      </div>
      ${rows}
    </div>
    <div class="sect">
      <h3>Playlist</h3>
      <div class="frow"><span class="fl">Name</span>
        <input class="field" id="ig-name" style="flex:1" placeholder="E.g. Winter Club Cuts" value="${esc(state.playlistName)}" /></div>
      <div class="frow"><span class="fl">Folder</span>
        <input class="field" readonly style="flex:1" value="${esc(state.destPath || "No folder selected (required)")}" />
        <button class="btn" id="ig-dest">Choose…</button></div>
    </div>
    <div class="sect">
      <h3>Modifiers</h3>
      <div class="frow"><span class="fl">Library</span>
        <label class="opt"><input type="checkbox" class="chk" id="ig-libcheck" ${state.libraryCheck ? "checked" : ""} />
        <span class="of">Match the Rekordbox library<span class="ob">Songs already collected link to their existing file — no copy, no duplicate entry. Skipped when no local master.db.</span></span></label></div>
      <div class="frow"><span class="fl">File mode</span><select class="pop" id="ig-filemode">
        ${opt("copy", "Copy files", o.fileMode)}${opt("move", "Move files", o.fileMode)}${opt("link", "Hardlink", o.fileMode)}</select></div>
      <div class="frow"><span class="fl">Cross-format</span><select class="pop" id="ig-crossfmt">
        ${opt("smart", "Merge different formats", o.crossFormat)}${opt("strict", "Keep formats separated", o.crossFormat)}</select></div>
      <div class="frow"><span class="fl">Dedup</span><select class="pop" id="ig-dedup">
        ${opt("strict", "Exact same file", o.dedupDepth)}${opt("standard", "Same artist + title", o.dedupDepth)}${opt("fuzzy", "Audio comparison (>90%)", o.dedupDepth)}</select></div>
      <div class="frow"><span class="fl">Renaming</span><select class="pop" id="ig-rename">
        ${opt("preserve", "Native filenames", o.renamingRule)}${opt("clean", "Artist - Title", o.renamingRule)}</select></div>
      <p class="muted small">Dedup prefs are shared with the Library Cleaner.</p>
    </div>
    <div class="frow">
      <button class="btn primary" id="ig-run" ${v.ok && !runActive && !state.importing ? "" : "disabled"}>Run playlist ingestion</button>
    </div>
    <p class="muted small" id="ig-reasons">${v.ok ? "" : esc(v.reasons.join(" "))}</p>
    ${runBannerHtml()}
    ${errHtml()}`;
}
function opt(value, label, current) {
    return `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`;
}
function doneHtml() {
    const r = state.result;
    if (!r)
        return errHtml();
    const linked = r.library_matched_count ?? 0;
    const fresh = Math.max(0, r.healthy_count - r.duplicate_count - linked);
    return `<div class="sect"><h3>Ingestion complete</h3>
      <div class="stats">
        <div><b>${fresh}</b><span>new files</span></div>
        <div><b>${linked}</b><span>already in library</span></div>
        <div><b>${r.duplicate_count}</b><span>duplicates filtered</span></div>
        <div><b>${r.missing_count}</b><span>missing skipped</span></div>
      </div>
      <div class="kv-list">
        <div class="kv-row"><span class="k-label">Playlist</span><span class="k-value">${esc(state.playlistName)}</span></div>
        <div class="kv-row"><span class="k-label">Folder</span><span class="k-value">${esc(state.destPath)}</span></div>
        <div class="kv-row"><span class="k-label">XML</span><span class="k-value">${esc(state.xmlSavePath)}</span></div>
      </div>
      <p class="muted small">Import the XML into Rekordbox (File → Import) to get the playlist.</p>
      <div class="frow">
        <button class="btn" id="ig-open-dest">Open destination</button>
        <button class="btn" id="ig-again">Ingest more</button>
        <button class="btn" id="ig-close">Close session</button>
      </div>
    </div>
    ${errHtml()}`;
}
/* ---- wiring ---- */
function bind() {
    if (!viewEl)
        return;
    const q = (id) => viewEl.querySelector(`#${id}`);
    const on = (id, fn) => q(id)?.addEventListener("click", fn);
    const drop = q("ig-drop");
    if (drop) {
        drop.addEventListener("click", () => void browseFiles());
        drop.addEventListener("dragover", (e) => {
            e.preventDefault();
            drop.classList.add("over");
        });
        drop.addEventListener("dragleave", () => drop.classList.remove("over"));
        drop.addEventListener("drop", (e) => {
            e.preventDefault();
            drop.classList.remove("over");
            const files = e.dataTransfer?.files;
            if (!files || files.length === 0)
                return;
            const paths = [];
            for (let i = 0; i < files.length; i++) {
                const p = files[i].path;
                if (p)
                    paths.push(p);
            }
            if (paths.length > 0)
                void addPaths(paths);
            else {
                state.error = "Drop didn't expose file paths — use click to browse instead.";
                paint();
            }
        });
    }
    viewEl.querySelectorAll("[data-unstage]").forEach((b) => {
        b.addEventListener("click", () => {
            const p = b.dataset.unstage ?? "";
            state.staged = removeStagedTrack(state.staged, p);
            persistStaged();
            paint();
        });
    });
    on("ig-clear", () => {
        state.staged = [];
        persistStaged();
        paint();
    });
    viewEl.querySelector("#ig-name")?.addEventListener("input", (e) => {
        state.playlistName = e.target.value;
        refreshRunButton();
    });
    on("ig-dest", () => void pickDest());
    on("ig-run", () => void runIngestion());
    on("ig-open-dest", () => {
        if (state.destPath)
            void openDirectory(state.destPath).catch((err) => console.error(err));
    });
    on("ig-again", () => {
        state.phase = "workbench";
        state.staged = [];
        persistStaged();
        state.result = null;
        state.error = null;
        state.xmlSavePath = "";
        paint();
    });
    on("ig-close", () => {
        closeSession();
        resetIngestionView();
        paint();
    });
    const sel = (id, fn) => {
        viewEl.querySelector(`#${id}`)?.addEventListener("change", (e) => {
            fn(e.target.value);
        });
    };
    sel("ig-filemode", (v) => saveOpts({ fileMode: v }));
    sel("ig-crossfmt", (v) => saveOpts({ crossFormat: v }));
    sel("ig-dedup", (v) => saveOpts({ dedupDepth: v }));
    sel("ig-rename", (v) => saveOpts({ renamingRule: v }));
    viewEl.querySelector("#ig-libcheck")?.addEventListener("change", (e) => {
        state.libraryCheck = e.target.checked;
        saveLibraryCheck(state.libraryCheck);
    });
}
function saveOpts(patch) {
    state.opts = { ...state.opts, ...patch };
    saveCleanerModifiers(state.opts);
}
/** Toggle run readiness without a full repaint (keeps name-input focus). */
function refreshRunButton() {
    const v = validateIngestInputs(state.staged.length, state.playlistName, state.destPath);
    const btn = viewEl?.querySelector("#ig-run");
    if (btn)
        btn.disabled = !v.ok || runActive || state.importing;
    const hint = viewEl?.querySelector("#ig-reasons");
    if (hint)
        hint.textContent = v.ok ? "" : v.reasons.join(" ");
}
async function browseFiles() {
    let paths = null;
    try {
        paths = await selectAudioFiles();
    }
    catch (err) {
        state.error = `Could not open the file picker: ${errMsg(err)}`;
        paint();
        return;
    }
    if (!paths || paths.length === 0)
        return;
    await addPaths(paths);
}
async function addPaths(paths) {
    state.importing = true;
    state.error = null;
    paint();
    try {
        const res = await expandAudioPaths(paths);
        const incoming = [];
        for (const p of res.files ?? []) {
            let size = 0;
            try {
                size = (await getFileSize(p)) ?? 0;
            }
            catch {
                // size stays unknown
            }
            incoming.push(trackFromPath(p, size));
        }
        state.staged = addStagedTracks(state.staged, incoming);
        persistStaged();
        if (res.suggested_playlist_name && state.playlistName.trim() === "") {
            state.playlistName = res.suggested_playlist_name;
        }
        if (incoming.length === 0) {
            state.error = "No audio files found in that selection.";
        }
    }
    catch (err) {
        state.error = `Could not read those files: ${errMsg(err)}`;
    }
    finally {
        state.importing = false;
        paint();
    }
}
async function pickDest() {
    try {
        const picked = await selectDirectory(loadPrefs().libraryRoot ?? undefined).catch(() => null);
        if (!picked)
            return;
        state.destPath = picked;
        saveIngestDest(picked);
    }
    catch (err) {
        state.error = `Could not pick a destination: ${errMsg(err)}`;
    }
    paint();
}
async function runIngestion() {
    if (runActive || state.importing) {
        state.error = state.importing
            ? "Still reading dropped files — run in a moment."
            : "An ingestion is already running — wait for it to finish.";
        paint();
        return;
    }
    const v = validateIngestInputs(state.staged.length, state.playlistName, state.destPath);
    if (!v.ok) {
        state.error = v.reasons.join(" ");
        paint();
        return;
    }
    // XML target first: cancelling aborts before anything is written.
    let xmlSavePath = null;
    try {
        xmlSavePath = await selectSaveXmlFile(defaultXmlName(state.playlistName));
    }
    catch (err) {
        state.error = `Export picker failed: ${errMsg(err)}`;
        paint();
        return;
    }
    if (!xmlSavePath)
        return;
    state.xmlSavePath = xmlSavePath;
    state.phase = "running";
    state.error = null;
    state.result = null;
    paint();
    const runSessionId = openSession({
        tool: "ingestion",
        rootPath: state.destPath,
        playlistName: state.playlistName,
        ledgerPath: xmlSavePath,
        isSessionDir: true,
    }).id;
    runActive = true;
    let lastPct = -1;
    updateSession(runSessionId, { status: "active", progressLabel: "Ingesting…" });
    let detach = null;
    try {
        detach = await watchJobEvent("ingest-consolidation-progress", (p) => {
            paintJobProgress("ig-fill", "ig-text", p.processed, p.total, `${p.filename} — ${p.processed}/${p.total}`);
            const pct = p.total > 0 ? Math.floor((p.processed / p.total) * 100) : -1;
            if (pct !== lastPct) {
                lastPct = pct;
                updateSession(runSessionId, { progressLabel: `${p.processed}/${p.total} ingested` });
            }
        });
    }
    catch {
        // static progress; the result still lands
    }
    try {
        const raw = await executePlaylistIngestion({
            stagedFiles: state.staged.map((t) => t.path),
            playlistName: state.playlistName.trim(),
            destinationPath: state.destPath,
            ...state.opts,
            threshold: loadPrefs().match.acousticThreshold,
            libraryCheck: state.libraryCheck,
            xmlSavePath,
        });
        state.result = raw;
        state.phase = "done";
        const r = state.result;
        const linked = r.library_matched_count ?? 0;
        updateSession(runSessionId, {
            status: "done",
            hasFollowUps: false,
            progressLabel: `${r.healthy_count - r.duplicate_count - linked} new · ${linked} linked`,
        });
        saveIngestionRun(runSessionId, {
            playlistName: state.playlistName.trim(),
            destPath: state.destPath,
            xmlSavePath,
            stagedFiles: state.staged.map((t) => t.path),
            opts: { ...state.opts },
            result: { ...r },
        });
    }
    catch (err) {
        state.error = `Ingestion failed: ${errMsg(err)}`;
        state.phase = "workbench";
        updateSession(runSessionId, { progressLabel: "Run failed" });
    }
    finally {
        runActive = false;
        detachAll(detach);
        paint();
    }
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
