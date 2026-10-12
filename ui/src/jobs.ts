/* Jobs protocol: one progress/done/error envelope for every background
 * job in the native shell — pipeline runs, consolidation scans, acoustic
 * matching.
 *
 * Sources keep emitting their own Tauri events (`pipeline-log`,
 * `pipeline-done`, `compare-acoustic-progress`, `xml-scan-progress`,
 * `rebuilder-consolidation-progress`, `ingest-consolidation-progress`, …);
 * this module is the single place that subscribes to them, paints progress,
 * and cleans up. Consumers adapt their dialect here instead of hand-rolling listens. */

import { listen } from "./api.js";
import { esc } from "./upgrader/utils.js";

/** Canonical progress snapshot. Adapters translate each source dialect
 *  into this shape at the subscribe boundary. */
export interface JobProgress {
  jobId: string;
  label: string;
  processed: number;
  total: number;
}

export type JobOutcome =
  | { jobId: string; ok: true }
  | { jobId: string; ok: false; error: string };

/** 0..100, total<=0-safe. Pure — unit-tested. */
export function jobPercent(processed: number, total: number): number {
  if (!Number.isFinite(processed) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (processed / total) * 100));
}

/** Shared progress-block markup (uses .pbox/.pbar). Pure — unit-tested. */
export function jobProgressHtml(fillId: string, textId: string, label: string): string {
  return `<div class="sect">
    <h3>${esc(label)}</h3>
    <div class="pbox"><div class="pbar" id="${esc(fillId)}" style="width:0%"></div></div>
    <p class="muted small" id="${esc(textId)}">Starting…</p>
  </div>`;
}

/** Paint a rendered progress block by id. No-op when its nodes are gone
 *  (screen repainted mid-run). */
export function paintJobProgress(
  fillId: string,
  textId: string,
  processed: number,
  total: number,
  text?: string,
): void {
  const bar = document.getElementById(fillId);
  const txt = document.getElementById(textId);
  if (bar) bar.style.width = `${jobPercent(processed, total)}%`;
  if (txt) {
    txt.textContent =
      text ?? (total > 0 ? `${processed} / ${total}` : `${processed}`);
  }
}

/** Subscribe to a Tauri event. Resolves to a detach fn; rejects when the
 *  bridge is unavailable. */
export function watchJobEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  return listen<T>(event, handler);
}

/** Call every stored unlisten; tolerates nulls and double-calls. */
export function detachAll(...fns: Array<(() => void) | null | undefined>): void {
  for (const fn of fns) {
    try {
      fn?.();
    } catch {
      // already detached — ignore
    }
  }
}

/** Pipeline dialect adapter: `pipeline-log` lines + `pipeline-done` exit
 *  code behind one detach handle. Rejects when the bridge is unavailable. */
export async function watchPipelineRun(handlers: {
  onLog: (line: string) => void;
  onDone: (exitCode: number) => void;
}): Promise<() => void> {
  const fns: Array<() => void> = [];
  fns.push(await listen<{ line: string }>("pipeline-log", (p) => handlers.onLog(p.line)));
  fns.push(await listen<number>("pipeline-done", handlers.onDone));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    detachAll(...fns);
  };
}
