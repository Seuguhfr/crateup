/* Upgrader source picker: folder / Rekordbox XML / Rekordbox database.
   Resolves a source into a session (root path, ledger path, file list)
   and hands it to the configure screen. Native macOS overview layout. */
import { checkArlStatus, checkFileExists, getAppDataDir, readLedgerFile, selectDirectory, selectXmlFile, writeLedgerFile, } from "../api.js";
import { openSession } from "../store.js";
import { loadPrefs } from "../policy.js";
import { fetchTrackList, loadPlaylistTree, } from "../source-access.js";
import { phaseHead } from "../components.js";
import { renderDock, renderInspector, renderUpgraderStage } from "../chrome.js";
import { getRelativePath, joinPath, ledgerNameForHost, longestCommonAncestor, sanitizeSessionName, sessionTimestamp, } from "./utils.js";
function ledgerName() {
    return ledgerNameForHost(window.location.port);
}
/* ---------------- ARL ---------------- */
async function verifyGlobalArl() {
    const alertBox = document.querySelector("#ug-source-arl-alert");
    try {
        const check = await checkArlStatus();
        if (!check.valid) {
            if (alertBox) {
                if (check.status === "missing") {
                    alertBox.innerHTML = `⚠️ <strong>Deezer ARL missing:</strong> Please enter your ARL in <a href="#/settings" style="text-decoration:underline">Settings</a> before upgrading tracks.`;
                }
                else {
                    alertBox.innerHTML = `⚠️ <strong>Deezer ARL expired:</strong> Your saved token is no longer valid on Deezer. Please update it in <a href="#/settings" style="text-decoration:underline">Settings</a>.`;
                }
                alertBox.classList.remove("hidden");
            }
            return false;
        }
        alertBox?.classList.add("hidden");
        return true;
    }
    catch {
        return true;
    }
}
/* ---------------- playlist tree sheet ---------------- */
function trackCountOf(node) {
    return node.type === "folder"
        ? node.totalTracks ?? 0
        : node.entryCount ?? 0;
}
function sumTracks(nodes) {
    let total = 0;
    for (const node of nodes) {
        if (node.type === "playlist")
            total += node.entryCount ?? 0;
        else if (node.type === "folder")
            total += node.totalTracks ?? 0;
    }
    return total;
}
function escAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function treeHtml(nodes, depth) {
    const items = nodes
        .map((node, i) => {
        const count = trackCountOf(node);
        const hasKids = node.type === "folder" && node.children && node.children.length > 0;
        const toggle = hasKids
            ? `<span class="tree-toggle" data-toggle="${depth}-${i}">▶</span>`
            : `<span class="tree-toggle"></span>`;
        const kids = hasKids && node.children
            ? `<div class="tree-kids hidden" data-kids="${depth}-${i}">${treeHtml(node.children, depth + 1)}</div>`
            : "";
        return `<div class="tree-item" data-name="${escAttr(node.name)}" data-id="${escAttr(node.id ?? "")}" data-type="${node.type}" data-count="${count}">
        <div class="tree-row">${toggle}<span class="tree-name">${escAttr(node.name)}</span><span class="tree-count">${count}</span></div>
        ${kids}
      </div>`;
    })
        .join("");
    return `<div class="tree-level">${items}</div>`;
}
/** Modal playlist picker. Resolves null on cancel. */
function pickPlaylist(title, tree) {
    return new Promise((resolve) => {
        const root = document.createElement("div");
        root.className = "modal-backdrop show";
        const total = sumTracks(tree);
        root.innerHTML = `
      <div class="modal" role="dialog" aria-label="${title}">
        <div class="modal-title">${title}</div>
        <p class="muted small" style="font-size:12px">Browse playlists or folders, or upgrade the entire collection.</p>
        <div class="select-all-row" data-select-all>
          <span>All playlists (entire collection)</span>
          <span class="tree-count">${total}</span>
        </div>
        <div class="tree-box">${treeHtml(tree, 0)}</div>
        <div class="modal-actions">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn primary" data-confirm disabled>Upgrade Selected (0 tracks)</button>
        </div>
      </div>`;
        let pick = null;
        const confirmBtn = root.querySelector("[data-confirm]");
        const setPick = (p) => {
            pick = p;
            root
                .querySelectorAll(".tree-row.selected, .select-all-row.selected")
                .forEach((n) => n.classList.remove("selected"));
            if (!p || !confirmBtn)
                return;
            confirmBtn.removeAttribute("disabled");
            confirmBtn.textContent = `Upgrade Selected (${p.trackCount} tracks)`;
        };
        const close = (value) => {
            document.removeEventListener("keydown", onKey);
            root.remove();
            resolve(value);
        };
        const onKey = (e) => {
            if (e.key === "Escape")
                close(null);
        };
        document.addEventListener("keydown", onKey);
        root.addEventListener("click", (e) => {
            const target = e.target;
            if (target === root || target.closest("[data-cancel]")) {
                close(null);
                return;
            }
            if (target.closest("[data-confirm]")) {
                close(pick);
                return;
            }
            const toggle = target.closest("[data-toggle]");
            if (toggle) {
                e.stopPropagation();
                const kids = root.querySelector(`[data-kids="${toggle.dataset.toggle}"]`);
                if (kids) {
                    const collapsed = kids.classList.toggle("hidden");
                    toggle.textContent = collapsed ? "▶" : "▼";
                }
                return;
            }
            const all = target.closest("[data-select-all]");
            if (all) {
                all.classList.add("selected");
                setPick({ name: "ROOT", id: "ROOT", nodeType: "folder", trackCount: total });
                return;
            }
            const item = target.closest(".tree-item");
            if (item) {
                root.querySelector("[data-select-all]")?.classList.remove("selected");
                item.querySelector(".tree-row")?.classList.add("selected");
                setPick({
                    name: item.dataset.name ?? "",
                    id: item.dataset.id || null,
                    nodeType: item.dataset.type ?? "playlist",
                    trackCount: parseInt(item.dataset.count ?? "0", 10),
                });
            }
        });
        document.body.appendChild(root);
    });
}
/* ---------------- session setup ---------------- */
/** Resolve an explicit file list (e.g. handed over from Playlist Compare)
 *  into its own upgrader session under app data. Mirrors the playlist
 *  session-dir branch: originals stay in place, ledger lives in the
 *  session dir, entries carry their absolute source paths. */
export async function resolveFileListSession(name, paths) {
    if (!paths || paths.length === 0) {
        throw new Error("No tracks to upgrade.");
    }
    const appDataDir = await getAppDataDir();
    const stamp = sessionTimestamp(new Date());
    const rootPath = `${appDataDir}/sessions/${sanitizeSessionName(name)}_${stamp}`;
    const ledgerPath = joinPath(rootPath, ledgerName());
    const existing = await loadAndReconcile(ledgerPath, paths);
    return {
        rootPath,
        ledgerPath,
        fileList: paths,
        playlistName: name,
        sourceKind: "compare",
        isSessionDir: true,
        existing,
    };
}
async function resolvePlaylistSession(kind, pick, fetchTracks) {
    const paths = await fetchTracks();
    if (!paths || paths.length === 0) {
        throw new Error("No tracks found in the selected item.");
    }
    const ancestor = longestCommonAncestor(paths);
    if (!ancestor)
        throw new Error("Failed to determine common root path.");
    let rootPath = ancestor;
    let isSessionDir = false;
    try {
        const appDataDir = await getAppDataDir();
        if (kind === "db" && pick.id) {
            rootPath =
                pick.id === "ROOT"
                    ? `${appDataDir}/sessions/database_root`
                    : `${appDataDir}/sessions/playlist_${pick.id}`;
        }
        else {
            const stamp = sessionTimestamp(new Date());
            rootPath = `${appDataDir}/sessions/${sanitizeSessionName(pick.name)}_${stamp}`;
        }
        isSessionDir = true;
    }
    catch (err) {
        console.error("Failed to get app data dir, using common ancestor:", err);
    }
    const ledgerPath = joinPath(rootPath, ledgerName());
    const existing = await loadAndReconcile(ledgerPath, paths);
    return {
        rootPath,
        ledgerPath,
        fileList: paths,
        playlistName: pick.name,
        sourceKind: kind,
        isSessionDir,
        existing,
    };
}
/** Load an existing ledger and reconcile it against the current file list. */
async function loadAndReconcile(ledgerPath, absPaths, rootPathForRel) {
    let exists = false;
    try {
        exists = await checkFileExists(ledgerPath);
    }
    catch (err) {
        console.error("check_file_exists failed:", err);
    }
    if (!exists)
        return null;
    const content = await readLedgerFile(ledgerPath);
    const ledger = JSON.parse(content);
    const base = rootPathForRel ?? ledger.root_path;
    const current = new Set();
    const relToAbs = new Map();
    for (const abs of absPaths) {
        const rel = getRelativePath(base, abs);
        current.add(rel);
        relToAbs.set(rel, abs);
    }
    let changed = false;
    for (const relPath of Object.keys(ledger.files ?? {})) {
        if (!current.has(relPath)) {
            delete ledger.files[relPath];
            changed = true;
        }
    }
    for (const relPath of current) {
        if (!ledger.files[relPath]) {
            const entry = {
                status: "pending",
                deezer_id: null,
                staged_path: null,
                proxy_path: null,
                original_abs_path: relToAbs.get(relPath),
            };
            ledger.files[relPath] = entry;
            changed = true;
        }
    }
    if (changed) {
        await writeLedgerFile(ledgerPath, JSON.stringify(ledger, null, 2));
    }
    return ledger;
}
/* ---------------- flows ---------------- */
async function folderFlow() {
    const dir = await selectDirectory(loadPrefs().libraryRoot ?? undefined).catch((err) => {
        console.error("select_directory failed:", err);
        return null;
    });
    if (!dir)
        throw new Error("cancelled");
    const ledgerPath = joinPath(dir, ledgerName());
    let existing = null;
    try {
        if (await checkFileExists(ledgerPath)) {
            existing = JSON.parse(await readLedgerFile(ledgerPath));
        }
    }
    catch (err) {
        console.error("Failed to read progress ledger:", err);
        throw new Error(`Failed to read progress ledger: ${err}`);
    }
    return {
        rootPath: dir,
        ledgerPath,
        fileList: null,
        playlistName: null,
        sourceKind: "folder",
        isSessionDir: false,
        existing,
    };
}
async function xmlFlow() {
    const xmlPath = await selectXmlFile().catch((err) => {
        console.error("select_xml_file failed:", err);
        return null;
    });
    if (!xmlPath)
        throw new Error("cancelled");
    const tree = await loadPlaylistTree({ kind: "xml", xmlPath });
    if (!tree || tree.length === 0)
        throw new Error("No playlists found in XML.");
    const pick = await pickPlaylist("Select Playlist to Upgrade", tree);
    if (!pick)
        throw new Error("cancelled");
    const res = await resolvePlaylistSession("xml", pick, () => fetchTrackList({ kind: "xml", xmlPath }, pick.name, pick.nodeType));
    res.xmlPath = xmlPath;
    return res;
}
async function dbFlow() {
    const tree = await loadPlaylistTree({ kind: "db" });
    if (!tree || tree.length === 0) {
        throw new Error("No playlists found in the Rekordbox database.");
    }
    const pick = await pickPlaylist("Select Playlist to Upgrade", tree);
    if (!pick)
        throw new Error("cancelled");
    return resolvePlaylistSession("db", pick, () => fetchTrackList({ kind: "db" }, pick.name, pick.nodeType));
}
/* ---------------- screen ---------------- */
const SOURCE_META = {
    folder: {
        hint: "Scan a directory of audio files in place.",
        note: "Ledger stays in the folder",
    },
    xml: {
        hint: "Pick a playlist from an exported Rekordbox XML file.",
        note: "Session stored in app data",
    },
    db: {
        hint: "Read playlists from the live Rekordbox master.db.",
        note: "Live database · direct",
    },
};
function pickerSegHtml(current) {
    const opts = [
        ["folder", "Folder"],
        ["xml", "XML"],
        ["db", "Database"],
    ];
    return `<div class="seg" id="ug-source-seg">${opts
        .map(([v, label]) => `<button data-src="${v}" ${v === current ? 'class="on"' : ""}>${label}</button>`)
        .join("")}</div>`;
}
export function renderSourceScreen(el, onResolved, onError) {
    el.className = "screen on";
    el.innerHTML = `
    <div class="ov">
      <div class="mx">
        ${phaseHead("01 · UPGRADER", "Where are the tracks?", "Pick the input. The pipeline fingerprints each file, matches it on Deezer, and stages a lossless replacement for your review.")}
        <div class="sect">
          <h3>Source</h3>
          <div class="frow">
            <span class="fl">Library</span>
            ${pickerSegHtml("folder")}
          </div>
          <div class="frow" id="ug-source-hint">
            <span class="fl"></span>
            <span class="kb">${SOURCE_META.folder.hint}</span>
          </div>
          <div class="frow" id="ug-source-row">
            <span class="fl">Folder</span>
            <input class="field" id="ug-folder-path" readonly
              placeholder="Choose a music folder…" value="" />
            <button class="btn sm" id="ug-source-action">Choose…</button>
          </div>
          <p id="ug-source-note" class="kb" style="margin-top:4px">${SOURCE_META.folder.note}</p>
          <div id="ug-source-arl-alert" class="alert warn hidden" style="margin-top:12px;font-size:12px;padding:8px 12px"></div>
          <p id="ug-source-error" class="warn-text hidden" style="margin-top:8px"></p>
        </div>
      </div>
    </div>`;
    renderUpgraderStage(0);
    renderDock("Source · pick where the tracks live", []);
    renderInspector("");
    const actionBtn = el.querySelector("#ug-source-action");
    const folderField = el.querySelector("#ug-folder-path");
    const hintEl = el.querySelector("#ug-source-hint");
    const noteEl = el.querySelector("#ug-source-note");
    const errBox = el.querySelector("#ug-source-error");
    let mode = "folder";
    const checkGlobalArl = async () => {
        const alertBox = el.querySelector("#ug-source-arl-alert");
        if (!alertBox)
            return;
        try {
            const check = await checkArlStatus();
            if (!check.valid) {
                if (check.status === "missing") {
                    alertBox.innerHTML = `⚠️ <strong>Deezer ARL missing:</strong> Please enter your ARL in <a href="#/settings" style="text-decoration:underline">Settings</a> before upgrading tracks.`;
                    alertBox.classList.remove("hidden");
                }
                else if (check.status === "expired") {
                    alertBox.innerHTML = `⚠️ <strong>Deezer ARL expired:</strong> Your saved token is no longer valid on Deezer. Please update it in <a href="#/settings" style="text-decoration:underline">Settings</a>.`;
                    alertBox.classList.remove("hidden");
                }
            }
            else {
                alertBox.classList.add("hidden");
            }
        }
        catch {
            // ignore
        }
    };
    void checkGlobalArl();
    const setMode = (m) => {
        mode = m;
        const meta = SOURCE_META[m];
        const seg = el.querySelector("#ug-source-seg");
        seg?.querySelectorAll("button").forEach((b) => {
            b.classList.toggle("on", b.dataset.src === m);
        });
        if (hintEl) {
            hintEl.innerHTML = `<span class="fl"></span><span class="kb">${meta.hint}</span>`;
        }
        if (noteEl)
            noteEl.textContent = meta.note;
        if (errBox)
            errBox.classList.add("hidden");
        if (m === "folder") {
            if (folderField) {
                folderField.value = "";
                folderField.placeholder = "Choose a music folder…";
            }
            if (actionBtn)
                actionBtn.textContent = "Choose…";
        }
        else if (m === "xml") {
            if (folderField) {
                folderField.value = "";
                folderField.placeholder = "Choose a Rekordbox XML export…";
            }
            if (actionBtn)
                actionBtn.textContent = "Open…";
        }
        else {
            if (folderField) {
                folderField.value = "";
                folderField.placeholder = "Reads playlists from master.db…";
            }
            if (actionBtn)
                actionBtn.textContent = "Load playlists…";
        }
    };
    el.querySelector("#ug-source-seg")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-src]");
        if (btn)
            setMode(btn.dataset.src);
    });
    const fail = (err) => {
        if (err instanceof Error && err.message === "cancelled")
            return;
        console.error(err);
        onError(err instanceof Error ? err.message : String(err));
    };
    const run = async (fn) => {
        if (!(await verifyGlobalArl()))
            return;
        if (errBox)
            errBox.classList.add("hidden");
        if (actionBtn)
            actionBtn.disabled = true;
        try {
            const res = await fn();
            if (folderField)
                folderField.value = res.rootPath;
            openSession({
                tool: "upgrader",
                rootPath: res.rootPath,
                playlistName: res.playlistName,
                ledgerPath: res.ledgerPath,
                sourceKind: res.sourceKind,
                isSessionDir: res.isSessionDir,
                outputFormat: res.existing?.output_format ?? null,
                xmlPath: res.xmlPath ?? null,
            });
            onResolved(res);
        }
        catch (err) {
            fail(err);
            if (actionBtn)
                actionBtn.disabled = false;
        }
    };
    actionBtn?.addEventListener("click", () => {
        if (mode === "folder")
            void run(folderFlow);
        else if (mode === "xml")
            void run(xmlFlow);
        else
            void run(dbFlow);
    });
}
