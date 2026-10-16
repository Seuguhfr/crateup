/* Route views. Home is an editorial dispatch; queued workflows get a
   quiet summary card so they never look like a finished screen. */
import { phaseHead } from "./components.js";
import { renderUpgraderView } from "./upgrader/view.js";
import { checkArlStatus, checkEngineHealth, clearFingerprintCache, deleteDbBackup, fingerprintCacheInfo, getArl, listRekordboxBackups, rollbackToBackup, saveArl, selectDirectory, showConfirmDialog, } from "./api.js";
import { loadPrefs, resetPrefs, savePrefs, thresholdLabel } from "./policy.js";
import { esc, fmtBytes } from "./upgrader/utils.js";
import { listSessions } from "./store.js";
function cardAction(toolId) {
    const unfinished = listSessions().filter((s) => s.tool === toolId && (s.status === "running" || s.status === "review"));
    if (unfinished.length === 0) {
        return `<span style="color:var(--text4);font-size:16px;line-height:1">→</span>`;
    }
    const s = unfinished[0];
    const name = s.name ? (s.name.length > 24 ? `${s.name.slice(0, 22)}…` : s.name) : "";
    const label = name ? `Resume "${esc(name)}" →` : "Resume →";
    return `<button type="button" class="badge b resume-btn" data-resume-id="${esc(s.id)}" title="Resume ${esc(s.name || 'session')}">${label}</button>`;
}
export function renderHome(el) {
    el.className = "screen on";
    el.innerHTML = `
    <div class="ov">
      <div class="mx">
        <div class="phead">
          <span class="k">CrateUp</span>
          <h1>Five jobs. One library.</h1>
          <p>An instrument for keeping a DJ library consistent: upgrade quality through Deezer, consolidate duplicates, ingest playlists, compare sets, audit the folders. Every tool previews changes and safeguards your Rekordbox database before touching a single file.</p>
        </div>
        <a class="sect job-card" href="#/upgrader">
          <span class="job-num">01</span>
          <span class="job-body">
            <span class="job-name">Quality Upgrader</span>
            <span class="job-desc">Fingerprint a folder or playlist, download lossless replacements, review each pair yourself.</span>
          </span>
          ${cardAction("upgrader")}
        </a>
        <a class="sect job-card" href="#/cleaner">
          <span class="job-num">02</span>
          <span class="job-body">
            <span class="job-name">Library Cleaner</span>
            <span class="job-desc">Consolidate a Rekordbox collection, dedupe, rewrite paths in XML or master.db.</span>
          </span>
          ${cardAction("cleaner")}
        </a>
        <a class="sect job-card" href="#/ingestion">
          <span class="job-num">03</span>
          <span class="job-body">
            <span class="job-name">Ingestion Hub</span>
            <span class="job-desc">Drop loose tracks, dedupe against the library, export a clean playlist and XML.</span>
          </span>
          ${cardAction("ingestion")}
        </a>
        <a class="sect job-card" href="#/compare">
          <span class="job-num">04</span>
          <span class="job-body">
            <span class="job-name">Playlist Compare</span>
            <span class="job-desc">Isolate common tracks and unique gems between two Rekordbox sets.</span>
          </span>
          ${cardAction("compare")}
        </a>
        <a class="sect job-card" href="#/audit">
          <span class="job-num">05</span>
          <span class="job-body">
            <span class="job-name">Library Audit</span>
            <span class="job-desc">Prove the library folder holds exactly what Rekordbox references — leftovers, stray hardlinks, stragglers.</span>
          </span>
          ${cardAction("audit")}
        </a>
        <p class="kb" style="margin-top:2px">Sessions resume from their progress ledger. Nothing is written until you review it.</p>
      </div>
    </div>`;
}
export function renderUpgrader(el) {
    renderUpgraderView(el);
}
export function renderSettings(el) {
    el.className = "screen on";
    const prefs = loadPrefs();
    const pct = Math.round(prefs.match.acousticThreshold * 100);
    const formats = ["flac", "mp3", "aiff", "wav"];
    el.innerHTML = `
    <div class="ov">
      <div class="mx">
        ${phaseHead("Settings", "Settings", "Shared defaults for every tool. Runs may override these per execution; they never change them. Changes apply immediately.")}
        <div class="sect">
          <h3>Match policy — what counts as the same song</h3>
          <div class="frow">
            <span class="fl">Threshold</span>
            <input type="range" id="set-threshold" min="80" max="100" step="1" value="${pct}" style="flex:1" />
            <span class="k-value mono" id="set-threshold-val" style="min-width:44px;text-align:right">${thresholdLabel(prefs.match.acousticThreshold)}</span>
          </div>
          <p class="muted small" style="margin:6px 0 0">Recordings pairing at or above this similarity count as identical — in duplicate detection and Playlist Compare sound matching.</p>
        </div>
        <div class="sect">
          <h3>Library</h3>
          <div class="frow">
            <span class="fl">Music folder</span>
            <input class="field" id="set-root" readonly placeholder="Not set — pickers start at home" value="${prefs.libraryRoot ?? ""}" />
            <button class="btn sm" id="set-browse">Choose…</button>
            <button class="btn sm" id="set-clear">Clear</button>
          </div>
          <p class="muted small" style="margin:6px 0 0">Folder pickers open here first.</p>
        </div>
        <div class="sect">
          <h3>Output</h3>
          <div class="frow">
            <span class="fl">Format</span>
            <select class="pop" id="set-format">${formats
        .map((f) => `<option value="${f}"${f === prefs.outputFormat ? " selected" : ""}>${f.toUpperCase()}</option>`)
        .join("")}</select>
          </div>
          <p class="muted small" style="margin:6px 0 0">Used until a run picks its own format.</p>
        </div>
        <div class="sect">
          <h3>Deezer access</h3>
          <div class="frow">
            <span class="fl">ARL token</span>
            <input type="password" id="set-arl" class="field" placeholder="Paste arl cookie…" autocomplete="off" />
            <button class="btn sm" id="set-arl-save">Save</button>
          </div>
          <p class="muted small" id="set-arl-status" style="margin:6px 0 0">Checking…</p>
          <p class="muted small" style="margin:2px 0 0">Deezer → DevTools → Cookies → arl. Stored on this machine; required for downloads (Lossless FLAC/AIFF requires a Deezer Premium/HiFi subscription).</p>
        </div>
        <div class="sect">
          <h3>Engine health & dependencies</h3>
          <div id="set-health-list" style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
            <div class="frow" style="align-items:center;justify-content:space-between">
              <span class="fl" style="min-width:140px">Acoustic Engine</span>
              <span id="set-health-fpcalc" class="badge ne">Checking…</span>
            </div>
            <div class="frow" style="align-items:center;justify-content:space-between">
              <span class="fl" style="min-width:140px">Audio Transcoder</span>
              <span id="set-health-ffmpeg" class="badge ne">Checking…</span>
            </div>
            <div class="frow" style="align-items:center;justify-content:space-between">
              <span class="fl" style="min-width:140px">Python Runtime</span>
              <span id="set-health-python" class="badge ne">Checking…</span>
            </div>
            <div class="frow" style="align-items:center;justify-content:space-between">
              <span class="fl" style="min-width:140px">Rekordbox Database</span>
              <span id="set-health-rekordbox" class="badge ne">Checking…</span>
            </div>
          </div>
          <p class="muted small" style="margin:6px 0 0">Real-time verification of bundled binaries, Python 3.12 embedded runtime, and Rekordbox SQLite database.</p>
        </div>
        <div class="sect">
          <div class="frow" style="align-items:center;justify-content:space-between;margin-bottom:6px">
            <h3 style="margin:0">Rekordbox backups</h3>
            <button class="btn sm" id="set-backups-refresh">Refresh</button>
          </div>
          <p class="muted small" style="margin:0 0 10px">Snapshots taken before database modifications. Restoring overwrites master.db. Rekordbox must stay closed.</p>
          <div id="set-backups-container">
            <p class="muted small" id="set-backups-empty">Loading backups…</p>
          </div>
        </div>
        <div class="sect">
          <h3>Storage</h3>
          <div class="frow">
            <span class="fl">Fingerprints</span>
            <span class="muted small" id="set-cache-info" style="flex:1">Loading…</span>
            <button class="btn sm" id="set-cache-clear">Clear</button>
          </div>
          <p class="muted small" style="margin:6px 0 0">Shared acoustic-fingerprint cache — clearing forces full re-analysis next run.</p>
        </div>
        <div class="sect">
          <h3>Reset</h3>
          <div class="frow">
            <span class="fl">All settings</span>
            <button class="btn sm" id="set-reset">Restore defaults</button>
          </div>
        </div>
      </div>
    </div>`;
    const val = el.querySelector("#set-threshold-val");
    el.querySelector("#set-threshold")?.addEventListener("input", (e) => {
        const v = Number(e.target.value) / 100;
        const p = loadPrefs();
        p.match.acousticThreshold = v;
        savePrefs(p);
        if (val)
            val.textContent = thresholdLabel(v);
    });
    el.querySelector("#set-format")?.addEventListener("change", (e) => {
        const p = loadPrefs();
        p.outputFormat = e.target.value;
        savePrefs(p);
    });
    el.querySelector("#set-browse")?.addEventListener("click", async () => {
        const picked = await selectDirectory(loadPrefs().libraryRoot ?? undefined).catch(() => null);
        if (!picked)
            return;
        const p = loadPrefs();
        p.libraryRoot = picked;
        savePrefs(p);
        renderSettings(el);
    });
    el.querySelector("#set-clear")?.addEventListener("click", () => {
        const p = loadPrefs();
        p.libraryRoot = null;
        savePrefs(p);
        renderSettings(el);
    });
    el.querySelector("#set-reset")?.addEventListener("click", () => {
        resetPrefs();
        renderSettings(el);
    });
    // ARL status is async: prefill and validate against Deezer gateway.
    const arlInput = el.querySelector("#set-arl");
    const arlStatus = el.querySelector("#set-arl-status");
    const validateAndPaintArl = async (tokenToCheck) => {
        if (!arlStatus)
            return;
        arlStatus.textContent = "Verifying Deezer connection…";
        arlStatus.className = "hint";
        try {
            const res = await checkArlStatus(tokenToCheck);
            arlStatus.textContent = res.message;
            if (res.valid) {
                arlStatus.className = "hint ok-text";
            }
            else if (res.status === "missing") {
                arlStatus.className = "hint";
            }
            else {
                arlStatus.className = "hint danger-text";
            }
        }
        catch {
            arlStatus.textContent = "Could not check token status.";
            arlStatus.className = "hint warn-text";
        }
    };
    void getArl()
        .then((saved) => {
        if (arlInput && saved)
            arlInput.value = saved;
        void validateAndPaintArl(saved || undefined);
    })
        .catch(() => {
        if (arlStatus)
            arlStatus.textContent = "Could not check token status.";
    });
    el.querySelector("#set-arl-save")?.addEventListener("click", async () => {
        const token = arlInput?.value.trim() ?? "";
        if (!token)
            return;
        try {
            await saveArl(token);
            await validateAndPaintArl(token);
        }
        catch (err) {
            if (arlStatus) {
                arlStatus.textContent = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
                arlStatus.className = "hint danger-text";
            }
        }
    });
    // Fingerprint cache stats are async; clear refreshes them.
    const cacheInfo = el.querySelector("#set-cache-info");
    const paintCacheInfo = () => {
        if (!cacheInfo)
            return;
        void fingerprintCacheInfo()
            .then((info) => {
            cacheInfo.textContent = `${info.entries} track${info.entries === 1 ? "" : "s"} · ${fmtBytes(info.bytes)}`;
        })
            .catch(() => {
            cacheInfo.textContent = "Unavailable.";
        });
    };
    paintCacheInfo();
    el.querySelector("#set-cache-clear")?.addEventListener("click", async () => {
        try {
            await clearFingerprintCache();
        }
        catch (err) {
            console.error("Clear cache failed:", err);
        }
        paintCacheInfo();
    });
    // Engine health diagnostics
    const cleanVersion = (tool, raw) => {
        if (!raw)
            return tool;
        if (tool === "fpcalc") {
            const m = raw.match(/fpcalc\s+(?:version\s+)?([0-9]+(?:\.[0-9]+)*)/i);
            return m ? `fpcalc ${m[1]}` : (raw.split("(")[0]?.trim() || "fpcalc");
        }
        if (tool === "ffmpeg") {
            const m = raw.match(/ffmpeg\s+(?:version\s+)?([^\s]+)/i);
            return m ? `FFmpeg ${m[1]}` : "FFmpeg";
        }
        if (tool === "python") {
            const m = raw.match(/Python\s+([0-9]+(?:\.[0-9]+)*)/i);
            return m ? `CPython ${m[1]}` : raw.trim();
        }
        return raw.trim();
    };
    const paintEngineHealth = () => {
        const elFpcalc = el.querySelector("#set-health-fpcalc");
        const elFfmpeg = el.querySelector("#set-health-ffmpeg");
        const elPython = el.querySelector("#set-health-python");
        const elRekordbox = el.querySelector("#set-health-rekordbox");
        void checkEngineHealth()
            .then((h) => {
            if (elFpcalc) {
                elFpcalc.textContent = h.fpcalc_ok ? `Ready · ${cleanVersion("fpcalc", h.fpcalc_version)}` : "Missing fpcalc";
                elFpcalc.title = h.fpcalc_version || "";
                elFpcalc.className = `badge ${h.fpcalc_ok ? "g" : "r"}`;
            }
            if (elFfmpeg) {
                elFfmpeg.textContent = h.ffmpeg_ok ? `Ready · ${cleanVersion("ffmpeg", h.ffmpeg_version)}` : "Missing ffmpeg";
                elFfmpeg.title = h.ffmpeg_version || "";
                elFfmpeg.className = `badge ${h.ffmpeg_ok ? "g" : "r"}`;
            }
            if (elPython) {
                elPython.textContent = h.python_ok ? `Ready · ${cleanVersion("python", h.python_version)}` : "Missing Python 3.12";
                elPython.title = h.python_version || "";
                elPython.className = `badge ${h.python_ok ? "g" : "r"}`;
            }
            if (elRekordbox) {
                if (!h.rekordbox_db_exists) {
                    elRekordbox.textContent = "master.db not found";
                    elRekordbox.className = "badge ne";
                }
                else if (h.rekordbox_running) {
                    elRekordbox.textContent = "Running · DB Locked";
                    elRekordbox.className = "badge o";
                }
                else {
                    elRekordbox.textContent = "Found · Idle";
                    elRekordbox.className = "badge g";
                }
            }
        })
            .catch(() => {
            if (elFpcalc)
                elFpcalc.textContent = "Unavailable";
        });
    };
    paintEngineHealth();
    // Rekordbox backups manager
    const backupsContainer = el.querySelector("#set-backups-container");
    let showAllBackups = false;
    let rollbackFeedbackMsg = null;
    const paintBackups = async () => {
        if (!backupsContainer)
            return;
        try {
            const backups = await listRekordboxBackups();
            if (!backups || backups.length === 0) {
                backupsContainer.innerHTML = `<p class="muted small" style="margin:0">No master.db backups found.</p>`;
                return;
            }
            const displayBackups = showAllBackups ? backups : backups.slice(0, 5);
            const toggleHtml = backups.length > 5
                ? `<div style="margin-top:6px;display:flex;justify-content:flex-end">
               <button class="btn sm" id="set-backups-toggle">${showAllBackups
                    ? "Show fewer"
                    : `Show all ${backups.length} backups ⌄`}</button>
             </div>`
                : "";
            const feedbackBanner = rollbackFeedbackMsg
                ? `<div class="ok-box" style="margin-bottom:8px;padding:8px 12px;background:rgba(48,209,88,0.12);border:1px solid rgba(48,209,88,0.3);border-radius:6px;color:var(--text);font-size:12px">${esc(rollbackFeedbackMsg)}</div>`
                : "";
            backupsContainer.innerHTML = `
        ${feedbackBanner}
        <div style="display:flex;flex-direction:column;gap:6px">
          ${displayBackups
                .map((b) => `
            <div class="frow" style="align-items:center;justify-content:space-between;padding:8px 10px;background:var(--segBg);border-radius:6px">
              <div style="display:flex;flex-direction:column;gap:3px">
                <div style="display:flex;align-items:center;gap:8px">
                  <span class="mono" style="font-size:12px;font-weight:600">${esc(b.created_at)}</span>
                  ${b.is_active
                ? `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:10px;background:rgba(48,209,88,0.15);color:var(--green);font-size:11px;font-weight:600">● Active in Rekordbox</span>`
                : ""}
                  ${b.is_newer_than_active
                ? `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:10px;background:rgba(10,132,255,0.15);color:var(--accent);font-size:11px;font-weight:600">↪ Newer snapshot (Redo)</span>`
                : ""}
                </div>
                <span class="muted small mono" style="font-size:11px">
                  ${esc(b.filename)} · ${fmtBytes(b.size_bytes)} · <span style="${b.missing_tracks > 0 ? "color:var(--orange)" : "color:var(--green)"}">${b.intact_tracks.toLocaleString()} on disk${b.missing_tracks > 0 ? ` · ${b.missing_tracks.toLocaleString()} missing` : ""}</span>
                </span>
              </div>
              <div style="display:flex;gap:6px">
                ${b.is_active
                ? `<button class="btn sm" disabled style="opacity:0.45;cursor:default">Active</button>`
                : `<button class="btn sm set-backup-restore" data-file="${esc(b.filename)}" data-date="${esc(b.created_at)}" data-intact="${b.intact_tracks}" data-missing="${b.missing_tracks}">Restore</button>`}
                <button class="btn sm set-backup-delete" data-file="${esc(b.filename)}" data-date="${esc(b.created_at)}" style="color:var(--red)">Delete</button>
              </div>
            </div>`)
                .join("")}
        </div>${toggleHtml}`;
            backupsContainer.querySelector("#set-backups-toggle")?.addEventListener("click", () => {
                showAllBackups = !showAllBackups;
                void paintBackups();
            });
            backupsContainer.querySelectorAll(".set-backup-restore").forEach((btn) => {
                btn.addEventListener("click", async () => {
                    const file = btn.dataset.file;
                    const date = btn.dataset.date;
                    const intact = parseInt(btn.dataset.intact ?? "0", 10);
                    const missing = parseInt(btn.dataset.missing ?? "0", 10);
                    if (!file)
                        return;
                    let keepValidPaths = false;
                    if (missing > 0) {
                        const healChoice = await showConfirmDialog("Smart Relink & Restore?", `Snapshot from ${date} has ${missing.toLocaleString()} missing audio file(s) on disk (${intact.toLocaleString()} intact).\n\nWould you like to heal missing paths from current live locations where possible?`);
                        keepValidPaths = healChoice;
                    }
                    else {
                        const ok = await showConfirmDialog("Restore Rekordbox backup?", `Restore database snapshot from ${date} (${file}) over the live master.db? Rekordbox must stay closed.`);
                        if (!ok)
                            return;
                    }
                    btn.disabled = true;
                    btn.textContent = "Restoring…";
                    try {
                        const res = await rollbackToBackup(file, keepValidPaths);
                        const healedText = res.healed_paths_count > 0 ? `, ${res.healed_paths_count} paths healed` : "";
                        const safetyText = res.created_safety_backup ? ` · auto-saved previous state as ${res.created_safety_backup}` : "";
                        rollbackFeedbackMsg = `✓ Restored Rekordbox database to ${date} (${res.intact_tracks.toLocaleString()} tracks on disk${healedText}${safetyText}).`;
                        await paintBackups();
                        paintEngineHealth();
                    }
                    catch (err) {
                        btn.disabled = false;
                        btn.textContent = "Restore";
                        alert(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
                    }
                });
            });
            backupsContainer.querySelectorAll(".set-backup-delete").forEach((btn) => {
                btn.addEventListener("click", async () => {
                    const file = btn.dataset.file;
                    const date = btn.dataset.date;
                    if (!file)
                        return;
                    const ok = await showConfirmDialog("Delete backup?", `Move backup ${file} (${date}) to macOS Trash?`);
                    if (!ok)
                        return;
                    btn.disabled = true;
                    btn.textContent = "Deleting…";
                    try {
                        await deleteDbBackup(file);
                        await paintBackups();
                    }
                    catch (err) {
                        btn.disabled = false;
                        btn.textContent = "Delete";
                        alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
                    }
                });
            });
        }
        catch {
            backupsContainer.innerHTML = `<p class="muted small warn-text" style="margin:0">Could not read backups.</p>`;
        }
    };
    void paintBackups();
    el.querySelector("#set-backups-refresh")?.addEventListener("click", () => {
        void paintBackups();
    });
}
