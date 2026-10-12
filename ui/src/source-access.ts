/* Library source access: one place to read Rekordbox libraries —
 * XML exports and the live master.db — as playlist trees and track lists.
 * Consumed by the upgrader source picker and Playlist Compare (and any
 * future tool) instead of each reimplementing picking + fetching. */

import {
  getFolderTracks,
  getFolderTracksFromDb,
  getPlaylistTracks,
  getPlaylistTracksFromDb,
  parsePlaylists,
  parsePlaylistsFromDb,
} from "./api.js";

export interface PlaylistNode {
  id?: string | null;
  name: string;
  type: string;
  entryCount?: number;
  totalTracks?: number;
  children?: PlaylistNode[];
}

export interface PlaylistOption {
  /** Stable select value: indexes the node, not just the name. */
  key: string;
  /** Breadcrumb display name, e.g. "Party / Warm-up". */
  label: string;
  name: string;
  nodeType: "playlist" | "folder";
}

/** A readable library: an XML export file, or the live database. */
export type LibrarySource = { kind: "xml"; xmlPath: string } | { kind: "db" };

/** Parse the playlist tree for a source. Throws with backend detail. */
export async function loadPlaylistTree(src: LibrarySource): Promise<PlaylistNode[]> {
  const raw =
    src.kind === "db" ? await parsePlaylistsFromDb() : await parsePlaylists(src.xmlPath);
  const tree = JSON.parse(raw) as PlaylistNode[] | { children?: PlaylistNode[] };
  return Array.isArray(tree) ? tree : (tree.children ?? []);
}

/** Fetch absolute track paths for a playlist or folder node.
 *  Anything that is not a folder is read as a playlist. */
export async function fetchTrackList(
  src: LibrarySource,
  name: string,
  nodeType: string,
): Promise<string[]> {
  if (src.kind === "db") {
    return nodeType === "folder"
      ? getFolderTracksFromDb(name)
      : getPlaylistTracksFromDb(name);
  }
  return nodeType === "folder"
    ? getFolderTracks(src.xmlPath, name)
    : getPlaylistTracks(src.xmlPath, name);
}

/** Flatten a playlist tree to selectable entries: leaf playlists plus
 *  folders (a folder aggregates every track in its sub-playlists). */
export function collectPlaylists(
  nodes: PlaylistNode[],
  prefix = "",
  out: PlaylistOption[] = [],
): PlaylistOption[] {
  nodes.forEach((node, i) => {
    const label = prefix ? `${prefix} / ${node.name}` : node.name;
    const key = `${label}::${node.type}::${i}`;
    if (node.type === "folder" && node.children && node.children.length > 0) {
      out.push({ key, label, name: node.name, nodeType: "folder" });
      collectPlaylists(node.children, label, out);
    } else if (node.type === "playlist") {
      out.push({ key, label, name: node.name, nodeType: "playlist" });
    }
  });
  return out;
}
