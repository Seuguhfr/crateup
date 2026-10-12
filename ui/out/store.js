/* App store: route + theme + session list. No framework, pub/sub only.
 *
 * Sessions are first-class objects: each folder/playlist pick opens (or
 * resumes) a session owned by one tool. Closing a session keeps it in the
 * list; resetting deletes its files AND removes it from the list. */
export const ROUTES = [
    "home",
    "upgrader",
    "cleaner",
    "ingestion",
    "compare",
    "settings",
    "audit",
];
let sessions = [];
let currentId = null;
const listeners = new Set();
const THEME_KEY = "crateup_theme";
const SESSIONS_KEY = "crateup_sessions_v1";
const LEGACY_SESSION_KEY = "crateup_session";
export function sessionBasename(p) {
    return p.replace(/\/+$/, "").split("/").pop() ?? p;
}
function makeSessionId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
/** Identity of a source: folders by root path, session dirs by ledger path
 *  (XML timestamped dirs are unique per pick; db playlist dirs are stable). */
export function sourceKeyFor(tool, opts) {
    const key = opts.isSessionDir
        ? (opts.ledgerPath ?? opts.rootPath ?? "")
        : (opts.rootPath ?? opts.ledgerPath ?? "");
    return `${tool}:${key}`;
}
function deriveSessionName(playlistName, rootPath) {
    if (playlistName)
        return playlistName;
    if (rootPath)
        return sessionBasename(rootPath);
    return "Session";
}
function findBySource(tool, opts) {
    const key = sourceKeyFor(tool, opts);
    return (sessions.find((s) => sourceKeyFor(s.tool, {
        rootPath: s.rootPath,
        ledgerPath: s.ledgerPath,
        isSessionDir: s.isSessionDir,
    }) === key) ?? null);
}
function notify() {
    listeners.forEach((fn) => fn());
}
function persistSessions() {
    try {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify({ sessions, currentId }));
    }
    catch {
        // quota/unavailable — in-memory sessions still work for this run
    }
}
function hydrateSessions() {
    try {
        const raw = localStorage.getItem(SESSIONS_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
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
    }
    catch {
        // malformed — fall through to legacy migration / fresh start
    }
    migrateLegacySession();
}
function migrateLegacySession() {
    try {
        const raw = localStorage.getItem(LEGACY_SESSION_KEY);
        if (!raw)
            return;
        const saved = JSON.parse(raw);
        if (saved && typeof saved.rootPath === "string" && saved.rootPath) {
            const now = Date.now();
            const session = {
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
    }
    catch {
        // unreadable legacy session — start fresh
    }
}
hydrateSessions();
export function getTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark")
        return saved;
    return window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
}
export function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
    notify();
}
/** All sessions, most recently updated first. */
export function listSessions() {
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}
/** The currently open session, if any. */
export function getSession() {
    if (!currentId)
        return null;
    return sessions.find((s) => s.id === currentId) ?? null;
}
export function getSessionById(id) {
    return sessions.find((s) => s.id === id) ?? null;
}
export function getCurrentId() {
    return currentId;
}
/** Open a session for a picked source, resuming the existing one when the
 *  same source was already opened with the same tool. Makes it current. */
export function openSession(input) {
    const now = Date.now();
    const resumed = findBySource(input.tool, {
        rootPath: input.rootPath,
        ledgerPath: input.ledgerPath ?? null,
        isSessionDir: input.isSessionDir ?? false,
    });
    if (resumed) {
        resumed.name = deriveSessionName(input.playlistName ?? resumed.playlistName, input.rootPath ?? resumed.rootPath);
        if (input.rootPath)
            resumed.rootPath = input.rootPath;
        if (input.playlistName !== undefined)
            resumed.playlistName = input.playlistName ?? null;
        if (input.ledgerPath)
            resumed.ledgerPath = input.ledgerPath;
        if (input.sourceKind)
            resumed.sourceKind = input.sourceKind;
        resumed.isSessionDir = input.isSessionDir ?? resumed.isSessionDir;
        if (input.outputFormat !== undefined)
            resumed.outputFormat = input.outputFormat;
        resumed.updatedAt = now;
        currentId = resumed.id;
        persistSessions();
        notify();
        return { ...resumed };
    }
    const session = {
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
    };
    sessions.push(session);
    currentId = session.id;
    persistSessions();
    notify();
    return { ...session };
}
/** Enter an existing session (sidebar resume). Returns false when unknown. */
export function enterSession(id) {
    const found = sessions.find((s) => s.id === id);
    if (!found)
        return false;
    found.updatedAt = Date.now();
    currentId = id;
    persistSessions();
    notify();
    return true;
}
/** Close the current session: it stays in the list, work is kept. */
export function closeSession() {
    if (!currentId)
        return;
    currentId = null;
    persistSessions();
    notify();
}
/** Patch a session (progress, status, follow-ups). */
export function updateSession(id, patch) {
    const found = sessions.find((s) => s.id === id);
    if (!found)
        return;
    Object.assign(found, patch, { updatedAt: Date.now() });
    persistSessions();
    notify();
}
/** Patch the current session; no-op when none is open. */
export function setSession(patch) {
    if (!currentId)
        return;
    updateSession(currentId, patch);
}
/** Delete a session from the list (reset path — files are deleted separately
 *  by the caller before/after this). Clears current when it was open. */
export function removeSession(id) {
    sessions = sessions.filter((s) => s.id !== id);
    if (currentId === id)
        currentId = null;
    persistSessions();
    notify();
}
/** Remove the current session (reset/finish path). */
export function clearSession() {
    if (!currentId)
        return;
    removeSession(currentId);
}
export function subscribe(fn) {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
export function routeFromHash(hash) {
    const name = hash.replace(/^#\/?/, "").split("?")[0];
    return ROUTES.includes(name) ? name : "home";
}
