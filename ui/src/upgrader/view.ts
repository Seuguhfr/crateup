/* Upgrader route state machine: source → configure → running → done → review.
   Re-rendering #/upgrader mid-run restores the running screen. */

import { countLedger, type Ledger } from "./utils.js";
import { renderSourceScreen, resolveFileListSession, type SourceResolution } from "./source.js";
import { leaveReview, renderReviewScreen } from "./review.js";
import { checkFileExists, readLedgerFile } from "../api.js";
import { closeSession, getSession, openSession } from "../store.js";
import {
  beginRun,
  isRunActive,
  readConfigureForm,
  renderConfigure,
  renderDone,
  renderRunning,
  resetUpgraderSession,
  type RunResult,
} from "./run.js";

type Screen =
  | { name: "source" }
  | { name: "configure"; res: SourceResolution; notice: string | null }
  | { name: "running"; res: SourceResolution }
  | { name: "done"; res: SourceResolution; result: RunResult }
  | { name: "review"; res: SourceResolution };

let screen: Screen = { name: "source" };

// Snapshot of the done screen (res + result) so "Back to results" from
// review can restore it exactly.
let doneSnapshot: { res: SourceResolution; result: RunResult } | null = null;

// Set when the user clicks the session entry in the sidebar (or any other
// resume affordance) so the upgrader restores the stored session instead
// of showing whatever screen happens to be current.
let resumeRequested = false;

export function requestUpgraderResume(): void {
  resumeRequested = true;
}

async function resumeStoredSession(el: HTMLElement): Promise<boolean> {
  const s = getSession();
  if (!s || !s.rootPath || !s.ledgerPath) return false;
  let ledger: Ledger | null = null;
  try {
    if (!(await checkFileExists(s.ledgerPath))) return false;
    ledger = JSON.parse(await readLedgerFile(s.ledgerPath)) as Ledger;
  } catch (err) {
    console.error("Failed to resume stored session:", err);
    return false;
  }
  enterConfigure(el, {
    rootPath: s.rootPath,
    ledgerPath: s.ledgerPath,
    fileList: null,
    playlistName: s.playlistName,
    sourceKind: s.sourceKind ?? "folder",
    isSessionDir: s.isSessionDir,
    existing: ledger,
    xmlPath: s.xmlPath ?? null,
  }, null);
  return true;
}

function show(el: HTMLElement, next: Screen): void {
  if (screen.name === "review" && next.name !== "review") leaveReview();
  screen = next;
  paint(el);
}

/** Close the open session (kept in the sidebar) and land on the fresh launcher. */
function closeAndLandFresh(el: HTMLElement): void {
  closeSession();
  doneSnapshot = null;
  show(el, { name: "source" });
}

/** Drop all upgrader screen state back to the fresh launcher. */
export function resetUpgraderView(): void {
  leaveReview();
  doneSnapshot = null;
  resumeRequested = false;
  screen = { name: "source" };
}

function paint(el: HTMLElement): void {
  const current = screen;
  switch (current.name) {
    case "source":
      renderSourceScreen(
        el,
        (res) => enterConfigure(el, res, null),
        (message) => enterConfigureError(el, message),
      );
      break;
    case "configure":
      renderConfigure(el, current.res, current.notice, {
        onStart: () => {
          const form = readConfigureForm(el);
          show(el, { name: "running", res: current.res });
          void beginRun(el, current.res, form, (result) =>
            show(el, { name: "done", res: current.res, result }),
          );
        },
        onBack: () => show(el, { name: "source" }),
        onClose: () => closeAndLandFresh(el),
        onReset: () =>
          void resetUpgraderSession(
            current.res,
            () => show(el, { name: "source" }),
            (message) =>
              show(el, {
                name: "configure",
                res: current.res,
                notice: message,
              }),
          ),
      });
      break;
    case "running":
      renderRunning(el);
      break;
    case "done":
      renderDone(el, current.res, current.result, {
        onBackToConfigure: () =>
          show(el, { name: "configure", res: current.res, notice: null }),
        onClose: () => closeAndLandFresh(el),
        onReset: () =>
          void resetUpgraderSession(
            current.res,
            () => show(el, { name: "source" }),
            () =>
              show(el, {
                name: "done",
                res: current.res,
                result: current.result,
              }),
          ),
        onReview: () => {
          doneSnapshot = { res: current.res, result: current.result };
          show(el, { name: "review", res: current.res });
        },
      });
      break;
    case "review":
      renderReviewScreen(el, current.res, {
        onBack: () => {
          if (doneSnapshot) {
            show(el, {
              name: "done",
              res: doneSnapshot.res,
              result: doneSnapshot.result,
            });
          } else {
            show(el, { name: "source" });
          }
        },
        onClose: () => closeAndLandFresh(el),
        onFinish: () => {
          doneSnapshot = null;
          show(el, { name: "source" });
        },
      });
      break;
  }
}

function enterConfigure(el: HTMLElement, res: SourceResolution, notice: string | null): void {
  const counts = res.existing ? countLedger(res.existing) : null;
  if (counts && counts.total > 0 && counts.pending === 0) {
    // Resumed session with nothing left to do — straight to summary.
    show(el, {
      name: "done",
      res,
      result: {
        exitCode: 0,
        ledger: res.existing,
        counts,
        alreadyComplete: true,
        error: null,
      },
    });
    return;
  }
  show(el, { name: "configure", res, notice });
}

function enterConfigureError(el: HTMLElement, message: string): void {
  const current = screen;
  if (current.name === "configure") {
    show(el, { name: "configure", res: current.res, notice: message });
    return;
  }
  // Source screen has no notice slot of its own beyond the error line;
  // surface it via a transient configure-less alert is worse than inline,
  // so re-render source and show the message in the error box.
  show(el, { name: "source" });
  const box = el.querySelector("#ug-source-error");
  if (box) {
    box.textContent = message;
    box.classList.remove("hidden");
  }
}

/** Open an upgrader session for an explicit file list handed over from
 *  another tool (e.g. Playlist Compare). Opens (or resumes) the session
 *  and lands on configure. Returns false when nothing could be opened. */
export async function startFileListSession(
  el: HTMLElement,
  name: string,
  paths: string[],
): Promise<boolean> {
  if (!paths || paths.length === 0) return false;
  let res: SourceResolution;
  try {
    res = await resolveFileListSession(name, paths);
  } catch (err) {
    console.error("Failed to open file-list session:", err);
    enterConfigureError(
      el,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
  openSession({
    tool: "upgrader",
    rootPath: res.rootPath,
    playlistName: res.playlistName,
    ledgerPath: res.ledgerPath,
    sourceKind: res.sourceKind,
    isSessionDir: res.isSessionDir,
    outputFormat: res.existing?.output_format ?? null,
    xmlPath: res.xmlPath ?? null,
  });
  enterConfigure(el, res, null);
  return true;
}

export function renderUpgraderView(el: HTMLElement): void {
  // Launcher is always fresh: without an open upgrader session there is
  // no screen state to restore.
  const open = getSession();
  if (!open || open.tool !== "upgrader") {
    if (screen.name !== "source") resetUpgraderView();
  }
  // Coming back to the route while a run is live: restore the live view.
  if (isRunActive() && screen.name !== "running") {
    const current = screen;
    if (current.name === "configure" || current.name === "done") {
      screen = { name: "running", res: current.res };
    }
  }
  if (resumeRequested) {
    resumeRequested = false;
    if (!isRunActive()) {
      const s = getSession();
      const cur = screen;
      const curRes = cur.name === "source" ? null : cur.res;
      const same =
        !!s &&
        !!s.rootPath &&
        !!s.ledgerPath &&
        !!curRes &&
        curRes.rootPath === s.rootPath &&
        curRes.ledgerPath === s.ledgerPath;
      if (!same) {
        // Async rebuild from the stored ledger; keep the current paint
        // until it resolves.
        void resumeStoredSession(el).then((ok) => {
          if (!ok) paint(el);
        });
        return;
      }
    }
  }
  paint(el);
}
