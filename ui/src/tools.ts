/* Tool registry: every sub-app declared once — id, route, label, kind,
 * icon, blurb, and its root render function. Shell concerns (tool nav,
 * titles, route dispatch, session ownership) derive from this instead of
 * being hand-maintained per tool.
 *
 * Kinds are explicit: `pipeline` tools run stateful jobs with sessions
 * (open/resume/close/reset); `utility` tools are stateless screens that
 * may still run transient background jobs but never own sessions. */

import { renderIngestion } from "./ingestion/view.js";
import { renderUpgrader } from "./views.js";
import { renderCleaner } from "./cleaner/view.js";
import { renderAudit } from "./audit/view.js";
import { renderCompare } from "./compare/view.js";
import type { Route, ToolId } from "./store.js";

export type ToolKind = "pipeline" | "utility";

export interface ToolDef {
  id: ToolId;
  route: Route;
  label: string;
  kind: ToolKind;
  /** Inner SVG markup (16x16 viewBox, currentColor strokes). */
  icon: string;
  blurb: string;
  render: (el: HTMLElement) => void;
}

export const TOOLS: ToolDef[] = [
  {
    id: "upgrader",
    route: "upgrader",
    label: "Quality Upgrader",
    kind: "pipeline",
    icon: `<path d="M9 3v10L1.5 8.5 9 4zM12 8l2-1.5V9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    blurb:
      "Fingerprint a folder or playlist, download lossless replacements, review each pair yourself.",
    render: renderUpgrader,
  },
  {
    id: "cleaner",
    route: "cleaner",
    label: "Library Cleaner",
    kind: "pipeline",
    icon: `<path d="M2 14h12M5 14V8.5l3-2M11 14V8.5l-3-2M8 6.5V3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>`,
    blurb:
      "Consolidate a Rekordbox collection, dedupe, rewrite paths in XML or master.db.",
    render: renderCleaner,
  },
  {
    id: "ingestion",
    route: "ingestion",
    label: "Ingestion Hub",
    kind: "pipeline",
    icon: `<path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
    blurb:
      "Drop loose tracks, dedupe against the library, export a clean playlist and XML.",
    render: renderIngestion,
  },
  {
    id: "compare",
    route: "compare",
    label: "Playlist Compare",
    kind: "utility",
    icon: `<path d="M2 5.5h9M8.5 3l2.5 2.5-2.5 2.5M14 10.5H5M7.5 8l-2.5 2.5 2.5 2.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    blurb:
      "Two playlists side by side: shared tracks, and what each side has that the other doesn't.",
    render: renderCompare,
  },
  {
    id: "audit",
    route: "audit",
    label: "Library Audit",
    kind: "pipeline",
    icon: `<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
    blurb:
      "Prove the library folder holds exactly what Rekordbox references — leftovers, stray hardlinks, stragglers.",
    render: renderAudit,
  },
];

export function toolById(id: ToolId): ToolDef | null {
  return TOOLS.find((t) => t.id === id) ?? null;
}

export function toolByRoute(route: Route): ToolDef | null {
  return TOOLS.find((t) => t.route === route) ?? null;
}

export function routeForTool(id: ToolId): Route {
  return toolById(id)?.route ?? "home";
}

export function pipelineTools(): ToolDef[] {
  return TOOLS.filter((t) => t.kind === "pipeline");
}
