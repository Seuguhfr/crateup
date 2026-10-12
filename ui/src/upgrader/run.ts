/* Upgrader configure → run → done. Owns the pipeline event listeners
   and the run screen's live updates. */

import {
  clearSession,
  getSession,
  setSession,
  updateSession,
} from "../store.js";
import {
  readLedgerFile,
  resetSession,
  showConfirmDialog,
  startPipeline,
} from "../api.js";
import { phaseHead } from "../components.js";
import { renderDock, renderUpgraderStage } from "../chrome.js";
import { watchPipelineRun } from "../jobs.js";
import { loadPrefs as loadAppPrefs } from "../policy.js";
import {
  countLedger,
  parseProgressLine,
  type Ledger,
  type StatusCounts,
} from "./utils.js";
import type { SourceResolution } from "./source.js";

export interface RunResult {
  exitCode: number;
  ledger: Ledger | null;
  counts: StatusCounts | null;
  alreadyComplete: boolean;
  error: string | null;
}

interface RunSnapshot {
  active: boolean;
  processed: number;
  total: number;
  logLines: string[];
}

const LOG_CAP = 500;

const run: RunSnapshot & {
  unlistenPipeline: (() => void) | null;
} = {
  active: false,
  processed: 0,
  total: 0,
  logLines: [],
  unlistenPipeline: null,
};

export function isRunActive(): boolean {
  return run.active;
}

const PREF_FORMAT = "upgrader_format";
const PREF_SKIP_HQ = "upgrader_skip_high_quality";
const PREF_SKIP_MAX = "upgrader_skip_deezer_max";

function loadPrefs(): { format: string; skipHq: boolean; skipMax: boolean } {
  return {
    // Per-run choice wins; otherwise the shared Settings default applies.
    format: localStorage.getItem(PREF_FORMAT) ?? loadAppPrefs().outputFormat ?? "flac",
    skipHq: localStorage.getItem(PREF_SKIP_HQ) === "true",
    skipMax: localStorage.getItem(PREF_SKIP_MAX) === "true",
  };
}

function sourceLabel(res: SourceResolution): string {
  const s = getSession();
  if (res.sourceKind === "folder") return `Folder: ${res.rootPath}`;
  return `Playlist: ${s?.playlistName ?? res.rootPath}`;
}

/* ---------------- configure ---------------- */

export interface ConfigureCallbacks {
  onStart: () => void;
  onBack: () => void;
  onReset: () => void;
  onClose: () => void;
}

function syncNativeCheckboxes(scope: HTMLElement): void {
  scope
    .querySelectorAll<HTMLInputElement>('input.chk[type="checkbox"]')
    .forEach((inp) => {
      inp.classList.toggle("on", inp.checked);
      inp.addEventListener("change", () => inp.classList.toggle("on", inp.checked));
    });
}

export function renderConfigure(
  el: HTMLElement,
  res: SourceResolution,
  notice: string | null,
  cb: ConfigureCallbacks,
): void {
  el.className = "screen on";
  const prefs = loadPrefs();
  const counts = res.existing ? countLedger(res.existing) : null;
  const processed = counts ? counts.total - counts.pending : 0;
  const isResume =
    counts !== null && counts.total > 0 && counts.pending > 0 && processed > 0;

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
        ${phaseHead(
          "02 · Configure",
          "Configure the run",
          `${sourceLabel(res)}. Set the output, then start. The run continues on its own; results land in Done.`,
        )}
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

export function readConfigureForm(el: HTMLElement): {
  format: string;
  skipHq: boolean;
  skipMax: boolean;
} {
  const format =
    el.querySelector<HTMLSelectElement>("#ug-format")?.value ?? "flac";
  const skipHq = el.querySelector<HTMLInputElement>("#ug-skip-hq")?.checked ?? false;
  const skipMax = el.querySelector<HTMLInputElement>("#ug-skip-max")?.checked ?? false;
  localStorage.setItem(PREF_FORMAT, format);
  localStorage.setItem(PREF_SKIP_HQ, String(skipHq));
  localStorage.setItem(PREF_SKIP_MAX, String(skipMax));
  setSession({ outputFormat: format });
  return { format, skipHq, skipMax };
}

/* ---------------- running ---------------- */

function paintProgress(): void {
  const text = document.getElementById("ug-progress-text");
  const pct = document.getElementById("ug-progress-pct");
  const count = document.getElementById("ug-progress-count");
  const fill = document.getElementById("ug-progress-fill");
  if (!text || !pct || !fill) return;
  if (run.total === 0) {
    text.textContent = "Processing: scanning…";
    pct.textContent = "0%";
    if (count) count.textContent = "0 / 0";
    fill.style.width = "0%";
    return;
  }
  const percent = Math.min(100, (run.processed / run.total) * 100);
  text.textContent = `Processing: ${run.processed} / ${run.total} files`;
  pct.textContent = `${Math.round(percent)}%`;
  if (count) count.textContent = `${run.processed} / ${run.total}`;
  fill.style.width = `${percent}%`;
}

function appendLog(line: string): void {
  run.logLines.push(line);
  if (run.logLines.length > LOG_CAP) {
    run.logLines.splice(0, run.logLines.length - LOG_CAP);
  }
  const panel = document.getElementById("ug-log");
  if (!panel) return;
  if (panel.querySelector(".log-placeholder")) panel.innerHTML = "";
  const div = document.createElement("div");
  div.className = "log-line";
  div.textContent = line.replace(/\n$/, "");
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

export function renderRunning(el: HTMLElement): void {
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
        <div class="term">
          <div class="thead">
            <span class="k">Pipeline log</span>
            <button class="btn iv" id="ug-clear-log">Clear</button>
          </div>
          <div class="tbody" id="ug-log"></div>
        </div>
      </div>
    </div>`;

  renderUpgraderStage(1);
  renderDock("Run · state is saved to the ledger as it goes", []);

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
    } else {
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

function sourceLabelOfRun(): string {
  const s = getSession();
  return s?.playlistName ?? s?.rootPath ?? "folder";
}

function detachListeners(): void {
  run.unlistenPipeline?.();
  run.unlistenPipeline = null;
}

export async function beginRun(
  el: HTMLElement,
  res: SourceResolution,
  form: { format: string; skipHq: boolean; skipMax: boolean },
  onDone: (result: RunResult) => void,
): Promise<void> {
  detachListeners();
  run.active = true;
  run.processed = 0;
  run.total = 0;
  run.logLines = [];
  renderRunning(el);

  run.unlistenPipeline = await watchPipelineRun({
    onLog: (line) => {
      appendLog(line);
      const signal = parseProgressLine(line);
      if (signal.kind === "totals") {
        run.total = signal.total;
        run.processed = signal.total - signal.pending;
        paintProgress();
      } else if (signal.kind === "step") {
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
  } catch (err) {
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

async function finishRun(
  res: SourceResolution,
  exitCode: number,
  onDone: (result: RunResult) => void,
): Promise<void> {
  if (exitCode !== 0) {
    onDone({
      exitCode,
      ledger: null,
      counts: null,
      alreadyComplete: false,
      error: "Pipeline run failed. Check the logs above.",
    });
    return;
  }
  try {
    const content = await readLedgerFile(res.ledgerPath);
    const ledger = JSON.parse(content) as Ledger;
    onDone({
      exitCode,
      ledger,
      counts: countLedger(ledger),
      alreadyComplete: false,
      error: null,
    });
  } catch (err) {
    onDone({
      exitCode,
      ledger: null,
      counts: null,
      alreadyComplete: false,
      error: `Pipeline finished but the ledger could not be read: ${err}`,
    });
  }
}

/* ---------------- done ---------------- */

export interface DoneCallbacks {
  onBackToConfigure: () => void;
  onReset: () => void;
  onReview: () => void;
  onClose: () => void;
}

export function renderDone(
  el: HTMLElement,
  res: SourceResolution,
  result: RunResult,
  cb: DoneCallbacks,
): void {
  el.className = "screen on";
  const counts = result.counts;
  setSession({
    progressLabel: result.error
      ? "run failed"
      : counts
        ? `${counts.downloaded}/${counts.total} upgraded`
        : "run complete",
  });
  // A completed run parks the session as done: it stays in the sidebar
  // while its follow-ups (review, apply, reset) are still available.
  if (!result.error && counts && counts.total > 0) {
    const cur = getSession();
    if (cur) updateSession(cur.id, { status: "done", hasFollowUps: true });
  }

  const stat = (
    num: number | undefined,
    label: string,
  ): string => `<div class="stat">
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

  const breakdown = counts
    ? `<div class="kv-list">
        <div class="kv-row"><span class="k-label">Unidentified</span><span class="k-value">${counts.unidentified}</span></div>
        <div class="kv-row"><span class="k-label">Not on Deezer</span><span class="k-value">${counts.not_on_deezer}</span></div>
        <div class="kv-row"><span class="k-label">Download failed</span><span class="k-value">${counts.download_failed}</span></div>
        <div class="kv-row"><span class="k-label">Skipped by rules</span><span class="k-value">${counts.skipped}</span></div>
      </div>`
    : "";

  const headline = result.error
    ? "Run failed"
    : result.alreadyComplete
      ? "Session already complete"
      : "Run complete";
  const sub = result.error
    ? result.error
    : `${counts?.total ?? 0} tracks processed. Review each pair next: approve or skip, then commit to disk and Rekordbox.`;

  el.innerHTML = `
    <div class="ov">
      <div class="mx">
        ${phaseHead("04 · Results", headline, `${sourceLabel(res)}. ${sub}`)}
        ${stats}
        <div class="sect">
          <h3>Breakdown</h3>
          ${breakdown}
        </div>
        <div class="sect">
          <h3>Next</h3>
          <p class="muted" style="margin:0">Review each pair next: listen, approve or skip, then commit to disk and Rekordbox.</p>
        </div>
      </div>
    </div>`;

  renderUpgraderStage(2);
  renderDock("Results · next action reviews pairs", [
    {
      id: "ug-done-back",
      label: "Back to configure",
      variant: "ghost",
      onClick: cb.onBackToConfigure,
    },
    {
      id: "ug-done-reset",
      label: "Reset session",
      variant: "danger-ghost",
      onClick: cb.onReset,
    },
    {
      id: "ug-done-close",
      label: "Close session",
      variant: "ghost",
      onClick: cb.onClose,
    },
    {
      id: "ug-review",
      label: "Review upgrades",
      variant: "primary",
      disabled: !result.error && !!counts && counts.total > 0 ? false : true,
      onClick: cb.onReview,
    },
  ]);
}

/* ---------------- reset ---------------- */

export async function resetUpgraderSession(
  res: SourceResolution,
  onDone: () => void,
  onError: (message: string) => void,
): Promise<void> {
  if (run.active) return;
  let confirmed = true;
  try {
    confirmed = await showConfirmDialog(
      "Reset session?",
      "This deletes the staging folder, ledger, and logs for this session. Continue?",
    );
  } catch {
    confirmed = window.confirm("Reset this session? This deletes staging, ledger, and logs.");
  }
  if (!confirmed) return;
  try {
    await resetSession(res.rootPath, res.isSessionDir);
    clearSession();
    onDone();
  } catch (err) {
    onError(`Reset failed: ${err}`);
  }
}