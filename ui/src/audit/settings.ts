/* Library Audit workbench state: search roots, selection helpers, summary
 * formatting, per-session run records. Pure (DOM-free) — unit-tested. */

export interface LeftoverView {
  path: string;
  size: number;
  kind: string;
  dupe_of: string | null;
}

export interface AuditSummary {
  audioFiles: number;
  referenced: number;
  leftovers: number;
  dupes: number;
  orphans: number;
  twinFiles: number;
  twinFolders: number;
  outside: number;
  missing: number;
  wastedBytes: number;
}

export function summarizeAudit(report: {
  audio_file_count: number;
  referenced_count: number;
  leftovers: LeftoverView[];
  stray_groups: Array<{ folder: string; files: string[] }>;
  outside_db: unknown[];
  missing_db: unknown[];
  bytes_wasted: number;
}): AuditSummary {
  let dupes = 0;
  let orphans = 0;
  for (const l of report.leftovers) {
    if (l.kind === "duplicate") dupes++;
    else orphans++;
  }
  let twinFiles = 0;
  for (const g of report.stray_groups) twinFiles += g.files.length;
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
export function toggleSelected(selected: string[], filePath: string): string[] {
  return selected.includes(filePath)
    ? selected.filter((p) => p !== filePath)
    : [...selected, filePath];
}

/** Unique parent folders of paths (for the empty-folder removal step). */
export function parentFolders(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const sep = p.includes("/") ? "/" : "\\";
    const idx = p.lastIndexOf(sep);
    if (idx > 0) out.add(p.slice(0, idx));
  }
  return [...out].sort();
}

function read(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const ROOTS_KEY = "audit_search_roots";

export function loadSearchRoots(): string[] {
  try {
    const raw = read()?.getItem(ROOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function saveSearchRoots(roots: string[]): void {
  try {
    read()?.setItem(ROOTS_KEY, JSON.stringify(roots));
  } catch {
    // ignore
  }
}

/* ---- per-session run records (summary + full report) ---- */

export interface AuditRunRecord {
  libraryRoot: string;
  searchRoots: string[];
  report: {
    library_root: string;
    audio_file_count: number;
    referenced_count: number;
    leftovers: LeftoverView[];
    stray_groups: Array<{ folder: string; files: string[] }>;
    twins_found_extra: number;
    twins_total_extra: number;
    outside_db: string[];
    missing_db: string[];
    skipped_dirs: string[];
    bytes_wasted: number;
  };
}

const RUNS_KEY = "crateup_audit_runs_v1";

function readRuns(): Record<string, AuditRunRecord> {
  try {
    const raw = read()?.getItem(RUNS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, AuditRunRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveAuditRun(sessionId: string, run: AuditRunRecord): void {
  try {
    const runs = readRuns();
    runs[sessionId] = run;
    read()?.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch {
    // quota — record stays in memory only
  }
}

export function loadAuditRun(sessionId: string): AuditRunRecord | null {
  const run = readRuns()[sessionId] ?? null;
  if (!run || typeof run.libraryRoot !== "string" || !run.report) return null;
  if (!Array.isArray(run.report.leftovers)) return null;
  return run;
}

export function removeAuditRun(sessionId: string): void {
  try {
    const runs = readRuns();
    if (runs[sessionId]) {
      delete runs[sessionId];
      read()?.setItem(RUNS_KEY, JSON.stringify(runs));
    }
  } catch {
    // ignore
  }
}
