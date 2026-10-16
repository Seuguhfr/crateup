/* App store: route + theme + session list. No framework, pub/sub only.
 *
 * Sessions are first-class objects: each folder/playlist pick opens (or
 * resumes) a session owned by one tool. Closing a session keeps it in the
 * list; resetting deletes its files AND removes it from the list. */

export type Route = "home" | "upgrader" | "cleaner" | "ingestion" | "compare" | "settings" | "audit";

export const ROUTES: Route[] = [
  "home",
  "upgrader",
  "cleaner",
  "ingestion",
  "compare",
  "settings",
  "audit",
];

export type SourceKind = "folder" | "xml" | "db" | "compare";

export type ToolId = "upgrader" | "cleaner" | "ingestion" | "compare" | "audit";

export type SessionStatus = "active" | "running" | "review" | "done";

export interface Session {
  id: string;
  tool: ToolId;
  name: string;
  rootPath: string | null;
  playlistName: string | null;
  ledgerPath: string | null;
  sourceKind: SourceKind | null;
  isSessionDir: boolean;
  outputFormat: string | null;
  progressLabel: string | null;
  status: SessionStatus;
  hasFollowUps: boolean;
  updatedAt: number;
  xmlPath?: string | null;
}

/** View of the current session used by existing call sites. */
export type SessionState = Omit<
  Session,
  "id" | "tool" | "name" | "status" | "hasFollowUps" | "updatedAt"
>;

export interface OpenSessionInput {
  id?: string;
  tool: ToolId;
  rootPath: string | null;
  playlistName?: string | null;
  ledgerPath?: string | null;
  sourceKind?: SourceKind | null;
  isSessionDir?: boolean;
  outputFormat?: string | null;
  xmlPath?: string | null;
}

type Listener = () => void;

let sessions: Session[] = [];
let currentId: string | null = null;

const listeners = new Set<Listener>();

const THEME_KEY = "crateup_theme";
const SESSIONS_KEY = "crateup_sessions_v1";
const LEGACY_SESSION_KEY = "crateup_session";

export function sessionBasename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}

function makeSessionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Identity of a source: folders by root path, session dirs by ledger path
 *  (XML timestamped dirs are unique per pick; db playlist dirs are stable). */
export function sourceKeyFor(
  tool: ToolId,
  opts: { rootPath: string | null; ledgerPath?: string | null; isSessionDir?: boolean },
): string {
  const key = opts.isSessionDir
    ? (opts.ledgerPath ?? opts.rootPath ?? "")
    : (opts.rootPath ?? opts.ledgerPath ?? "");
  return `${tool}:${key}`;
}

function deriveSessionName(
  playlistName: string | null | undefined,
  rootPath: string | null,
): string {
  if (playlistName) return playlistName;
  if (rootPath) return sessionBasename(rootPath);
  return "Session";
}

function findBySource(tool: ToolId, opts: { rootPath: string | null; ledgerPath?: string | null; isSessionDir?: boolean }): Session | null {
  const key = sourceKeyFor(tool, opts);
  return (
    sessions.find(
      (s) =>
        sourceKeyFor(s.tool, {
          rootPath: s.rootPath,
          ledgerPath: s.ledgerPath,
          isSessionDir: s.isSessionDir,
        }) === key,
    ) ?? null
  );
}

function notify(): void {
  listeners.forEach((fn) => fn());
}

function persistSessions(): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({ sessions, currentId }));
  } catch {
    // quota/unavailable — in-memory sessions still work for this run
  }
}

function hydrateSessions(): void {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as {
        sessions?: Session[];
        currentId?: string | null;
      };
      if (Array.isArray(saved.sessions)) {
        sessions = saved.sessions.filter((s) => s && typeof s.id === "string");
        currentId =
          typeof saved.currentId === "string" &&
          sessions.some((s) => s.id === saved.currentId)
            ? saved.currentId
            : null;
        return;
      }
    }
  } catch {
    // malformed — fall through to legacy migration / fresh start
  }
  migrateLegacySession();
}

function migrateLegacySession(): void {
  try {
    const raw = localStorage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<SessionState>;
    if (saved && typeof saved.rootPath === "string" && saved.rootPath) {
      const now = Date.now();
      const session: Session = {
        id: makeSessionId(),
        tool: "upgrader",
        name: deriveSessionName(saved.playlistName ?? null, saved.rootPath),
        rootPath: saved.rootPath,
        playlistName: saved.playlistName ?? null,
        ledgerPath: saved.ledgerPath ?? null,
        sourceKind: saved.sourceKind ?? null,
        isSessionDir: saved.isSessionDir ?? false,
        outputFormat: saved.outputFormat ?? null,
        progressLabel: saved.progressLabel ?? null,
        status: "active",
        hasFollowUps: false,
        updatedAt: now,
      };
      sessions = [session];
      currentId = session.id;
      persistSessions();
    }
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // unreadable legacy session — start fresh
  }
}

hydrateSessions();

export function getTheme(): "dark" | "light" {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function setTheme(theme: "dark" | "light"): void {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.dataset.theme = theme;
  notify();
}

/** All sessions in stable creation order (newest created first). */
export function listSessions(): Session[] {
  return [...sessions];
}

/** The currently open session, if any. */
export function getSession(): Session | null {
  if (!currentId) return null;
  return sessions.find((s) => s.id === currentId) ?? null;
}

export function getSessionById(id: string): Session | null {
  return sessions.find((s) => s.id === id) ?? null;
}

export function getCurrentId(): string | null {
  return currentId;
}

/** Open a session for a picked source, resuming the existing one when the
 *  same source was already opened with the same tool. Makes it current. */
export function openSession(input: OpenSessionInput): Session {
  const now = Date.now();
  const resumed = findBySource(input.tool, {
    rootPath: input.rootPath,
    ledgerPath: input.ledgerPath ?? null,
    isSessionDir: input.isSessionDir ?? false,
  });
  if (resumed) {
    resumed.name = deriveSessionName(
      input.playlistName ?? resumed.playlistName,
      input.rootPath ?? resumed.rootPath,
    );
    if (input.rootPath) resumed.rootPath = input.rootPath;
    if (input.playlistName !== undefined) resumed.playlistName = input.playlistName ?? null;
    if (input.ledgerPath) resumed.ledgerPath = input.ledgerPath;
    if (input.sourceKind) resumed.sourceKind = input.sourceKind;
    resumed.isSessionDir = input.isSessionDir ?? resumed.isSessionDir;
    if (input.outputFormat !== undefined) resumed.outputFormat = input.outputFormat;
    if (input.xmlPath !== undefined) resumed.xmlPath = input.xmlPath ?? null;
    resumed.updatedAt = now;
    currentId = resumed.id;
    persistSessions();
    notify();
    return { ...resumed };
  }
  const session: Session = {
    id: input.id ?? makeSessionId(),
    tool: input.tool,
    name: deriveSessionName(input.playlistName ?? null, input.rootPath),
    rootPath: input.rootPath,
    playlistName: input.playlistName ?? null,
    ledgerPath: input.ledgerPath ?? null,
    sourceKind: input.sourceKind ?? null,
    isSessionDir: input.isSessionDir ?? false,
    outputFormat: input.outputFormat ?? null,
    progressLabel: null,
    status: "active",
    hasFollowUps: false,
    updatedAt: now,
    xmlPath: input.xmlPath ?? null,
  };
  sessions.unshift(session);
  currentId = session.id;
  persistSessions();
  notify();
  return { ...session };
}

/** Enter an existing session (sidebar resume). Returns false when unknown.
 *  Preserves stable sidebar position (never mutates updatedAt or reorders). */
export function enterSession(id: string): boolean {
  const found = sessions.find((s) => s.id === id);
  if (!found) return false;
  currentId = id;
  persistSessions();
  notify();
  return true;
}

/** Close the current session: it stays in the list, work is kept. */
export function closeSession(): void {
  if (!currentId) return;
  currentId = null;
  persistSessions();
  notify();
}

/** Patch a session (progress, status, follow-ups). */
export function updateSession(id: string, patch: Partial<Omit<Session, "id">>): void {
  const found = sessions.find((s) => s.id === id);
  if (!found) return;
  Object.assign(found, patch, { updatedAt: Date.now() });
  persistSessions();
  notify();
}

/** Patch the current session; no-op when none is open. */
export function setSession(patch: Partial<SessionState>): void {
  if (!currentId) return;
  updateSession(currentId, patch);
}

/** Delete a session from the list (reset path — files are deleted separately
 *  by the caller before/after this). Clears current when it was open. */
export function removeSession(id: string): void {
  sessions = sessions.filter((s) => s.id !== id);
  if (currentId === id) currentId = null;
  persistSessions();
  notify();
}

/** Remove the current session (reset/finish path). */
export function clearSession(): void {
  if (!currentId) return;
  removeSession(currentId);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function routeFromHash(hash: string): Route {
  const name = hash.replace(/^#\/?/, "").split("?")[0];
  return (ROUTES as string[]).includes(name) ? (name as Route) : "home";
}
