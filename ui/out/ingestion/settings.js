/* Ingestion Hub workbench state: staged track list + input validation +
 * per-session run records. Pure (DOM-free) — unit-tested.
 *
 * Modifier dropdowns reuse the cleaner's `rebuilder_*` localStorage keys:
 * same dedup prefs across tools. Destination persists under its own key;
 * the playlist name is always fresh (autofilled from dropped folders). */
import { loadCleanerModifiers, saveCleanerModifiers, } from "../cleaner/settings.js";
export function trackFromPath(filePath, sizeBytes) {
    const filename = filePath.split("/").pop() ?? filePath.split("\\").pop() ?? filePath;
    const dot = filename.lastIndexOf(".");
    const format = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
    return { path: filePath, name: filename, size: formatBytes(sizeBytes), format };
}
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return "—";
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let v = bytes / 1024;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u++;
    }
    return `${v.toFixed(1)} ${units[u]}`;
}
/** Merge new paths into the staged list; intra-list path-deduped. */
export function addStagedTracks(staged, incoming) {
    const seen = new Set(staged.map((t) => t.path));
    const out = [...staged];
    for (const t of incoming) {
        if (!seen.has(t.path)) {
            seen.add(t.path);
            out.push(t);
        }
    }
    return out;
}
export function removeStagedTrack(staged, filePath) {
    return staged.filter((t) => t.path !== filePath);
}
/** Rebuild a display-only staged list from bare paths (session resume —
 *  sizes unknown until re-added, so they show as em-dash). */
export function stagedFromPaths(paths) {
    return paths.map((p) => trackFromPath(p, 0));
}
export function validateIngestInputs(stagedCount, playlistName, destPath) {
    const reasons = [];
    if (stagedCount <= 0)
        reasons.push("Stage at least one audio file.");
    if (playlistName.trim().length === 0)
        reasons.push("Name the playlist.");
    if (destPath.trim().length === 0)
        reasons.push("Pick a destination folder.");
    return { ok: reasons.length === 0, reasons };
}
export function defaultXmlName(playlistName) {
    const slug = playlistName.trim().replace(/\s+/g, "_") || "playlist";
    return `${slug}_import.xml`;
}
/* ---- persisted bits ---- */
const DEST_KEY = "ingest_dest_path";
const STAGED_KEY = "ingest_staged_paths";
const LIBRARY_CHECK_KEY = "ingest_library_check";
function read() {
    try {
        return globalThis.localStorage ?? null;
    }
    catch {
        return null;
    }
}
export function loadIngestDest() {
    return read()?.getItem(DEST_KEY) ?? "";
}
export function saveIngestDest(destPath) {
    read()?.setItem(DEST_KEY, destPath);
}
/** Match staged songs against the live Rekordbox library (default on).
 *  Matches link to the existing file: no copy, no duplicate db entry. */
export function loadLibraryCheck() {
    const raw = read()?.getItem(LIBRARY_CHECK_KEY);
    return raw === null ? true : raw !== "0";
}
export function saveLibraryCheck(on) {
    read()?.setItem(LIBRARY_CHECK_KEY, on ? "1" : "0");
}
/** Staged file paths survive navigation and restarts (workbench memory).
 *  Files may vanish meanwhile — the backend reports those as missing. */
export function loadStagedPaths() {
    try {
        const raw = read()?.getItem(STAGED_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
    }
    catch {
        return [];
    }
}
export function saveStagedPaths(paths) {
    try {
        read()?.setItem(STAGED_KEY, JSON.stringify(paths));
    }
    catch {
        // ignore
    }
}
export { loadCleanerModifiers, saveCleanerModifiers };
const RUNS_KEY = "crateup_ingestion_runs_v1";
function readRuns() {
    try {
        const raw = read()?.getItem(RUNS_KEY);
        if (!raw)
            return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function writeRuns(runs) {
    try {
        read()?.setItem(RUNS_KEY, JSON.stringify(runs));
    }
    catch {
        // quota — records stay in memory only
    }
}
export function saveIngestionRun(sessionId, run) {
    const runs = readRuns();
    runs[sessionId] = run;
    writeRuns(runs);
}
export function loadIngestionRun(sessionId) {
    const run = readRuns()[sessionId] ?? null;
    if (!run || typeof run.playlistName !== "string" || typeof run.destPath !== "string") {
        return null;
    }
    if (!run.result || typeof run.result.healthy_count !== "number")
        return null;
    if (!Array.isArray(run.stagedFiles))
        run.stagedFiles = [];
    return run;
}
export function removeIngestionRun(sessionId) {
    const runs = readRuns();
    if (runs[sessionId]) {
        delete runs[sessionId];
        writeRuns(runs);
    }
}
