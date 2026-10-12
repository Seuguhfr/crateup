/* Shell chrome: job stage strip + command dock + right inspector.
   Workflow modules render these on every paint so the user always
   knows where they are in a job and where the next action lives. */

export type StageState = "done" | "active" | "future";

export interface StageSeg {
  label: string;
  state: StageState;
}

export interface DockAction {
  id: string;
  label: string;
  variant?: "primary" | "ghost" | "danger" | "danger-ghost";
  disabled?: boolean;
  onClick?: () => void;
}

export function renderStage(segs: StageSeg[]): void {
  const el = document.getElementById("stage-strip");
  const wrap = document.getElementById("stage-wrap");
  if (!el || !wrap) return;
  wrap.classList.remove("hidden");
  el.classList.remove("hidden");
  el.innerHTML = segs
    .map(
      (s, i) =>
        `<span class="stage-seg ${s.state}" data-i="${i}" data-tauri-drag-region>${s.label}</span>${
          i < segs.length - 1 ? `<span class="stage-sep" data-tauri-drag-region></span>` : ""
        }`,
    )
    .join("");
}

export function renderDock(note: string, actions: DockAction[]): void {
  const dock = document.getElementById("dock");
  if (!dock) return;
  const noteEl = dock.querySelector<HTMLElement>("#dock-note");
  const actionsEl = dock.querySelector<HTMLElement>("#dock-actions");
  if (noteEl) noteEl.textContent = note;
  if (actionsEl) {
    actionsEl.innerHTML = "";
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = `btn ${a.variant ?? "primary"}`;
      btn.id = a.id;
      btn.textContent = a.label;
      if (a.disabled) btn.disabled = true;
      if (a.onClick) btn.addEventListener("click", a.onClick);
      actionsEl.appendChild(btn);
    }
  }
  dock.classList.remove("hidden");
}

/** Replace the right inspector body with contextual HTML. */
export function renderInspector(html: string): void {
  const body = document.getElementById("insp-body");
  const foot = document.getElementById("insp-foot");
  if (!body) return;
  body.innerHTML = html;
  if (foot) foot.classList.add("hidden");
}

/** Replace the inspector footer (below the scroll body) with HTML + actions.
 *  Passing "" clears the footer back to hidden. */
export function renderInspectorFoot(html: string): void {
  const foot = document.getElementById("insp-foot");
  if (!foot) return;
  if (!html) {
    foot.classList.add("hidden");
    foot.innerHTML = "";
    return;
  }
  foot.innerHTML = html;
  foot.classList.remove("hidden");
}

export function clearChrome(): void {
  document.getElementById("stage-strip")?.classList.add("hidden");
  document.getElementById("stage-wrap")?.classList.add("hidden");
  document.getElementById("dock")?.classList.add("hidden");
  renderInspector(
    `<div class="empty">Welcome.<br /><span class="sub">Context opens here while you work.</span></div>`,
  );
  renderInspectorFoot("");
}

/* upgrader job arc: used to place the current screen on the strip. */

export const UPGRADER_STAGES = ["Source", "Run", "Review", "Commit"];

export function renderUpgraderStage(activeIndex: number): void {
  renderStage(
    UPGRADER_STAGES.map((label, i) => ({
      label,
      state: (i < activeIndex
        ? "done"
        : i === activeIndex
          ? "active"
          : "future") as StageState,
    })),
  );
}