/* Route views. Home is an editorial dispatch; queued workflows get a
   quiet summary card so they never look like a finished screen. */
import { phaseHead } from "./components.js";
import { renderUpgraderView } from "./upgrader/view.js";
import { clearFingerprintCache, fingerprintCacheInfo, getArl, saveArl, selectDirectory, } from "./api.js";
import { loadPrefs, resetPrefs, savePrefs, thresholdLabel } from "./policy.js";
import { fmtBytes } from "./upgrader/utils.js";
export function renderHome(el) {
    el.className = "screen on";
    el.innerHTML = `
    <div class="ov">
      <div class="mx">
        <div class="phead">
          <span class="k">CrateUp</span>
          <h1>Four jobs. One library.</h1>
          <p>An instrument for keeping a DJ library consistent: upgrade quality through Deezer, consolidate duplicates, ingest playlists, audit the folders. Every job runs the same arc: source, configure, run, results.</p>
        </div>
        <a class="sect job-card" href="#/upgrader">
          <span class="job-num">01</span>
          <span class="job-body">
            <span class="job-name">Quality Upgrader</span>
            <span class="job-desc">Fingerprint a folder or playlist, download lossless replacements, review each pair yourself.</span>
          </span>
          <span class="badge g">Live</span>
        </a>
        <a class="sect job-card" href="#/cleaner">
          <span class="job-num">02</span>
          <span class="job-body">
            <span class="job-name">Library Cleaner</span>
            <span class="job-desc">Consolidate a Rekordbox collection, dedupe, rewrite paths in XML or master.db.</span>
          </span>
          <span class="badge g">Live</span>
        </a>
        <a class="sect job-card" href="#/ingestion">
          <span class="job-num">03</span>
          <span class="job-body">
            <span class="job-name">Ingestion Hub</span>
            <span class="job-desc">Drop loose tracks, dedupe against the library, export a clean playlist and XML.</span>
          </span>
          <span class="badge g">Live</span>
        </a>
        <a class="sect job-card" href="#/audit">
          <span class="job-num">04</span>
          <span class="job-body">
            <span class="job-name">Library Audit</span>
            <span class="job-desc">Prove the library folder holds exactly what Rekordbox references — leftovers, stray hardlinks, stragglers.</span>
          </span>
          <span class="badge g">Live</span>
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
          <p class="muted small" style="margin:2px 0 0">Deezer → DevTools → Cookies → arl. Stored on this machine; required for downloads.</p>
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
    // ARL status is async: prefill when a token is stored.
    const arlInput = el.querySelector("#set-arl");
    const arlStatus = el.querySelector("#set-arl-status");
    void getArl()
        .then((saved) => {
        if (arlInput && saved)
            arlInput.value = saved;
        if (arlStatus) {
            arlStatus.textContent = saved ? "A token is saved on this machine." : "No token saved yet.";
            arlStatus.classList.toggle("ok-text", !!saved);
        }
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
            if (arlStatus) {
                arlStatus.textContent = "Saved.";
                arlStatus.classList.add("ok-text");
            }
        }
        catch (err) {
            if (arlStatus) {
                arlStatus.textContent = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
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
}
