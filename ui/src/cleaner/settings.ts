/* Library Cleaner settings: localStorage-backed modifiers + strategy +
 * paths, validated on load. Reuses the legacy `rebuilder_*` keys so
 * settings survive the legacy → native port. Pure — unit-tested. */

export type FileMode = "copy" | "move" | "link";
export type CrossFormat = "smart" | "strict";
export type DedupDepth = "strict" | "standard" | "fuzzy";
export type RenamingRule = "preserve" | "clean";
export type CleanerStrategy = "xml" | "db";

export interface CleanerModifiers {
  fileMode: FileMode;
  crossFormat: CrossFormat;
  dedupDepth: DedupDepth;
  renamingRule: RenamingRule;
}

export const DEFAULT_MODIFIERS: CleanerModifiers = {
  fileMode: "copy",
  crossFormat: "smart",
  dedupDepth: "standard",
  renamingRule: "preserve",
};

const KEYS = {
  strategy: "rebuilder_strategy",
  xmlPath: "rebuilder_xml_path",
  destPath: "rebuilder_destination_path",
  fileMode: "rebuilder_op_mode",
  crossFormat: "rebuilder_cross_format",
  dedupDepth: "rebuilder_dedup_depth",
  renamingRule: "rebuilder_rename_rules",
} as const;

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function read(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadCleanerModifiers(): CleanerModifiers {
  const ls = read();
  if (!ls) return { ...DEFAULT_MODIFIERS };
  return {
    fileMode: pick(ls.getItem(KEYS.fileMode), ["copy", "move", "link"], DEFAULT_MODIFIERS.fileMode),
    crossFormat: pick(ls.getItem(KEYS.crossFormat), ["smart", "strict"], DEFAULT_MODIFIERS.crossFormat),
    dedupDepth: pick(
      ls.getItem(KEYS.dedupDepth),
      ["strict", "standard", "fuzzy"],
      DEFAULT_MODIFIERS.dedupDepth,
    ),
    renamingRule: pick(
      ls.getItem(KEYS.renamingRule),
      ["preserve", "clean"],
      DEFAULT_MODIFIERS.renamingRule,
    ),
  };
}

export function saveCleanerModifiers(m: CleanerModifiers): void {
  const ls = read();
  if (!ls) return;
  ls.setItem(KEYS.fileMode, m.fileMode);
  ls.setItem(KEYS.crossFormat, m.crossFormat);
  ls.setItem(KEYS.dedupDepth, m.dedupDepth);
  ls.setItem(KEYS.renamingRule, m.renamingRule);
}

export function loadCleanerStrategy(): CleanerStrategy | null {
  const raw = read()?.getItem(KEYS.strategy);
  return raw === "xml" || raw === "db" ? raw : null;
}

export function saveCleanerStrategy(s: CleanerStrategy): void {
  read()?.setItem(KEYS.strategy, s);
}

export interface CleanerPaths {
  xmlPath: string;
  destPath: string;
}

export function loadCleanerPaths(): CleanerPaths {
  const ls = read();
  return {
    xmlPath: ls?.getItem(KEYS.xmlPath) ?? "",
    destPath: ls?.getItem(KEYS.destPath) ?? "",
  };
}

export function saveCleanerPaths(p: CleanerPaths): void {
  const ls = read();
  if (!ls) return;
  ls.setItem(KEYS.xmlPath, p.xmlPath);
  ls.setItem(KEYS.destPath, p.destPath);
}

/* ---- backup-cleanup report summary ---- */

export interface CleanupEntry {
  path: string;
  status: string;
}

export interface CleanupSummary {
  deleted: number;
  kept: number;
  failed: number;
}

/** Backend statuses: `deleted`, `skipped_*` (kept), `delete_failed: …`. */
export function summarizeCleanup(results: CleanupEntry[]): CleanupSummary {
  let deleted = 0;
  let kept = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "deleted") deleted++;
    else if (r.status.startsWith("delete_failed")) failed++;
    else kept++;
  }
  return { deleted, kept, failed };
}

export function cleanupReportLine(s: CleanupSummary): string {
  const bits = [`${s.deleted} deleted`];
  if (s.kept > 0) bits.push(`${s.kept} kept`);
  if (s.failed > 0) bits.push(`${s.failed} failed`);
  return bits.join(" · ");
}

/* ---- per-session run records ----
 * The cleaner has no ledger, so the finished run (config + result) is
 * persisted per session id. Re-entering the session restores the exact
 * summary screen, backup actions included. */

export interface CleanerRunRecord {
  strategy: CleanerStrategy;
  xmlPath: string;
  destPath: string;
  opts: CleanerModifiers;
  result: {
    success: boolean;
    healthy_count: number;
    missing_count: number;
    duplicate_count: number;
    missing_list: string[];
    backup_filename: string | null;
    superseded_paths?: string[];
  };
}

const RUNS_KEY = "crateup_cleaner_runs_v1";

function readRuns(): Record<string, CleanerRunRecord> {
  try {
    const raw = read()?.getItem(RUNS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CleanerRunRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRuns(runs: Record<string, CleanerRunRecord>): void {
  try {
    read()?.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch {
    // quota — records stay in memory only
  }
}

export function saveCleanerRun(sessionId: string, run: CleanerRunRecord): void {
  const runs = readRuns();
  runs[sessionId] = run;
  writeRuns(runs);
}

export function loadCleanerRun(sessionId: string): CleanerRunRecord | null {
  const run = readRuns()[sessionId] ?? null;
  if (!run || (run.strategy !== "xml" && run.strategy !== "db")) return null;
  if (typeof run.destPath !== "string" || !run.destPath) return null;
  if (!run.result || typeof run.result.healthy_count !== "number") return null;
  return run;
}

export function removeCleanerRun(sessionId: string): void {
  const runs = readRuns();
  if (runs[sessionId]) {
    delete runs[sessionId];
    writeRuns(runs);
  }
}
