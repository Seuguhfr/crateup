/* Pure upgrader helpers — no DOM, no Tauri. Covered by tests/. */

export interface LedgerEntry {
  status: string;
  deezer_id?: number | null;
  staged_path?: string | null;
  proxy_path?: string | null;
  decision?: string;
  [key: string]: unknown;
}

export interface Ledger {
  session_id?: string;
  root_path: string;
  output_format: string;
  files: Record<string, LedgerEntry>;
}

export interface StatusCounts {
  total: number;
  pending: number;
  downloaded: number;
  unidentified: number;
  not_on_deezer: number;
  download_failed: number;
  committed: number;
  skipped: number;
  decided: number;
}

const EMPTY: StatusCounts = {
  total: 0,
  pending: 0,
  downloaded: 0,
  unidentified: 0,
  not_on_deezer: 0,
  download_failed: 0,
  committed: 0,
  skipped: 0,
  decided: 0,
};

export function countLedger(ledger: Ledger): StatusCounts {
  const counts: StatusCounts = { ...EMPTY };
  const files = ledger.files ?? {};
  for (const relPath of Object.keys(files)) {
    const entry = files[relPath];
    counts.total++;
    switch (entry.status) {
      case "pending":
        counts.pending++;
        break;
      case "downloaded":
        counts.downloaded++;
        break;
      case "unidentified":
        counts.unidentified++;
        break;
      case "not_on_deezer":
        counts.not_on_deezer++;
        break;
      case "download_failed":
        counts.download_failed++;
        break;
      case "committed":
        counts.committed++;
        break;
      case "skipped":
        counts.skipped++;
        break;
      default:
        break;
    }
    if (entry.decision && entry.decision !== "pending") counts.decided++;
  }
  return counts;
}

export type ProgressSignal =
  | { kind: "totals"; pending: number; total: number }
  | { kind: "step" }
  | { kind: "other" };

const STEP_MARKERS = [
  "Successfully staged replacement",
  "Fingerprinting failed",
  "Track identified but not found on Deezer",
  "Marking as not_on_deezer",
];

export function parseProgressLine(line: string): ProgressSignal {
  const m = line.match(/Found (\d+) pending files out of (\d+) total files/);
  if (m) {
    return {
      kind: "totals",
      pending: parseInt(m[1], 10),
      total: parseInt(m[2], 10),
    };
  }
  if (STEP_MARKERS.some((marker) => line.includes(marker))) {
    return { kind: "step" };
  }
  return { kind: "other" };
}

export function joinPath(base: string, rel: string): string {
  if (!base) return rel;
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const cleanRel = rel.startsWith("/") ? rel : "/" + rel;
  return cleanBase + cleanRel;
}

export function getRelativePath(from: string, to: string): string {
  const fromParts = from.replace(/\\/g, "/").split("/").filter(Boolean);
  const toParts = to.replace(/\\/g, "/").split("/").filter(Boolean);

  let commonLength = 0;
  while (
    commonLength < fromParts.length &&
    commonLength < toParts.length &&
    fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength++;
  }

  const upParts = Array(fromParts.length - commonLength).fill("..");
  const downParts = toParts.slice(commonLength);

  let rel = upParts.concat(downParts).join("/");
  if (!rel.startsWith("/")) rel = "/" + rel;
  return rel;
}

export function longestCommonAncestor(paths: string[]): string {
  if (!paths || paths.length === 0) return "";
  if (paths.length === 1) {
    const parts = paths[0].split("/");
    parts.pop();
    return parts.join("/") || "/";
  }

  const split = paths.map((p) => p.split("/"));
  const minLength = Math.min(...split.map((parts) => parts.length));

  const common: string[] = [];
  for (let i = 0; i < minLength; i++) {
    const part = split[0][i];
    if (split.every((parts) => parts[i] === part)) common.push(part);
    else break;
  }

  let out = common.join("/");
  if (paths[0].startsWith("/") && !out.startsWith("/")) out = "/" + out;
  return out || "/";
}

/** Prod vs dev ledger name, matching legacy behavior. */
export function ledgerNameForHost(port: string): string {
  return port !== "" ? ".crateup-progress-dev.json" : ".crateup-progress.json";
}

export function sanitizeSessionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function sessionTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/* ---- presentation helpers (pure, testable) ---- */

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function fmtBitrate(bps: number | null | undefined): string {
  if (!bps) return "—";
  const kbps = Math.round(bps / 1000);
  return `${kbps} kbps`;
}

export function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isLosslessExt(path: string): boolean {
  const ext = extOf(path);
  return ["flac", "wav", "aiff", "aif", "alac"].includes(ext);
}
