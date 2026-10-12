/* App entry: hash router + shell chrome. No workflow logic. */

import { convertFileSrc, isTauri, resetSession } from "./api.js";
import { clearChrome } from "./chrome.js";
import { teardownReview } from "./upgrader/review.js";
import {
  closeSession,
  enterSession,
  getCurrentId,
  getSession,
  getSessionById,
  getTheme,
  listSessions,
  removeSession,
  routeFromHash,
  setTheme,
  subscribe,
  type Route,
} from "./store.js";
import {
  renderHome,
  renderSettings,
} from "./views.js";
import { requestUpgraderResume, resetUpgraderView } from "./upgrader/view.js";
import { requestCleanerResume, resetCleanerView } from "./cleaner/view.js";
import { removeCleanerRun } from "./cleaner/settings.js";
import { requestIngestionResume, resetIngestionView } from "./ingestion/view.js";
import { removeIngestionRun } from "./ingestion/settings.js";
import { requestAuditResume, resetAuditView } from "./audit/view.js";
import { removeAuditRun } from "./audit/settings.js";
import { routeForTool, toolByRoute, TOOLS } from "./tools.js";

const TITLES = {
  home: "Home",
  settings: "Settings",
} as Record<Route, string>;
for (const t of TOOLS) TITLES[t.route] = t.label;

function currentRoute(): Route {
  return routeFromHash(window.location.hash);
}

function renderNav(route: Route): void {
  // Blue = what you are inside. An open session owns the highlight for its
  // tool; the tool nav only lights up when on its fresh launcher.
  const open = getSession();
  document.querySelectorAll<HTMLAnchorElement>("[data-route]").forEach((a) => {
    const lit = a.dataset.route === route && (!open || open.tool !== a.dataset.route);
    a.classList.toggle("active", lit);
    if (lit) a.classList.add("on");
    else a.classList.remove("on");
  });
  const crumb = document.getElementById("crumb");
  if (crumb) crumb.textContent = TITLES[route];
}

function renderToolNav(): void {
  const nav = document.getElementById("nav");
  if (!nav) return;
  nav.insertAdjacentHTML(
    "beforeend",
    TOOLS.map(
      (t) =>
        `<a class="nv" href="#/${t.route}" data-route="${t.route}"><span class="ic"><svg viewBox="0 0 16 16">${t.icon}</svg></span><span>${t.label}</span></a>`,
    ).join(""),
  );
}

function renderSession(): void {
  const el = document.getElementById("session-status");
  if (!el) return;
  const s = getSession();
  el.textContent = s?.rootPath ?? s?.playlistName ?? "No active session";
  el.title = s?.rootPath ?? s?.playlistName ?? "";

  const list = document.getElementById("sources-list");
  const head = document.getElementById("sources-head");
  if (list && head) {
    head.textContent = "Sessions";
    const all = listSessions();
    if (all.length === 0) {
      list.innerHTML = `<div class="nv dim"><span>No active session</span></div>`;
      return;
    }
    const cur = getCurrentId();
    list.innerHTML = all
      .map((sess) => {
        const sub = sess.progressLabel ?? (sess.rootPath ? sessionBasename(sess.rootPath) : sess.tool);
        const info = `${sess.name} · ${sub} · ${sess.tool}`;
        const isOpen = sess.id === cur;
        const chip = isOpen
          ? `<span class="c">live</span>`
          : sess.status === "done"
            ? `<span class="c">done</span>`
            : "";
        const action = isOpen
          ? `<button class="x" data-close-session="${sess.id}" title="Close session (keeps it)">×</button>`
          : sess.status === "done"
            ? `<button class="x" data-delete-session="${sess.id}" title="Delete session and its files">×</button>`
            : "";
        return `<a class="nv${isOpen ? " on" : ""}" href="#/${routeForTool(sess.tool)}" data-enter-session="${sess.id}"><span class="ic"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg></span><span class="tx"><span title="${escapeAttr(info)}">${escapeHtml(
          sess.name,
        )}</span><span class="sub">${escapeHtml(sub)}</span></span>${chip}${action}</a>`;
      })
      .join("");
  }
}

function sessionBasename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function renderBridge(): void {
  const dot = document.getElementById("bridge-dot");
  const label = document.getElementById("bridge-label");
  const ok = isTauri();
  if (dot) {
    dot.classList.toggle("ok", ok);
    dot.classList.toggle("bad", !ok);
  }
  if (label) label.textContent = ok ? "Tauri connected" : "No Tauri bridge";
}

function renderTheme(): void {
  const theme = getTheme();
  document.documentElement.dataset.theme = theme;
  const light = document.getElementById("theme-light");
  const dark = document.getElementById("theme-dark");
  if (light) light.classList.toggle("on", theme === "light");
  if (dark) dark.classList.toggle("on", theme === "dark");
}

function renderRoute(): void {
  const route = currentRoute();
  const view = document.getElementById("view");
  if (!view) return;
  if (route !== "upgrader") teardownReview();
  renderNav(route);
  renderSession();
  switch (route) {
    case "home":
      clearChrome();
      renderHome(view);
      break;
    case "settings":
      clearChrome();
      renderSettings(view);
      break;
    default: {
      const tool = toolByRoute(route);
      if (tool) tool.render(view);
      else {
        clearChrome();
        renderHome(view);
      }
      break;
    }
  }
}

export function audioSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return `asset://${path}`;
  }
}

window.addEventListener("hashchange", renderRoute);
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  // Close button on the open session row: keep the session, leave it.
  const closer = t.closest?.("[data-close-session]");
  if (closer) {
    e.preventDefault();
    e.stopPropagation();
    const id = closer.getAttribute("data-close-session");
    const sess = id ? getSessionById(id) : null;
    closeSession();
    if (sess && currentRoute() === sess.tool) {
      if (sess.tool === "upgrader") resetUpgraderView();
      else if (sess.tool === "cleaner") resetCleanerView();
      else if (sess.tool === "ingestion") resetIngestionView();
      else if (sess.tool === "audit") resetAuditView();
      renderRoute();
    }
    return;
  };
  // Delete button on a done session row: removes it from the sidebar
  // AND deletes its files (same as Reset). Originals are untouched.
  // Cleaner/ingestion/audit sessions are the exception: user outputs live
  // outside the session, so only the session record is removed.
  const del = t.closest?.("[data-delete-session]");
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    const id = del.getAttribute("data-delete-session");
    const sess = id ? getSessionById(id) : null;
    if (!sess) return;
    void (async () => {
      const keepFiles =
        sess.tool === "cleaner" || sess.tool === "ingestion" || sess.tool === "audit";
      const keptWhat =
        sess.tool === "ingestion"
          ? "The destination folder and playlist XML are kept"
          : sess.tool === "audit"
            ? "Audited folders are untouched"
            : "The destination folder and database are kept";
      let confirmed = true;
      try {
        const { showConfirmDialog } = await import("./api.js");
        confirmed = keepFiles
          ? await showConfirmDialog(
              `Remove ${sess.tool} session?`,
              `Remove "${sess.name}" from the sidebar? ${keptWhat} — only the session record is removed.`,
            )
          : await showConfirmDialog(
              "Delete session?",
              `Remove "${sess.name}" from the sidebar and delete its progress, staged files and logs? Originals are untouched.`,
            );
      } catch {
        confirmed = window.confirm(
          keepFiles
            ? `Remove ${sess.tool} session "${sess.name}"? ${keptWhat}.`
            : `Delete session "${sess.name}" and its files? Originals are untouched.`,
        );
      }
      if (!confirmed) return;
      try {
        if (!keepFiles && sess.rootPath) await resetSession(sess.rootPath, sess.isSessionDir);
      } catch (err) {
        console.error("Session file cleanup failed:", err);
      }
      if (sess.tool === "cleaner") removeCleanerRun(sess.id);
      else if (sess.tool === "ingestion") removeIngestionRun(sess.id);
      else if (sess.tool === "audit") removeAuditRun(sess.id);
      removeSession(sess.id);
      if (currentRoute() === routeForTool(sess.tool)) {
        if (sess.tool === "upgrader") resetUpgraderView();
        else if (sess.tool === "cleaner") resetCleanerView();
        else if (sess.tool === "ingestion") resetIngestionView();
        else if (sess.tool === "audit") resetAuditView();
        renderRoute();
      }
    })();
    return;
  }
  // Sidebar session row: enter it and restore its workspace.
  const enter = t.closest?.("[data-enter-session]");
  if (enter) {
    e.preventDefault();
    const id = enter.getAttribute("data-enter-session");
    const sess = id ? getSessionById(id) : null;
    if (!sess || !enterSession(sess.id)) return;
    const dest = routeForTool(sess.tool);
    if (sess.tool === "upgrader") requestUpgraderResume();
    else if (sess.tool === "cleaner") requestCleanerResume();
    else if (sess.tool === "ingestion") requestIngestionResume();
    else if (sess.tool === "audit") requestAuditResume();
    if (currentRoute() === dest) renderRoute();
    else window.location.hash = `#/${dest}`;
    return;
  }
  // Tool nav while its own session is open: close it and land fresh.
  // Closing never destroys work — the session stays in the sidebar.
  // Repaint explicitly: when already on that route the hash doesn't
  // change, so no hashchange fires and the stale screen would linger.
  const nav = t.closest?.('a[data-route]');
  if (nav) {
    const route = nav.getAttribute("data-route");
    const cur = getSession();
    if (cur && cur.tool === route) {
      e.preventDefault();
      closeSession();
      if (route === "upgrader") resetUpgraderView();
      else if (route === "cleaner") resetCleanerView();
      else if (route === "ingestion") resetIngestionView();
      else if (route === "audit") resetAuditView();
      renderRoute();
    }
  }
});
subscribe(() => {
  renderSession();
  renderTheme();
  renderNav(currentRoute());
});

document.getElementById("theme-light")?.addEventListener("click", () => setTheme("light"));
document.getElementById("theme-dark")?.addEventListener("click", () => setTheme("dark"));

if (!window.location.hash) window.location.hash = "#/home";
renderToolNav();
renderTheme();
renderBridge();
renderRoute();