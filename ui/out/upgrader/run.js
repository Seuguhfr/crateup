/* Upgrader configure → run → done. Owns the pipeline event listeners
   and the run screen's live updates. */
import { clearSession, getSession, setSession, updateSession, } from "../store.js";
import { cancelPipeline, readLedgerFile, resetSession, showConfirmDialog, startPipeline, } from "../api.js";
import { phaseHead } from "../components.js";
import { renderDock, renderUpgraderStage } from "../chrome.js";
import { watchPipelineRun } from "../jobs.js";
import { loadPrefs as loadAppPrefs } from "../policy.js";
import { countLedger, getMissedTracks, parseProgressLine, } from "./utils.js";
const LOG_CAP = 500;
const run = {
    active: false,
    processed: 0,
    total: 0,
    logLines: [],
    unlistenPipeline: null,
};
export function isRunActive() {
    return run.active;
}
const PREF_FORMAT = "upgrader_format";
const PREF_SKIP_HQ = "upgrader_skip_high_quality";
const PREF_SKIP_MAX = "upgrader_skip_deezer_max";
function loadPrefs() {
    return {
        // Per-run choice wins; otherwise the shared Settings default applies.
        format: localStorage.getItem(PREF_FORMAT) ?? loadAppPrefs().outputFormat ?? "flac",
        skipHq: localStorage.getItem(PREF_SKIP_HQ) === "true",
        skipMax: localStorage.getItem(PREF_SKIP_MAX) === "true",
    };
}
function sourceLabel(res) {
    const s = getSession();
    if (res.sourceKind === "folder")
        return `Folder: ${res.rootPath}`;
    return `Playlist: ${s?.playlistName ?? res.rootPath}`;
}
function syncNativeCheckboxes(scope) {
    scope
        .querySelectorAll('input.chk[type="checkbox"]')
        .forEach((inp) => {
        inp.classList.toggle("on", inp.checked);
        inp.addEventListener("change", () => inp.classList.toggle("on", inp.checked));
    });
}
export function renderConfigure(el, res, notice, cb) {
    el.className = "screen on";
    const prefs = loadPrefs();
    const counts = res.existing ? countLedger(res.existing) : null;
    const processed = counts ? counts.total - counts.pending : 0;
    const isResume = counts !== null && counts.total > 0 && counts.pending > 0 && processed > 0;
    const statusText = !counts
        ? "No progress ledger found. Set up and start a new scan and download pipeline."
        : isResume
            ? `Previous session detected. Resuming from track ${processed + 1} of ${counts.total}.`
            : "Ready to start a fresh scan.";
    const lockedFormat = isResume
        ? (res.existing?.output_format ?? prefs.format)
        : prefs.format;
    el.innerHTML = `
    <div class="ov">
      <div class="mx">
        ${phaseHead("01 · UPGRADER · CONFIGURE", "Configure the run", `${sourceLabel(res)}. Set the output, then start. The run continues on its own; results land in Done.`)}
        <div class="sect">
          <h3>Run configuration</h3>
          <div class="frow">
            <span class="fl">Output format</span>
            <select id="ug-format" class="pop" ${isResume ? "disabled" : ""}>
              <option value="mp3" ${lockedFormat === "mp3" ? "selected" : ""}>MP3 320 kbps</option>
              <option value="flac" ${lockedFormat === "flac" ? "selected" : ""}>FLAC (Lossless)</option>
              <option value="aiff" ${lockedFormat === "aiff" ? "selected" : ""}>AIFF (Lossless)</option>
              <option value="wav" ${lockedFormat === "wav" ? "selected" : ""}>WAV (Lossless)</option>
            </select>
          </div>
          <label class="opt" style="margin-top:8px">
            <input type="checkbox" class="chk" id="ug-skip-hq" ${prefs.skipHq ? "checked" : ""} />
            <span class="of">Skip files above 320 kbps<span class="ob">Also skips any lossless original — a lossy upgrade can only equal, never beat, that.</span></span>
          </label>
          <label class="opt">
            <input type="checkbox" class="chk" id="ug-skip-max" ${prefs.skipMax ? "checked" : ""} />
            <span class="of">Skip if already Deezer lossless<span class="ob">Identified by barcode + ISRC metadata on the original.</span></span>
          </label>
        </div>
        <div class="sect">
          <h3>Session</h3>
          <div class="kv-list">
            <div class="kv-row"><span class="k-label">Source</span><span class="k-value">${sourceLabel(res)}</span></div>
            <div class="kv-row"><span class="k-label">State</span><span class="k-value">${isResume ? "resume" : "new"}</span></div>
          </div>
          <p class="${isResume ? "warn-text" : "muted"}" style="margin:10px 0 0">${notice ?? statusText}</p>
        </div>
      </div>
    </div>`;
    renderUpgraderStage(1);
    renderDock("Configure · next action starts the run", [
        {
            id: "ug-back",
            label: "Change source",
            variant: "ghost",
            onClick: cb.onBack,
        },
        {
            id: "ug-reset",
            label: "Reset session",
            variant: "danger-ghost",
            onClick: cb.onReset,
        },
        {
            id: "ug-close",
            label: "Close session",
            variant: "ghost",
            onClick: cb.onClose,
        },
        {
            id: "ug-start",
            label: "Start Scan & Download",
            variant: "primary",
            onClick: cb.onStart,
        },
    ]);
    syncNativeCheckboxes(el);
}
export function readConfigureForm(el) {
    const format = el.querySelector("#ug-format")?.value ?? "flac";
    const skipHq = el.querySelector("#ug-skip-hq")?.checked ?? false;
    const skipMax = el.querySelector("#ug-skip-max")?.checked ?? false;
    localStorage.setItem(PREF_FORMAT, format);
    localStorage.setItem(PREF_SKIP_HQ, String(skipHq));
    localStorage.setItem(PREF_SKIP_MAX, String(skipMax));
    setSession({ outputFormat: format });
    return { format, skipHq, skipMax };
}
/* ---------------- running ---------------- */
function paintProgress() {
    const text = document.getElementById("ug-progress-text");
    const pct = document.getElementById("ug-progress-pct");
    const count = document.getElementById("ug-progress-count");
    const fill = document.getElementById("ug-progress-fill");
    if (!text || !pct || !fill)
        return;
    if (run.total === 0) {
        text.textContent = "Processing: scanning…";
        pct.textContent = "0%";
        if (count)
            count.textContent = "0 / 0";
        fill.style.width = "0%";
        return;
    }
    const percent = Math.min(100, (run.processed / run.total) * 100);
    text.textContent = `Processing: ${run.processed} / ${run.total} files`;
    pct.textContent = `${Math.round(percent)}%`;
    if (count)
        count.textContent = `${run.processed} / ${run.total}`;
    fill.style.width = `${percent}%`;
}
function appendLog(line) {
    run.logLines.push(line);
    if (run.logLines.length > LOG_CAP) {
        run.logLines.splice(0, run.logLines.length - LOG_CAP);
    }
    const panel = document.getElementById("ug-log");
    if (!panel)
        return;
    if (panel.querySelector(".log-placeholder"))
        panel.innerHTML = "";
    const div = document.createElement("div");
    div.className = "log-line";
    div.textContent = line.replace(/\n$/, "");
    panel.appendChild(div);
    panel.scrollTop = panel.scrollHeight;
}
export function renderRunning(el) {
    el.className = "screen on";
    el.innerHTML = `
    <div class="pc">
      <div class="pbox">
        <span class="k">03 · Run · ${sourceLabelOfRun()}</span>
        <div class="pn">
          <span class="n" id="ug-progress-pct">0%</span>
          <span class="c">files</span>
        </div>
        <div class="pbar"><i id="ug-progress-fill"></i></div>
        <div class="pr">
          <span class="trunc" id="ug-progress-text">Processing: scanning…</span>
          <b id="ug-progress-count">0 / 0</b>
        </div>
        <div id="ug-run-arl-alert" class="alert warn hidden" style="margin-top:12px;font-size:12px;padding:8px 12px;line-height:1.4"></div>
        <div class="term">
          <div class="thead">
            <span class="k">Pipeline log</span>
            <button class="btn iv" id="ug-clear-log">Clear</button>
          </div>
          <div class="tbody" id="ug-log"></div>
        </div>
      </div>
    </div>`;
    renderUpgraderStage(2);
    renderDock("Run · state is saved to the ledger as it goes", [
        {
            id: "ug-cancel-run",
            label: "Stop pipeline",
            variant: "danger-ghost",
            onClick: async () => {
                try {
                    await cancelPipeline();
                }
                catch (err) {
                    console.error("Failed to cancel pipeline:", err);
                }
            },
        },
    ]);
    const panel = el.querySelector("#ug-log");
    if (panel) {
        if (run.logLines.length > 0) {
            for (const line of run.logLines) {
                const div = document.createElement("div");
                div.className = "log-line";
                div.textContent = line.replace(/\n$/, "");
                panel.appendChild(div);
            }
            panel.scrollTop = panel.scrollHeight;
        }
        else {
            const ph = document.createElement("div");
            ph.className = "log-line log-placeholder";
            ph.textContent = "[Initializing pipeline…]";
            panel.appendChild(ph);
        }
    }
    paintProgress();
    el.querySelector("#ug-clear-log")?.addEventListener("click", () => {
        run.logLines = [];
        const p = document.getElementById("ug-log");
        if (p) {
            p.innerHTML = `<div class="log-line log-placeholder">[Log cleared]</div>`;
        }
    });
}
function sourceLabelOfRun() {
    const s = getSession();
    return s?.playlistName ?? s?.rootPath ?? "folder";
}
function detachListeners() {
    run.unlistenPipeline?.();
    run.unlistenPipeline = null;
}
export async function beginRun(el, res, form, onDone) {
    detachListeners();
    run.active = true;
    run.processed = 0;
    run.total = 0;
    run.logLines = [];
    const curSess = getSession();
    if (curSess)
        updateSession(curSess.id, { status: "running", progressLabel: "Upgrading…" });
    renderRunning(el);
    run.unlistenPipeline = await watchPipelineRun({
        onLog: (line) => {
            appendLog(line);
            if (line.includes("invalid_arl") ||
                line.includes("missing_arl") ||
                line.includes("Deezer ARL token is invalid")) {
                const alertBox = document.getElementById("ug-run-arl-alert");
                if (alertBox) {
                    alertBox.innerHTML = `⚠️ <strong>Deezer ARL Error:</strong> The Deezer token is invalid or expired. Downloads cannot proceed. You can update your ARL in <a href="#/settings" style="text-decoration:underline;color:inherit;font-weight:600">Settings</a> and use <strong>Review</strong> to refetch missed tracks.`;
                    alertBox.classList.remove("hidden");
                }
            }
            const signal = parseProgressLine(line);
            if (signal.kind === "totals") {
                run.total = signal.total;
                run.processed = signal.total - signal.pending;
                paintProgress();
            }
            else if (signal.kind === "step") {
                run.processed++;
                paintProgress();
            }
        },
        onDone: (exitCode) => {
            detachListeners();
            run.active = false;
            void finishRun(res, exitCode, onDone);
        },
    });
    try {
        await startPipeline({
            rootPath: res.rootPath,
            outputFormat: form.format,
            fileList: res.fileList ?? undefined,
            skipHighQuality: form.skipHq,
            skipDeezerMax: form.skipMax,
        });
    }
    catch (err) {
        detachListeners();
        run.active = false;
        onDone({
            exitCode: -1,
            ledger: null,
            counts: null,
            alreadyComplete: false,
            error: `Failed to start pipeline: ${err}`,
        });
    }
}
async function finishRun(res, exitCode, onDone) {
    try {
        let content;
        try {
            content = await readLedgerFile(res.ledgerPath);
        }
        catch (readErr) {
            const fallback = res.ledgerPath.endsWith("-dev.json")
                ? res.ledgerPath.replace("-dev.json", ".json")
                : res.ledgerPath.replace(".json", "-dev.json");
            content = await readLedgerFile(fallback);
            res.ledgerPath = fallback;
        }
        const ledger = JSON.parse(content);
        const counts = countLedger(ledger);
        if (exitCode !== 0) {
            const isCancellation = exitCode === -1 || exitCode === 137 || exitCode === 143;
            onDone({
                exitCode,
                ledger,
                counts,
                alreadyComplete: false,
                error: isCancellation
                    ? "Pipeline was stopped. Progress has been preserved."
                    : "Pipeline stopped with an error. Progress up to that point was preserved.",
            });
            return;
        }
        onDone({
            exitCode,
            ledger,
            counts,
            alreadyComplete: false,
            error: null,
        });
    }
    catch (err) {
        onDone({
            exitCode,
            ledger: null,
            counts: null,
            alreadyComplete: false,
            error: exitCode !== 0
                ? "Pipeline run stopped. Check the logs above."
                : `Pipeline finished but the ledger could not be read: ${err}`,
        });
    }
}
export function renderDone(el, res, result, cb) {
    el.className = "screen on";
    const counts = result.counts;
    const isStopped = !!result.error && result.error.includes("stopped");
    const hasProcessed = !!counts && counts.total - counts.pending > 0;
    setSession({
        progressLabel: isStopped
            ? "run stopped"
            : result.error
                ? "run failed"
                : counts
                    ? `${counts.downloaded}/${counts.total} upgraded`
                    : "run complete",
    });
    // A completed or stopped run with processed tracks parks the session in review:
    // it stays in the sidebar while its follow-ups (review, apply, reset) are still available.
    if (counts && counts.total > 0 && (!result.error || hasProcessed)) {
        const cur = getSession();
        if (cur)
            updateSession(cur.id, { status: "review", hasFollowUps: true });
    }
    const stat = (num, label) => `<div class="stat">
      <div class="v">${num ?? 0}</div>
      <div class="l">${label}</div>
    </div>`;
    const stats = counts
        ? `<div class="stats">
        ${stat(counts.total, "Tracks")}
        ${stat(counts.downloaded, "Upgraded")}
        ${stat(counts.unidentified + counts.not_on_deezer + counts.download_failed, "Missed")}
        ${stat(counts.pending, "Pending")}
      </div>`
        : "";
    const missedCount = counts ? (counts.unidentified + counts.not_on_deezer + counts.download_failed) : 0;
    const breakdown = counts
        ? `<div class="kv-list">
        <div class="kv-row"><span class="k-label">Unidentified</span><span class="k-value">${counts.unidentified}</span></div>
        <div class="kv-row"><span class="k-label">Not on Deezer</span><span class="k-value">${counts.not_on_deezer}</span></div>
        <div class="kv-row"><span class="k-label">Download failed</span><span class="k-value">${counts.download_failed}</span></div>
        <div class="kv-row"><span class="k-label">Skipped by rules</span><span class="k-value">${counts.skipped}</span></div>
      </div>`
        : "";
    const headline = isStopped
        ? "Run stopped"
        : result.error
            ? "Run failed"
            : result.alreadyComplete
                ? "Session already complete"
                : "Run complete";
    const sub = result.error
        ? result.error
        : `${counts?.total ?? 0} tracks processed. Review each pair next: approve or skip, then commit to disk and Rekordbox.`;
    const arlNotice = (counts?.download_failed ?? 0) > 0
        ? `<div class="alert warn" style="margin-top:16px;margin-bottom:8px;font-size:12.5px;padding:10px 14px;line-height:1.45">
        ⚠️ <strong>${counts?.download_failed} track(s) could not be downloaded.</strong> If your Deezer ARL token expired, update it in <a href="#/settings" style="text-decoration:underline;color:inherit;font-weight:600">Settings</a> and use <strong>Review</strong> to refetch missed tracks without rerunning.
      </div>`
        : "";
    el.innerHTML = `
    <div class="ov">
      <div class="mx">
        ${phaseHead("01 · UPGRADER · RESULTS", headline, `${sourceLabel(res)}. ${sub}`)}
        ${stats}
        ${arlNotice}
        <div class="sect">
          <div class="frow" style="align-items:center;justify-content:space-between;margin-bottom:6px">
            <h3 style="margin:0">Breakdown</h3>
            ${missedCount > 0 ? `
              <div style="display:flex;gap:6px">
                <button class="btn sm" id="ug-export-csv" title="Download CSV wishlist for Bandcamp / Beatport">Export Missed (.csv)</button>
                <button class="btn sm" id="ug-copy-wishlist" title="Copy track list to clipboard">Copy List</button>
              </div>` : ""}
          </div>
          ${breakdown}
          ${missedCount > 0 ? `<p id="ug-export-feedback" class="muted small ok-text" style="margin:4px 0 0;min-height:16px"></p>` : ""}
        </div>
      </div>
    </div>`;
    if (counts && missedCount > 0) {
        const feedback = el.querySelector("#ug-export-feedback");
        const showNotice = (msg) => {
            if (feedback)
                feedback.textContent = msg;
        };
        el.querySelector("#ug-export-csv")?.addEventListener("click", () => {
            const missed = getMissedTracks(result.ledger);
            if (missed.length === 0)
                return;
            const csvHeader = "Artist,Title,Status,File Path\n";
            const csvRows = missed
                .map((t) => [t.artist, t.title, t.status, t.path]
                .map((v) => `"${v.replace(/"/g, '""')}"`)
                .join(","))
                .join("\n");
            const blob = new Blob([csvHeader + csvRows], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `crateup-missed-tracks-${Date.now()}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showNotice(`✓ Exported ${missed.length} track(s) to CSV`);
        });
        el.querySelector("#ug-copy-wishlist")?.addEventListener("click", async () => {
            const missed = getMissedTracks(result.ledger);
            if (missed.length === 0)
                return;
            const text = missed.map((t) => `${t.artist} - ${t.title} (${t.status})`).join("\n");
            try {
                await navigator.clipboard.writeText(text);
                showNotice(`✓ Copied ${missed.length} track(s) to clipboard`);
            }
            catch {
                showNotice("Could not copy to clipboard");
            }
        });
    }
    renderUpgraderStage(2);
    renderDock("Results · next action reviews pairs", [
        {
            id: "ug-done-back",
            label: "Back",
            variant: "ghost",
            onClick: cb.onBackToConfigure,
        },
        {
            id: "ug-done-reset",
            label: "Reset",
            variant: "danger-ghost",
            onClick: cb.onReset,
        },
        {
            id: "ug-done-close",
            label: "Close",
            variant: "ghost",
            onClick: cb.onClose,
        },
        {
            id: "ug-review",
            label: "Review upgrades",
            variant: "primary",
            disabled: !hasProcessed,
            onClick: cb.onReview,
        },
    ]);
}
/* ---------------- reset ---------------- */
export async function resetUpgraderSession(res, onDone, onError) {
    if (run.active)
        return;
    let confirmed = true;
    try {
        confirmed = await showConfirmDialog("Reset session?", "This deletes the staging folder, ledger, and logs for this session. Continue?");
    }
    catch {
        confirmed = window.confirm("Reset this session? This deletes staging, ledger, and logs.");
    }
    if (!confirmed)
        return;
    try {
        await resetSession(res.rootPath, res.isSessionDir);
        clearSession();
        onDone();
    }
    catch (err) {
        onError(`Reset failed: ${err}`);
    }
}
