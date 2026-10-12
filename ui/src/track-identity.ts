/* Track identity: the inter-tool currency for "the same song".
 *
 * Today each tool keys songs differently (ledger relPaths, XML TrackIDs,
 * raw paths, Deezer IDs). This module is the shared vocabulary: a path,
 * best-effort artist/title parsed from the filename, and a stable key
 * that groups different files of one recording (MP3 + FLAC) so tools can
 * hand each other selections without duplicating work. Pure — unit-tested. */

export interface TrackIdentity {
  /** Absolute source path. */
  path: string;
  /** Display name (decoded basename). */
  name: string;
  artist: string | null;
  title: string | null;
}

const AUDIO_EXTS = new Set(["flac", "wav", "aiff", "aif", "alac"]);

function basenameOf(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = clean.split("/").pop() ?? clean;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

function stripExt(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{2,5}$/, "");
}

/** Parse "Artist - Title.ext" filenames. Returns nulls when the
 *  convention is absent — callers fall back to path identity. */
export function identityFromPath(path: string): TrackIdentity {
  const name = basenameOf(path);
  const stem = stripExt(name).trim();
  const sep = stem.indexOf(" - ");
  if (sep > 0 && sep < stem.length - 3) {
    const artist = stem.slice(0, sep).trim();
    const title = stem.slice(sep + 3).trim();
    if (artist && title) return { path, name, artist, title };
  }
  return { path, name, artist: null, title: null };
}

/** Grouping key: normalized artist+title when parseable, else the
 *  normalized path. Same recording in two encodings shares a key. */
export function identityKey(id: TrackIdentity): string {
  if (id.artist && id.title) {
    return `song:${id.artist.toLowerCase().trim()}\0${id.title.toLowerCase().trim()}`;
  }
  return `path:${id.path.trim().toLowerCase()}`;
}

function extensionOf(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

/** Prefer lossless containers when one recording has several files. */
export function preferredPath(paths: string[]): string {
  const sorted = [...paths].sort();
  return (
    sorted.find((p) => AUDIO_EXTS.has(extensionOf(p))) ?? sorted[0] ?? ""
  );
}

/** Collapse a path list to one file per recording. Order-stable. */
export function dedupeIdentities(paths: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = identityKey(identityFromPath(p));
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.values()].map(preferredPath).filter(Boolean);
}
