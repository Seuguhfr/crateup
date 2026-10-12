/* Library Audit workbench state: search roots, selection helpers, summary
 * formatting, per-session run records. Pure (DOM-free) — unit-tested. */
export function summarizeAudit(report) {
    let dupes = 0;
    let orphans = 0;
    for (const l of report.leftovers) {
        if (l.kind === "duplicate")
            dupes++;
        else
            orphans++;
    }
    let twinFiles = 0;
    for (const g of report.stray_groups)
        twinFiles += g.files.length;
    return {
        audioFiles: report.audio_file_count,
        referenced: report.referenced_count,
        leftovers: report.leftovers.length,
        dupes,
        orphans,
        twinFiles,
        twinFolders: report.stray_groups.length,
        outside: report.outside_db.length,
        missing: report.missing_db.length,
        wastedBytes: report.bytes_wasted,
    };
}
/** Pure checkbox-list toggle. */
export function toggleSelected(selected, filePath) {
    return selected.includes(filePath)
        ? selected.filter((p) => p !== filePath)
        : [...selected, filePath];
}
/** Unique parent folders of paths (for the empty-folder removal step). */
export function parentFolders(paths) {
    const out = new Set();
    for (const p of paths) {
        const sep = p.includes("/") ? "/" : "\\";
        const idx = p.lastIndexOf(sep);
        if (idx > 0)
            out.add(p.slice(0, idx));
    }
    return [...out].sort();
}
function read() {
    try {
        return globalThis.localStorage ?? null;
    }
    catch {
        return null;
    }
}
const ROOTS_KEY = "audit_search_roots";
export function loadSearchRoots() {
    try {
        const raw = read()?.getItem(ROOTS_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
    }
    catch {
        return [];
    }
}
export function saveSearchRoots(roots) {
    try {
        read()?.setItem(ROOTS_KEY, JSON.stringify(roots));
    }
    catch {
        // ignore
    }
}
const RUNS_KEY = "crateup_audit_runs_v1";
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
export function saveAuditRun(sessionId, run) {
    try {
        const runs = readRuns();
        runs[sessionId] = run;
        read()?.setItem(RUNS_KEY, JSON.stringify(runs));
    }
    catch {
        // quota — record stays in memory only
    }
}
export function loadAuditRun(sessionId) {
    const run = readRuns()[sessionId] ?? null;
    if (!run || typeof run.libraryRoot !== "string" || !run.report)
        return null;
    if (!Array.isArray(run.report.leftovers))
        return null;
    return run;
}
export function removeAuditRun(sessionId) {
    try {
        const runs = readRuns();
        if (runs[sessionId]) {
            delete runs[sessionId];
            read()?.setItem(RUNS_KEY, JSON.stringify(runs));
        }
    }
    catch {
        // ignore
    }
}
