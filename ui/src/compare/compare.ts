/* Playlist compare: pure track-list diffing. No DOM, no Tauri — unit-testable.
 * Tree-walking (PlaylistNode/PlaylistOption/collectPlaylists) lives in
 * ../source-access.js, shared with the upgrader source picker. */

export interface PlaylistDiff {
  common: string[];
  onlyA: string[];
  onlyB: string[];
}

/** Canonical identity of a track path: decoded, trimmed, case-folded.
 *  macOS volumes are usually case-insensitive, so `Song.mp3` and
 *  `song.mp3` count as the same file. */
export function normalizeTrackKey(path: string): string {
  let p = path.trim();
  try {
    p = decodeURIComponent(p);
  } catch {
    // not percent-encoded — use as-is
  }
  return p.toLowerCase();
}

export function displayTrackName(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = clean.split("/").pop() ?? clean;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

/** Diff two track lists. Duplicates within one list count once;
 *  first-seen spellings are kept for display. */
export function diffPlaylists(a: string[], b: string[]): PlaylistDiff {
  const mapA = new Map<string, string>();
  for (const p of a) {
    const k = normalizeTrackKey(p);
    if (!mapA.has(k)) mapA.set(k, p);
  }
  const mapB = new Map<string, string>();
  for (const p of b) {
    const k = normalizeTrackKey(p);
    if (!mapB.has(k)) mapB.set(k, p);
  }
  const common: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const [k, p] of mapA) {
    if (mapB.has(k)) common.push(p);
    else onlyA.push(p);
  }
  for (const [k, p] of mapB) {
    if (!mapA.has(k)) onlyB.push(p);
  }
  const byName = (x: string, y: string) =>
    displayTrackName(x).localeCompare(displayTrackName(y));
  common.sort(byName);
  onlyA.sort(byName);
  onlyB.sort(byName);
  return { common, onlyA, onlyB };
}
