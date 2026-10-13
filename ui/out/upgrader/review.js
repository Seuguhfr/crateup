/* Upgrader review: deck-pair listening, similarity queue, decisions,
   and the commit phase. Reads the ledger fresh on every paint so a
   re-render mid-review (or a crash recovery) resumes exactly where
   the user left off. */
import { checkRekordboxStatus, commitChanges, convertFileSrc, downloadTrackById, getFileSize, identifyTrack, isTauri, readLedgerFile, resetSession, saveLedgerDecision, selectOutputDirectory, updateRekordboxDbDirectly, updateRekordboxXml, } from "../api.js";
import { clearSession, setSession } from "../store.js";
import { renderDock, renderInspector, renderUpgraderStage, } from "../chrome.js";
import { esc, fmtBytes, fmtTime, joinPath, isLosslessExt, } from "./utils.js";
/* ---------------- module state ---------------- */
const CATEGORY_ORDER = [
    "identical",
    "almost_identical",
    "close_enough",
    "potential_mismatch",
    "unresolved",
];
const CATEGORY_LABELS = {
    identical: "Identical Audio",
    almost_identical: "Almost Identical",
    close_enough: "Not Certain",
    potential_mismatch: "Potential Mismatch",
    unresolved: "Unresolved / No Upgrade",
};
const CATEGORY_ALLOW_APPROVE = {
    identical: true,
    almost_identical: true,
    close_enough: true,
    potential_mismatch: true,
    unresolved: false,
};
const PLAY_SVG = `<svg viewBox="0 0 8 8"><path d="M1 1l6 3-6 3z" fill="currentColor"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 8 8"><rect x="1" y="1" width="2.4" height="6" rx="0.6" fill="currentColor"/><rect x="4.6" y="1" width="2.4" height="6" rx="0.6" fill="currentColor"/></svg>`;
let active = false;
let res = null;
let cb = null;
let ledger = null;
let queue = [];
let currentIndex = -1;
let focus = "original";
let expanded = {
    identical: false,
    almost_identical: false,
    close_enough: false,
    potential_mismatch: false,
    unresolved: false,
};
let wsOrig = null;
let wsStaged = null;
const readyState = {
    original: { ready: false, decode: false },
    staged: { ready: false, decode: false },
};
let lockInterval = null;
let watchdogRetried = false;
let watchdogTimer = null;
let wavWarningShown = false;
let linkedScrub = false;
let isSyncingSeek = false;
let decisionHistory = [];
function waveSurfer() {
    const w = window.WaveSurfer;
    return w ?? null;
}
function isWs7() {
    const w = waveSurfer();
    return !!w && typeof w.VERSION === "string" && w.VERSION.startsWith("7");
}
/* ---------------- helpers ---------------- */
function id(selector) {
    return document.querySelector(`#view ${selector}`);
}
function filenameOf(relPath) {
    return relPath.split("/").pop() ?? relPath;
}
function getItemCategory(item) {
    const le = ledger?.files?.[item.relPath];
    if (!le)
        return "unresolved";
    const bit = item.bitIdentical ?? le.audio_bit_identical;
    const score = item.similarityScore ?? le.similarity_score;
    if (item.status === "downloaded") {
        if (bit)
            return "identical";
        if (typeof score === "number") {
            if (score >= 0.9)
                return "almost_identical";
            if (score >= 0.75)
                return "close_enough";
        }
        return "potential_mismatch";
    }
    return "unresolved";
}
function leFor(item) {
    return ledger?.files?.[item.relPath] ?? {};
}
function decide(item) {
    return leFor(item).decision ?? "pending";
}
function hasShazamMeta(item) {
    const le = leFor(item);
    const artist = le.artist;
    const title = le.title;
    return !!artist && !!title && artist !== "Unknown Artist" && title !== "Unknown Title";
}
function matchPct(item) {
    if (item.status !== "downloaded")
        return null;
    const le = leFor(item);
    const bit = item.bitIdentical ?? le.audio_bit_identical;
    if (bit)
        return 100;
    const sim = item.similarityScore ?? le.similarity_score;
    return typeof sim === "number" ? Math.round(sim * 100) : null;
}
function unresolvedReason(item) {
    switch (item.status) {
        case "unidentified":
            return "Shazam could not identify this track";
        case "not_on_deezer":
            return "Identified, but not available on Deezer";
        case "download_failed":
            return `Download failed — Deezer ID: ${item.deezerId ?? "Unknown"}`;
        default:
            return "No upgrade available";
    }
}
function whyText(item) {
    if (item.status !== "downloaded") {
        return `<b>${unresolvedReason(item)}</b>`;
    }
    const pct = matchPct(item);
    const bit = item.bitIdentical ?? leFor(item).audio_bit_identical;
    if (bit)
        return "Bit-for-bit identical audio. <b>100% match</b> — safe to approve.";
    if (typeof pct === "number" && pct >= 90) {
        return `Acoustic fingerprint matches at <b>${pct}%</b> — almost certainly the same mix.`;
    }
    if (typeof pct === "number" && pct >= 75) {
        return `<b>${pct}% match</b> — same energy, possibly a different master. Listen closely.`;
    }
    return typeof pct === "number"
        ? `<b>${pct}% match</b> — under 75%. Verify: this may be a different recording.`
        : "Similarity not computed for this pair.";
}
function statusBadge(item) {
    const pct = matchPct(item);
    if (pct !== null) {
        if (pct >= 100)
            return `<span class="sc">${pct}%</span>`;
        if (pct >= 90)
            return `<span class="sc">${pct}%</span>`;
        if (pct >= 75)
            return `<span class="sc w">${pct}%</span>`;
        return `<span class="sc b">${pct}%</span>`;
    }
    const d = decide(item);
    if (d === "approved")
        return `<span class="sc">✓</span>`;
    if (d === "skipped")
        return `<span class="sc n">–</span>`;
    return `<span class="sc n">…</span>`;
}
/* ---------------- screen ---------------- */
function headMetaHtml() {
    return `
    <div class="diff">
      <span class="why" id="rv-why">Loading…</span>
    </div>
    <div class="frow hidden" id="rv-refetch-row">
      <button class="btn sm" id="rv-identify">Identify</button>
      <input class="field" id="rv-deezer-id" placeholder="Deezer ID…" autocomplete="off" />
      <button class="btn sm" id="rv-refetch">Refetch</button>
      <span class="kb" id="rv-feedback"></span>
    </div>
    <div class="sect" style="padding:8px 14px">
      <h3>File comparison</h3>
      <div class="kvr"><span class="v" id="rv-o-file">–</span><span class="k">File</span><span class="v n" id="rv-s-file">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-size">–</span><span class="k">Size</span><span class="v n" id="rv-s-size">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-format">–</span><span class="k">Format</span><span class="v n" id="rv-s-format">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-bitrate">–</span><span class="k">Bitrate</span><span class="v n" id="rv-s-bitrate">–</span></div>
      <div class="kvr"><span class="v" id="rv-o-dur">–</span><span class="k">Time</span><span class="v n" id="rv-s-dur">–</span></div>
    </div>`;
}
function skeletonHtml(label) {
    const bars = Array.from({ length: 25 }, () => "<span></span>").join("");
    return `<div class="wave-skeleton">${bars}</div><div>${esc(label)}</div>`;
}
function deckHtml(deck) {
    const orig = deck === "original";
    const cls = orig ? "dorig" : "dnew";
    const rbp = orig ? "Original" : "Upgrade";
    return `
    <div class="deck ${cls}" id="deck-${deck}">
      <div class="dh">
        <button class="play" id="play-${deck}" disabled title="Play / pause (Space)">${PLAY_SVG}</button>
        <span class="nm" id="rv-${deck[0]}-name">${orig ? "Original track" : "No upgrade"}</span>
        <span class="rbp">${rbp}</span>
        <span class="dur" id="rv-${deck[0]}-time">00:00</span>
      </div>
      <div class="wav" id="wave-${deck}">
        <div class="loading" id="rv-${deck[0]}-load">${orig ? skeletonHtml("Loading original audio…") : ""}</div>
      </div>
      <div class="tr">
        <span class="fl" id="rv-${deck[0]}-fmt">—</span>
        <span class="time" id="rv-${deck[0]}-dur2">--:--</span>
      </div>
    </div>`;
}
function workspaceHtml() {
    return `
    <div class="cv">
      ${deckHtml("original")}
      ${deckHtml("staged")}
      ${headMetaHtml()}
      <div class="rev-foot">
        <span class="kb">Review keys · <kbd>Space</kbd> play &nbsp;<kbd>↵</kbd> approve &nbsp;<kbd>⌫</kbd> skip &nbsp;<kbd>Z</kbd> undo</span>
        <span class="kb">
          <kbd>←→</kbd> scrub &nbsp;<kbd>↑↓</kbd> deck &nbsp;
          <button class="link-btn" id="rv-toggle-link" title="Toggle synchronized scrub between decks (L)"><kbd>L</kbd> Link</button>
          <button class="help-btn" id="rv-help" title="Keyboard shortcuts (?)">?</button>
        </span>
        <span class="kb" id="rv-reviewed">—</span>
      </div>
    </div>`;
}
function queueGroupHtml(cat) {
    const isOpen = expanded[cat];
    const items = queue
        .map((item, idx) => ({ item, idx, cat: getItemCategory(item) }))
        .filter((g) => g.cat === cat);
    if (items.length === 0)
        return "";
    const total = items.length;
    const done = items.filter(({ item }) => decide(item) !== "pending").length;
    const hasPending = done < total;
    const allowApprove = CATEGORY_ALLOW_APPROVE[cat];
    const acts = hasPending
        ? `<div class="qg-acts">
        ${allowApprove ? `<button class="btn iv" data-batch="approve" data-cat="${cat}">Approve remaining</button>` : ""}
        <button class="btn iv" data-batch="skip" data-cat="${cat}">${allowApprove ? "Skip remaining" : "Keep remaining"}</button>
       </div>`
        : "";
    const rows = items
        .map(({ item, idx }) => {
        const name = esc(filenameOf(item.relPath));
        const badge = statusBadge(item);
        return `<div class="qr ${idx === currentIndex ? "on" : ""}" data-idx="${idx}" title="${esc(item.relPath)}">
        <span class="tt">${name}</span>${badge}
      </div>`;
    })
        .join("");
    return `<div class="qg ${isOpen ? "open" : ""}" data-cat="${cat}">
    <button><span class="tri">▶</span><span class="tt">${CATEGORY_LABELS[cat]}</span><span class="cnt">${done}/${total}</span></button>
    ${isOpen ? `<div class="qrows">${acts}${rows}</div>` : ""}
  </div>`;
}
function renderQueue() {
    const body = document.getElementById("insp-body");
    if (!body)
        return;
    body.innerHTML =
        `<div class="isec">
       <h4>Review queue</h4>
       <p class="muted small" id="rv-qhead">${queue.length} tracks · ${countReviewed()} reviewed</p>
     </div>` +
            CATEGORY_ORDER.map(queueGroupHtml).join("");
    bindQueue(body);
}
function updateQueueRow(index) {
    const item = queue[index];
    if (!item)
        return;
    const row = document.querySelector(`#insp-body .qr[data-idx="${index}"]`);
    if (row) {
        const badge = statusBadge(item);
        const existingBadge = row.querySelector(".sc");
        if (existingBadge) {
            existingBadge.outerHTML = badge;
        }
        else {
            row.insertAdjacentHTML("beforeend", badge);
        }
    }
    const cat = getItemCategory(item);
    const catGroup = document.querySelector(`#insp-body .qg[data-cat="${cat}"]`);
    if (catGroup) {
        const catItems = queue.filter((i) => getItemCategory(i) === cat);
        const total = catItems.length;
        const done = catItems.filter((i) => decide(i) !== "pending").length;
        const cnt = catGroup.querySelector(".cnt");
        if (cnt)
            cnt.textContent = `${done}/${total}`;
        if (done >= total) {
            catGroup.querySelector(".qg-acts")?.remove();
        }
    }
}
function countReviewed() {
    return queue.filter((item) => decide(item) !== "pending").length;
}
function bindQueue(body) {
    body.querySelectorAll("[data-cat] > button").forEach((btn) => {
        const group = btn.parentElement;
        if (!group)
            return;
        btn.addEventListener("click", () => {
            const cat = group.dataset.cat;
            const wasOpen = expanded[cat];
            Object.keys(expanded).forEach((k) => (expanded[k] = false));
            if (!wasOpen)
                expanded[cat] = true;
            renderQueue();
        });
    });
    body.querySelectorAll("[data-batch]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const cat = btn.dataset.cat;
            const kind = btn.dataset.batch;
            if (kind === "approve")
                clearCategory(cat, true);
            else
                clearCategory(cat, false);
        });
    });
    body.querySelectorAll(".qr").forEach((row) => {
        row.addEventListener("click", () => {
            const idx = parseInt(row.dataset.idx ?? "-1", 10);
            if (idx >= 0 && idx < queue.length)
                void loadTrack(idx);
        });
    });
}
function refreshDock() {
    const total = queue.length;
    const reviewed = countReviewed();
    const allDone = total > 0 && reviewed === total;
    setSession({
        progressLabel: total > 0 ? `${reviewed}/${total} reviewed` : null,
    });
    renderDock(allDone
        ? `All ${total} tracks reviewed — ready to apply changes.`
        : `${reviewed} of ${total} reviewed`, [
        {
            id: "rv-back",
            label: "Back to results",
            variant: "ghost",
            onClick: () => {
                leaveReview();
                cb?.onBack();
            },
        },
        {
            id: "rv-reset",
            label: "Reset session",
            variant: "danger-ghost",
            onClick: () => void onReset(),
        },
        {
            id: "rv-close",
            label: "Close session",
            variant: "ghost",
            onClick: () => {
                leaveReview();
                cb?.onClose();
            },
        },
        {
            id: "rv-apply",
            label: "Apply All Changes",
            variant: "primary",
            disabled: !allDone,
            onClick: () => openCommitModal(),
        },
    ]);
    const rv = id("#rv-reviewed");
    if (rv)
        rv.textContent = `${reviewed} / ${total} reviewed`;
    const qh = document.getElementById("rv-qhead");
    if (qh)
        qh.textContent = `${total} tracks · ${reviewed} reviewed`;
}
async function onReset() {
    if (!res)
        return;
    let confirmed = true;
    try {
        const { showConfirmDialog } = await import("../api.js");
        confirmed = await showConfirmDialog("Reset session?", "This deletes staged files and progress for this session. Originals are untouched.");
    }
    catch {
        confirmed = window.confirm("Reset this session? This deletes staging, ledger, and logs.");
    }
    if (!confirmed)
        return;
    await resetSession(res.rootPath, res.isSessionDir);
    clearSession();
    leaveReview();
    cb?.onFinish();
}
/* ---------------- read ledger + boot ---------------- */
async function readLedgerAndBoot() {
    if (!res)
        return;
    try {
        ledger = JSON.parse(await readLedgerFile(res.ledgerPath));
    }
    catch (err) {
        const body = document.getElementById("insp-body");
        if (body) {
            body.innerHTML = `<div class="empty">Ledger failed to load.<br /><span class="sub">${esc(String(err))}</span></div>`;
        }
        return;
    }
    queue = [];
    decisionHistory = [];
    const files = ledger.files ?? {};
    for (const relPath of Object.keys(files)) {
        const entry = files[relPath];
        const hasDecision = !!entry.decision && entry.decision !== "pending";
        if (entry.status !== "committed" &&
            entry.status !== "skipped" &&
            (["downloaded", "unidentified", "not_on_deezer", "download_failed"].includes(entry.status) || hasDecision)) {
            queue.push({
                relPath,
                status: entry.status,
                deezerId: entry.deezer_id,
                proxyPath: entry.proxy_path,
                bitIdentical: entry.audio_bit_identical,
                similarityScore: entry.similarity_score,
            });
        }
    }
    queue.forEach((item) => {
        if (!leFor(item).decision)
            leFor(item).decision = "pending";
    });
    if (queue.length === 0) {
        const body = document.getElementById("insp-body");
        if (body) {
            body.innerHTML = `<div class="empty">Nothing to review.<br /><span class="sub">No downloads, failures, or pending decisions remain.</span></div>`;
        }
        const why = id("#rv-why");
        if (why)
            why.innerHTML = "<b>No tracks available to review.</b>";
        refreshDock();
        return;
    }
    const firstUndecided = queue.findIndex((item) => decide(item) === "pending");
    currentIndex = firstUndecided >= 0 ? firstUndecided : 0;
    initWaveSurfers();
    renderQueue();
    refreshDock();
    await loadTrack(currentIndex);
    checkWavWarningModal();
}
function checkWavWarningModal() {
    if (wavWarningShown)
        return;
    if (ledger?.output_format?.toLowerCase() !== "wav")
        return;
    wavWarningShown = true;
    const root = document.createElement("div");
    root.className = "modal-backdrop show";
    root.id = "rv-wav-warning-modal";
    root.innerHTML = `
    <div class="modal" role="dialog" aria-label="WAV Format Warning" style="width:min(500px,92vw)">
      <div class="modal-title" style="color:var(--orange)">WAV Format Warning</div>
      <p class="muted small" style="margin:8px 0 16px;line-height:1.5">
        Warning: WAV files do not reliably support custom ID3 tags. Genre, rating, and comment fields may be dropped by your playback software. Consider using FLAC for lossless quality with full tag support.
      </p>
      <div class="modal-actions">
        <button class="btn primary" id="wav-warning-dismiss">I Understand</button>
      </div>
    </div>`;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.addEventListener("click", (e) => {
        const t = e.target;
        if (t === root || t.closest("#wav-warning-dismiss")) {
            close();
        }
    });
}
export function renderReviewScreen(el, source, callbacks) {
    leaveReview();
    res = source;
    cb = callbacks;
    active = true;
    el.className = "screen on";
    el.innerHTML = workspaceHtml();
    renderUpgraderStage(2);
    renderInspector(`<div class="empty">Reading session ledger…</div>`);
    refreshDock();
    bindDeckButtons(el);
    bindRefetchRow(el);
    bindReviewFooter(el);
    void readLedgerAndBoot();
}
export function leaveReview() {
    active = false;
    destroyPlayers();
    if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = null;
    }
    if (lockInterval !== null) {
        window.clearInterval(lockInterval);
        lockInterval = null;
    }
    document.getElementById("rv-wav-warning-modal")?.remove();
    removeAnyShortcutsModal();
    wavWarningShown = false;
    decisionHistory = [];
    res = null;
    cb = null;
    ledger = null;
    queue = [];
    currentIndex = -1;
    Object.keys(expanded).forEach((k) => (expanded[k] = false));
}
function bindReviewFooter(el) {
    el.querySelector("#rv-toggle-link")?.addEventListener("click", () => {
        toggleLinkedScrub();
    });
    el.querySelector("#rv-help")?.addEventListener("click", () => {
        openShortcutsModal();
    });
    updateLinkButtonState();
}
function toggleLinkedScrub() {
    linkedScrub = !linkedScrub;
    updateLinkButtonState();
}
function updateLinkButtonState() {
    const btn = id("#rv-toggle-link");
    if (!btn)
        return;
    btn.classList.toggle("on", linkedScrub);
    btn.setAttribute("aria-pressed", String(linkedScrub));
    btn.innerHTML = `<kbd>L</kbd> ${linkedScrub ? "Link: ON" : "Link"}`;
}
function openShortcutsModal() {
    if (document.getElementById("rv-shortcuts-modal")) {
        removeAnyShortcutsModal();
        return;
    }
    const root = document.createElement("div");
    root.className = "modal-backdrop show";
    root.id = "rv-shortcuts-modal";
    root.innerHTML = `
    <div class="modal" role="dialog" aria-label="Review Keyboard Shortcuts" style="width:min(460px,92vw)">
      <div class="modal-title" style="margin-bottom:12px">Review Shortcuts</div>
      <div class="shortcut-grid">
        <div class="sc-row"><span class="k">Play / Pause</span><span class="v"><kbd>Space</kbd></span></div>
        <div class="sc-row"><span class="k">Switch Deck Focus</span><span class="v"><kbd>↑</kbd> <kbd>↓</kbd></span></div>
        <div class="sc-row"><span class="k">Seek Audio</span><span class="v"><kbd>←</kbd> <kbd>→</kbd> <span class="muted small">(±5s)</span></span></div>
        <div class="sc-row"><span class="k">Fast Seek</span><span class="v"><kbd>⌘←</kbd> <kbd>⌘→</kbd> <span class="muted small">(±20s)</span></span></div>
        <div class="sc-row"><span class="k">Approve Replacement</span><span class="v"><kbd>↵</kbd> <span class="muted small">Enter</span></span></div>
        <div class="sc-row"><span class="k">Skip (Keep Original)</span><span class="v"><kbd>⌫</kbd> <span class="muted small">Backspace</span></span></div>
        <div class="sc-row"><span class="k">Undo Last Decision</span><span class="v"><kbd>Z</kbd> / <kbd>⌘Z</kbd></span></div>
        <div class="sc-row"><span class="k">Toggle Linked Scrub</span><span class="v"><kbd>L</kbd></span></div>
        <div class="sc-row"><span class="k">Shortcuts Help</span><span class="v"><kbd>?</kbd> / <kbd>h</kbd></span></div>
        <div class="sc-row"><span class="k">Dismiss Dialog</span><span class="v"><kbd>Esc</kbd></span></div>
      </div>
      <div class="modal-actions" style="margin-top:16px">
        <button class="btn primary" id="rv-shortcuts-close">Close</button>
      </div>
    </div>`;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.addEventListener("click", (e) => {
        const t = e.target;
        if (t === root || t.closest("#rv-shortcuts-close")) {
            close();
        }
    });
}
function removeAnyShortcutsModal() {
    document.getElementById("rv-shortcuts-modal")?.remove();
}
/** Safe teardown for route-level navigation (e.g. leaving the module). */
export function teardownReview() {
    if (!active)
        return false;
    leaveReview();
    return true;
}
function destroyPlayers() {
    if (wsOrig) {
        try {
            wsOrig.destroy();
        }
        catch { /* noop */ }
        wsOrig = null;
    }
    if (wsStaged) {
        try {
            wsStaged.destroy();
        }
        catch { /* noop */ }
        wsStaged = null;
    }
}
function bindDeckButtons(el) {
    const play = (deck) => {
        el.querySelector(`#play-${deck}`)?.addEventListener("click", () => {
            if (deck === "staged" && queue[currentIndex]?.status !== "downloaded")
                return;
            setFocus(deck);
            togglePlayPause();
        });
    };
    play("original");
    play("staged");
    const setPlayGlyph = (deck, playing) => {
        const btn = el.querySelector(`#play-${deck}`);
        if (btn)
            btn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    };
    window.__setPlayGlyph = setPlayGlyph;
}
/* ---------------- wavesurfer ---------------- */
function initWaveSurfers() {
    destroyPlayers();
    const w = waveSurfer();
    if (!w)
        return;
    const hasDecode = isWs7();
    wsOrig = w.create({
        container: "#wave-original",
        waveColor: "#8b6a45",
        progressColor: "#ff9500",
        cursorColor: "#ff9500",
        height: 80,
        responsive: true,
        backend: "WebAudio",
        dragToSeek: true,
    });
    wsStaged = w.create({
        container: "#wave-staged",
        waveColor: "#8b6a45",
        progressColor: "#34c759",
        cursorColor: "#34c759",
        height: 80,
        responsive: true,
        backend: "WebAudio",
        dragToSeek: true,
    });
    wsOrig.on("timeupdate", (time) => {
        const t = wsOrig?.getDuration() ?? 0;
        const h = id("#rv-o-dur2");
        if (h)
            h.textContent = `${fmtTime(time)} / ${fmtTime(t)}`;
        const ht = id("#rv-o-time");
        if (ht)
            ht.textContent = fmtTime(time);
    });
    wsOrig.on("ready", () => {
        const dur = wsOrig?.getDuration() ?? 0;
        const h = id("#rv-o-dur");
        if (h)
            h.textContent = fmtTime(dur);
        const h2 = id("#rv-o-dur2");
        if (h2)
            h2.textContent = `00:00 / ${fmtTime(dur)}`;
        readyState.original.ready = true;
        if (!hasDecode) {
            readyState.original.decode = true;
            window.setTimeout(() => checkUsable("original"), 150);
        }
        else {
            checkUsable("original");
        }
    });
    if (hasDecode) {
        wsOrig.on("decode", () => {
            readyState.original.decode = true;
            checkUsable("original");
        });
    }
    wsOrig.on("seek", () => {
        syncSeek(wsOrig, wsStaged, "staged");
    });
    wsOrig.on("play", () => setGlyph("original", true));
    wsOrig.on("pause", () => setGlyph("original", false));
    wsOrig.on("finish", () => setGlyph("original", false));
    wsOrig.on("error", (err) => {
        console.error("Original WaveSurfer error:", err);
        const lo = id("#rv-o-load");
        if (lo) {
            lo.classList.remove("hidden");
            lo.textContent = "Could not load this audio file.";
        }
    });
    wsStaged.on("timeupdate", (time) => {
        const tr = queue[currentIndex];
        if (!tr || tr.status !== "downloaded")
            return;
        const t = wsStaged?.getDuration() ?? 0;
        const h = id("#rv-s-dur2");
        if (h)
            h.textContent = `${fmtTime(time)} / ${fmtTime(t)}`;
        const ht = id("#rv-s-time");
        if (ht)
            ht.textContent = fmtTime(time);
    });
    wsStaged.on("ready", () => {
        const tr = queue[currentIndex];
        if (!tr || tr.status !== "downloaded")
            return;
        const dur = wsStaged?.getDuration() ?? 0;
        const h = id("#rv-s-dur");
        if (h)
            h.textContent = fmtTime(dur);
        const h2 = id("#rv-s-dur2");
        if (h2)
            h2.textContent = `00:00 / ${fmtTime(dur)}`;
        readyState.staged.ready = true;
        if (!hasDecode) {
            readyState.staged.decode = true;
            window.setTimeout(() => checkUsable("staged"), 150);
        }
        else {
            checkUsable("staged");
        }
    });
    if (hasDecode) {
        wsStaged.on("decode", () => {
            const tr = queue[currentIndex];
            if (!tr || tr.status !== "downloaded")
                return;
            readyState.staged.decode = true;
            checkUsable("staged");
        });
    }
    wsStaged.on("seek", () => {
        syncSeek(wsStaged, wsOrig, "original");
    });
    wsStaged.on("play", () => setGlyph("staged", true));
    wsStaged.on("pause", () => setGlyph("staged", false));
    wsStaged.on("finish", () => setGlyph("staged", false));
    wsStaged.on("error", (err) => console.error("Staged WaveSurfer error:", err));
}
function syncSeek(sourceWs, targetWs, targetDeck) {
    if (!linkedScrub || isSyncingSeek || !targetWs)
        return;
    if (!isUsable(targetDeck))
        return;
    const durSrc = sourceWs.getDuration();
    const durTgt = targetWs.getDuration();
    if (durSrc <= 0 || durTgt <= 0)
        return;
    const time = sourceWs.getCurrentTime();
    isSyncingSeek = true;
    try {
        targetWs.setTime(Math.max(0, Math.min(durTgt, time)));
    }
    catch {
        /* best effort */
    }
    finally {
        isSyncingSeek = false;
    }
}
function setGlyph(deck, playing) {
    const fn = window.__setPlayGlyph;
    fn?.(deck, playing);
}
function isUsable(deck) {
    return readyState[deck].ready && readyState[deck].decode;
}
function checkUsable(deck) {
    if (!isUsable(deck))
        return;
    const btn = id(`#play-${deck}`);
    const wav = id(`#wave-${deck}`);
    if (deck === "staged" && queue[currentIndex]?.status !== "downloaded")
        return;
    if (btn)
        btn.removeAttribute("disabled");
    if (wav)
        wav.style.pointerEvents = "auto";
    const load = id(`#rv-${deck[0]}-load`);
    if (load)
        load.classList.add("hidden");
    setFocus(deck === "original" ? "original" : "staged");
}
function setFocus(deck) {
    focus = deck;
    id("#deck-original")?.classList.toggle("focused", deck === "original");
    id("#deck-staged")?.classList.toggle("focused", deck === "staged");
}
function activeWs() {
    return focus === "original" ? wsOrig : wsStaged;
}
function ctxOf(ws) {
    // The bundled player exposes the context as a property; real WaveSurfer
    // builds expose getAudioContext(). Support both, tolerate neither.
    const w = ws;
    if (w.audioContext)
        return w.audioContext;
    if (typeof w.getAudioContext === "function") {
        try {
            return w.getAudioContext();
        }
        catch {
            return null;
        }
    }
    return null;
}
async function playWs(ws) {
    if (!ws)
        return;
    try {
        const ctx = ctxOf(ws);
        if (ctx && ctx.state === "suspended") {
            try {
                await ctx.resume();
            }
            catch { /* resume is best-effort; player resumes itself too */ }
        }
        await ws.play();
    }
    catch (err) {
        console.error("Playback failed:", err);
    }
}
async function playActive() {
    await playWs(activeWs());
}
function togglePlayPause() {
    const ws = activeWs();
    if (!ws)
        return;
    if (ws.isPlaying())
        ws.pause();
    else
        void playActive();
}
/* ---------------- track loading & decisions ---------------- */
async function loadTrack(index) {
    if (index < 0 || index >= queue.length)
        return;
    currentIndex = index;
    // Stop previous audio and reset both playheads to zero first: the
    // player's position otherwise survives into the new track (stale
    // progress overlay + time readout until the new decode lands).
    try {
        wsOrig?.stop();
    }
    catch { /* player may be empty */ }
    try {
        wsStaged?.stop();
    }
    catch { /* player may be empty */ }
    const track = queue[index];
    const le = leFor(track);
    const cat = getItemCategory(track);
    if (!expanded[cat]) {
        Object.keys(expanded).forEach((k) => (expanded[k] = false));
        expanded[cat] = true;
        renderQueue();
    }
    highlightActive();
    scrollActiveIntoView();
    readyState.original.ready = false;
    readyState.original.decode = false;
    readyState.staged.ready = false;
    readyState.staged.decode = false;
    const playO = id("#play-original");
    const playS = id("#play-staged");
    playO?.setAttribute("disabled", "true");
    playS?.setAttribute("disabled", "true");
    const wavO = id("#wave-original");
    const wavS = id("#wave-staged");
    if (wavO)
        wavO.style.pointerEvents = "none";
    if (wavS)
        wavS.style.pointerEvents = "none";
    const lo = id("#rv-o-load");
    const ls = id("#rv-s-load");
    if (lo) {
        lo.classList.remove("hidden");
        lo.innerHTML = skeletonHtml("Loading original audio…");
    }
    [["#rv-o-dur2", "00:00"], ["#rv-o-time", "00:00"]].forEach(([sel, txt]) => {
        const h = id(sel);
        if (h)
            h.textContent = txt;
    });
    if (wsStaged?.empty)
        wsStaged.empty();
    [["#rv-s-dur", "-"], ["#rv-s-dur2", "--:--"], ["#rv-s-time", "--:--"], ["#rv-s-fmt", "—"]].forEach(([sel, txt]) => {
        const h = id(sel);
        if (h)
            h.textContent = txt;
    });
    // header
    const name = filenameOf(track.relPath);
    const on = id("#rv-o-name");
    if (on)
        on.textContent = name;
    const sn = id("#rv-s-name");
    const hasMeta = hasShazamMeta(track);
    if (track.status === "downloaded") {
        sn && (sn.textContent = `${le.artist ?? "Known"} — ${le.title ?? "upgrade"}`);
    }
    else if (hasMeta) {
        let status = "Identified, not on Deezer";
        if (track.status === "download_failed")
            status = `Download failed — ID ${track.deezerId ?? "?"}`;
        sn && (sn.textContent = `${le.title} (${status})`);
    }
    else {
        sn && (sn.textContent = "No upgrade");
    }
    // feedback + refetch pre-fill
    const input = id("#rv-deezer-id");
    if (input)
        input.value = track.deezerId ? String(track.deezerId) : "";
    const fb = id("#rv-feedback");
    if (fb)
        fb.textContent = "";
    const refetchRow = id("#rv-refetch-row");
    if (refetchRow)
        refetchRow.classList.toggle("hidden", track.status === "downloaded");
    // why + badge
    const why = id("#rv-why");
    if (why)
        why.innerHTML = whyText(track);
    // original path
    const originalAbs = le.original_abs_path ?? joinPath(res?.rootPath ?? "", track.relPath);
    const origExt = track.relPath.split(".").pop()?.toLowerCase() ?? "";
    const ofmt = id("#rv-o-format");
    const ofmtFl = id("#rv-o-fmt");
    if (ofmt)
        ofmt.textContent = origExt.toUpperCase() || "—";
    if (ofmtFl)
        ofmtFl.textContent = origExt.toUpperCase() || "—";
    id("#rv-o-file") && (id("#rv-o-file").textContent = name);
    const oBitrate = le.original_bitrate;
    const obt = id("#rv-o-bitrate");
    if (obt) {
        obt.textContent = isLosslessExt(track.relPath)
            ? "lossless"
            : oBitrate
                ? `${oBitrate} kbps`
                : "—";
    }
    id("#rv-o-size") && (id("#rv-o-size").textContent = fmtBytes(null));
    void getFileSize(originalAbs).then((sz) => {
        const h = id("#rv-o-size");
        if (h && typeof sz === "number")
            h.textContent = fmtBytes(sz);
    }).catch(() => undefined);
    if (wsOrig?.load && isTauri()) {
        try {
            void wsOrig.load(convertFileSrc(originalAbs));
        }
        catch (err) {
            if (lo)
                lo.textContent = `Error loading original: ${err}`;
        }
    }
    // Watchdog: if the player never reports ready for THIS track (silent
    // fetch/decode stall), retry the load once instead of leaving the
    // play buttons dead.
    if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = null;
    }
    watchdogRetried = false;
    const myIndex = index;
    const myOriginalUrl = isTauri() ? convertFileSrc(originalAbs) : "";
    let myStagedUrl = "";
    if (track.status === "downloaded") {
        if (ls) {
            ls.classList.remove("hidden");
            ls.innerHTML = skeletonHtml("Loading upgrade audio…");
        }
        playS?.removeAttribute("disabled");
        const stagedRel = le.proxy_path || le.staged_path;
        const stagedAbs = stagedRel
            ? stagedRel.startsWith("/") || stagedRel.includes(":")
                ? stagedRel
                : `${res?.rootPath ?? ""}/${stagedRel}`
            : "";
        myStagedUrl = stagedAbs && isTauri() ? convertFileSrc(stagedAbs) : "";
        if (stagedAbs && wsStaged?.load && isTauri()) {
            try {
                void wsStaged.load(convertFileSrc(stagedAbs));
            }
            catch (err) {
                if (ls)
                    ls.textContent = `Error loading upgrade: ${err}`;
            }
        }
        id("#rv-s-file") && (id("#rv-s-file").textContent = filenameOf(le.staged_path ?? ""));
        const sFmt = filenameOf(le.staged_path ?? "").split(".").pop()?.toUpperCase() ?? "—";
        id("#rv-s-format").textContent = sFmt;
        const sFmtFl = id("#rv-s-fmt");
        if (sFmtFl)
            sFmtFl.textContent = sFmt;
        const sBitrate = le.staged_bitrate;
        const sbt = id("#rv-s-bitrate");
        if (sbt) {
            sbt.textContent = isLosslessExt(le.staged_path ?? "")
                ? "lossless"
                : sBitrate
                    ? `${sBitrate} kbps`
                    : "—";
        }
        if (stagedAbs) {
            void getFileSize(stagedAbs).then((sz) => {
                const h = id("#rv-s-size");
                if (h && typeof sz === "number")
                    h.textContent = fmtBytes(sz);
            }).catch(() => undefined);
        }
        setFocus("original");
    }
    else {
        if (ls) {
            ls.classList.remove("hidden");
            ls.textContent = unresolvedReason(track);
        }
        setFocus("original");
    }
    watchdogTimer = window.setTimeout(() => {
        watchdogTimer = null;
        if (!active || !res || currentIndex !== myIndex || watchdogRetried)
            return;
        const needOrig = myOriginalUrl && !readyState.original.ready;
        const needStaged = myStagedUrl && track.status === "downloaded" && !readyState.staged.ready;
        if (!needOrig && !needStaged)
            return;
        watchdogRetried = true;
        try {
            if (needOrig && wsOrig)
                void wsOrig.load(myOriginalUrl);
            if (needStaged && wsStaged)
                void wsStaged.load(myStagedUrl);
        }
        catch { /* error listeners surface load failures */ }
    }, 8000);
    highlightActive();
    refreshDock();
}
function highlightActive() {
    document.querySelectorAll("#insp-body .qr").forEach((row) => {
        row.classList.toggle("on", parseInt(row.dataset.idx ?? "-1", 10) === currentIndex);
    });
}
function scrollActiveIntoView() {
    const rows = document.querySelectorAll("#insp-body .qr");
    rows.forEach((row) => {
        if (parseInt(row.dataset.idx ?? "-1", 10) === currentIndex) {
            row.scrollIntoView({ block: "nearest" });
        }
    });
}
function getNextInCategory(fromIndex) {
    const current = queue[fromIndex];
    if (!current)
        return -1;
    const cat = getItemCategory(current);
    const candidates = [];
    queue.forEach((item, idx) => {
        if (idx === fromIndex)
            return;
        if (getItemCategory(item) !== cat)
            return;
        if (decide(item) === "pending")
            candidates.push(idx);
    });
    if (candidates.length === 0)
        return -1;
    const after = candidates.find((i) => i > fromIndex);
    return after !== undefined ? after : candidates[candidates.length - 1];
}
async function saveDecision(relPath, decision) {
    const le = leFor({ relPath });
    le.decision = decision;
    if (!res)
        return;
    void saveLedgerDecision(res.ledgerPath, relPath, decision).catch((err) => console.error("Failed to save ledger decision:", err));
}
function pauseAll() {
    if (wsOrig)
        wsOrig.pause();
    if (wsStaged)
        wsStaged.pause();
    const setGlyph = window.__setPlayGlyph;
    if (setGlyph) {
        setGlyph("original", false);
        setGlyph("staged", false);
    }
}
async function approveCurrent() {
    const track = queue[currentIndex];
    if (!track)
        return;
    const prevDecision = decide(track);
    decisionHistory.push({ index: currentIndex, prevDecision });
    const d = track.status === "downloaded" || hasShazamMeta(track) ? "approved" : "skipped";
    await saveDecision(track.relPath, d);
    pauseAll();
    updateQueueRow(currentIndex);
    refreshDock();
    const next = getNextInCategory(currentIndex);
    if (next !== -1)
        await loadTrack(next);
    else
        scrollActiveIntoView();
}
async function skipCurrent() {
    const track = queue[currentIndex];
    if (!track)
        return;
    const prevDecision = decide(track);
    decisionHistory.push({ index: currentIndex, prevDecision });
    await saveDecision(track.relPath, "skipped");
    pauseAll();
    updateQueueRow(currentIndex);
    refreshDock();
    const next = getNextInCategory(currentIndex);
    if (next !== -1)
        await loadTrack(next);
    else
        scrollActiveIntoView();
}
async function undoLastDecision() {
    if (decisionHistory.length === 0)
        return;
    const last = decisionHistory.pop();
    const track = queue[last.index];
    if (!track)
        return;
    await saveDecision(track.relPath, last.prevDecision);
    pauseAll();
    updateQueueRow(last.index);
    refreshDock();
    await loadTrack(last.index);
}
async function clearCategory(cat, approve) {
    let changed = false;
    for (let idx = 0; idx < queue.length; idx++) {
        const item = queue[idx];
        if (getItemCategory(item) !== cat)
            continue;
        if (decide(item) !== "pending")
            continue;
        decisionHistory.push({ index: idx, prevDecision: decide(item) });
        let d;
        if (approve)
            d = item.status === "downloaded" || hasShazamMeta(item) ? "approved" : "skipped";
        else
            d = "skipped";
        await saveDecision(item.relPath, d);
        changed = true;
    }
    if (!changed)
        return;
    pauseAll();
    renderQueue();
    refreshDock();
    if (currentIndex !== -1)
        await loadTrack(currentIndex);
}
/* ---------------- manual identify / refetch ---------------- */
function showFeedback(text, color) {
    const fb = id("#rv-feedback");
    if (!fb)
        return;
    fb.textContent = text;
    fb.style.color =
        color === "ok" ? "var(--green)" : color === "warn" ? "var(--orange)" : "var(--red)";
    window.setTimeout(() => { if (fb.textContent === text)
        fb.textContent = ""; }, 4000);
}
function bindRefetchRow(el) {
    el.querySelector("#rv-identify")?.addEventListener("click", () => void onIdentify());
    el.querySelector("#rv-refetch")?.addEventListener("click", () => void onRefetch());
    el.querySelector("#rv-deezer-id")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            e.target.blur();
            void onRefetch();
        }
    });
}
async function onIdentify() {
    const track = queue[currentIndex];
    if (!track || !res)
        return;
    const btn = id("#rv-identify");
    const orig = btn?.textContent ?? "";
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Identifying…";
    }
    try {
        const result = JSON.parse(await identifyTrack(res.rootPath, track.relPath));
        if (result.artist || result.title) {
            ledgSet(track, "artist", result.artist ?? null);
            ledgSet(track, "title", result.title ?? null);
            if (result.deezer_id) {
                ledgSet(track, "deezer_id", Number(result.deezer_id));
                track.deezerId = Number(result.deezer_id);
                const input = id("#rv-deezer-id");
                if (input)
                    input.value = String(result.deezer_id);
                showFeedback("✓ Found on Deezer", "ok");
            }
            else {
                ledgSet(track, "status", "not_on_deezer");
                track.status = "not_on_deezer";
                showFeedback("⚠ Not on Deezer", "warn");
            }
            renderQueue();
            await loadTrack(currentIndex);
        }
        else {
            showFeedback("✗ Not identified", "err");
        }
    }
    catch (err) {
        const msg = String(err);
        showFeedback(msg.includes("unidentified") ? "✗ Not identified" : `✗ ${msg}`, "err");
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = orig;
        }
    }
}
function ledgSet(item, key, value) {
    const le = leFor(item);
    le[key] = value;
}
async function onRefetch() {
    const track = queue[currentIndex];
    if (!track || !res)
        return;
    const input = id("#rv-deezer-id");
    const raw = input?.value.trim() ?? "";
    if (!/^\d+$/.test(raw)) {
        showFeedback("Enter a numeric Deezer ID", "warn");
        return;
    }
    const targetId = parseInt(raw, 10);
    const le = leFor(track);
    const artist = le.artist ?? "Unknown Artist";
    const title = le.title ?? "Unknown Title";
    const btn = id("#rv-refetch");
    const orig = btn?.textContent ?? "";
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Fetching…";
    }
    const prevSim = le.similarity_score;
    const prevBit = le.audio_bit_identical;
    ledgSet(track, "similarity_score", undefined);
    ledgSet(track, "audio_bit_identical", undefined);
    renderQueue();
    try {
        const result = JSON.parse(await downloadTrackById(res.rootPath, ledger?.output_format ?? "flac", track.relPath, targetId, artist, title));
        ledgSet(track, "status", "downloaded");
        ledgSet(track, "deezer_id", targetId);
        ledgSet(track, "staged_path", result.staged_path ?? null);
        ledgSet(track, "proxy_path", result.proxy_path ?? null);
        ledgSet(track, "staged_bitrate", result.staged_bitrate ?? null);
        if (typeof result.artist === "string")
            ledgSet(track, "artist", result.artist);
        if (typeof result.title === "string")
            ledgSet(track, "title", result.title);
        ledgSet(track, "decision", "pending");
        ledgSet(track, "similarity_score", typeof result.similarity_score === "number" ? result.similarity_score : undefined);
        ledgSet(track, "audio_bit_identical", typeof result.audio_bit_identical === "boolean" ? result.audio_bit_identical : false);
        track.status = "downloaded";
        track.deezerId = targetId;
        track.proxyPath = result.proxy_path ?? null;
        const newCat = getItemCategory(track);
        Object.keys(expanded).forEach((k) => (expanded[k] = false));
        expanded[newCat] = true;
        renderQueue();
        refreshDock();
        await loadTrack(currentIndex);
        // re-read ledger so persisted similarity flows into the UI
        ledgSetFromDisk(track.relPath);
        renderQueue();
        await loadTrack(currentIndex);
        showFeedback("✓ Downloaded", "ok");
    }
    catch (err) {
        ledgSet(track, "similarity_score", prevSim);
        ledgSet(track, "audio_bit_identical", prevBit);
        renderQueue();
        showFeedback(`✗ ${err}`, "err");
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = orig;
        }
    }
}
async function ledgSetFromDisk(relPath) {
    if (!res)
        return;
    try {
        ledger = JSON.parse(await readLedgerFile(res.ledgerPath));
        const entry = queue.find((i) => i.relPath === relPath);
        if (entry) {
            const le = leFor(entry);
            entry.bitIdentical = le.audio_bit_identical;
            entry.similarityScore = le.similarity_score;
        }
    }
    catch { /* keep in-memory */ }
}
/* ---------------- commit ---------------- */
function openCommitModal() {
    if (!res || !ledger)
        return;
    renderUpgraderStage(3);
    const root = document.createElement("div");
    root.className = "modal-backdrop show";
    const isDb = res.sourceKind === "db";
    const isXml = res.sourceKind === "xml" && !!res.xmlPath;
    const defaultSuggestion = suggestedDestPath(res.rootPath);
    root.innerHTML = `
    <div class="modal" role="dialog" aria-label="Apply changes">
      <div class="modal-title">Apply All Changes</div>
      <p class="muted small" style="margin:0">
        Approved pairs copy to the library; skipped tracks keep their originals. Choose how files are placed on disk and whether Rekordbox paths are updated.
      </p>
      <div class="isec" style="margin:0">
        <h4>Output strategy</h4>
        <label class="opt">
          <input type="radio" class="chk" name="commit-output-strategy" value="replace" checked />
          <span class="of">Replace in library<span class="ob">Overwrites original files in place with the upgraded copy. Rekordbox paths stay valid.</span></span>
        </label>
        <label class="opt">
          <input type="radio" class="chk" name="commit-output-strategy" value="custom" />
          <span class="of">Consolidate to folder<span class="ob">Copies the final library (approved upgrades + retained originals) into a chosen output folder. Rekordbox paths are rewritten to it.</span></span>
        </label>
        <div class="frow hidden" id="commit-destination-container" style="margin-top:8px">
          <input class="field" id="commit-destination-input" readonly placeholder="Choose output folder…" value="${escAttr(defaultSuggestion)}" />
          <button class="btn sm" id="commit-destination-browse-btn">Choose…</button>
        </div>
      </div>
      <div class="isec" style="margin:0">
        <h4>Rekordbox</h4>
        <label class="opt">
          <input type="radio" class="chk" name="commit-rekordbox-action" value="db" ${isDb ? "checked" : "disabled"} />
          <span class="of">Update database directly<span class="ob">Syncs rewritten track paths straight into master.db. Only available when the source is the live database.</span></span>
        </label>
        ${isXml ? `
        <label class="opt">
          <input type="radio" class="chk" name="commit-rekordbox-action" value="xml" checked />
          <span class="of">Export upgraded XML<span class="ob">Generates a new Rekordbox XML with updated track paths and lossless audio specs.</span></span>
        </label>` : ""}
        <label class="opt">
          <input type="radio" class="chk" name="commit-rekordbox-action" value="none" ${isDb || isXml ? "" : "checked"} />
          <span class="of">Leave Rekordbox alone<span class="ob">Files move on disk; Rekordbox is not touched.</span></span>
        </label>
        <p class="muted small" style="margin:8px 0 0;font-size:11px">ℹ Cue points, hot cues, beatgrids, and playlists are preserved. (If a new master differs in silence lead-in, beatgrid alignment can be fine-tuned in Rekordbox).</p>
        <p id="commit-rekordbox-lock-warning" class="warn-text hidden" style="margin:6px 0 0">Rekordbox is running. Close it before updating the database, or choose “Leave Rekordbox alone”.</p>
      </div>
      <div class="modal-actions">
        <button class="btn" id="commit-config-cancel">Cancel</button>
        <button class="btn primary" id="commit-config-confirm">Apply</button>
      </div>
    </div>`;
    document.body.appendChild(root);
    const destContainer = () => root.querySelector("#commit-destination-container");
    const destInput = () => root.querySelector("#commit-destination-input");
    const confirmBtn = () => root.querySelector("#commit-config-confirm");
    const warningEl = () => root.querySelector("#commit-rekordbox-lock-warning");
    const rbAction = () => (root.querySelector('input[name="commit-rekordbox-action"]:checked')?.value ?? "none");
    const close = () => {
        if (lockInterval !== null) {
            window.clearInterval(lockInterval);
            lockInterval = null;
        }
        root.remove();
    };
    const updateLockWarning = async () => {
        const runDb = rbAction() === "db" && isDb;
        if (runDb) {
            const status = await checkRekordboxStatus().catch(() => null);
            if (status?.running) {
                warningEl()?.classList.remove("hidden");
                confirmBtn()?.setAttribute("disabled", "true");
                return;
            }
        }
        warningEl()?.classList.add("hidden");
        confirmBtn()?.removeAttribute("disabled");
    };
    root.addEventListener("click", (e) => {
        const t = e.target;
        if (t === root) {
            close();
            return;
        }
        if (t.closest("#commit-config-cancel")) {
            close();
            return;
        }
        if (t.closest("#commit-destination-browse-btn")) {
            void (async () => {
                const picked = await selectOutputDirectory(destInput()?.value).catch(() => null);
                if (picked && destInput())
                    destInput().value = picked;
            })();
        }
        if (t.closest("#commit-config-confirm")) {
            void runCommit(close);
        }
    });
    root.querySelectorAll('input[name="commit-output-strategy"]').forEach((radio) => {
        radio.addEventListener("change", () => {
            destContainer()?.classList.toggle("hidden", radio.value === "replace");
        });
    });
    root.querySelectorAll('input[name="commit-rekordbox-action"]').forEach((radio) => {
        radio.addEventListener("change", () => void updateLockWarning());
    });
    void updateLockWarning();
    lockInterval = window.setInterval(() => void updateLockWarning(), 1000);
    function escAttr(s) {
        return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    }
}
function suggestedDestPath(rootPath) {
    const parts = rootPath.replace(/\\/g, "/").split("/").filter(Boolean);
    parts.pop();
    const folder = rootPath.replace(/\\/g, "/").split("/").filter(Boolean).pop();
    if (parts.length > 0 && folder)
        return `${parts.join("/")}/${folder}-upgraded`;
    return "";
}
async function runCommit(closeModal) {
    if (!res || !ledger)
        return;
    const strategyEl = document.querySelector('input[name="commit-output-strategy"]:checked');
    const strategy = strategyEl?.value ?? "replace";
    const destEl = document.querySelector("#commit-destination-input");
    const outputPath = strategy === "replace" ? "" : (destEl?.value.trim() ?? "");
    if (strategy !== "replace" && !outputPath) {
        destContainerWarning();
        return;
    }
    const rbAction = document.querySelector('input[name="commit-rekordbox-action"]:checked')?.value ?? "none";
    closeModal();
    const backdrop = showCommitResults();
    const decisions = {};
    queue.forEach((item) => {
        decisions[item.relPath] = decide(item) || "skipped";
    });
    let commitResult = null;
    let exportedXmlPath = null;
    try {
        setCommitStatus(backdrop, "Applying high-quality replacements to your library files. Please do not close the app.");
        commitResult = await commitChanges(res.ledgerPath, decisions, outputPath, strategy);
        if (rbAction === "db" && res.sourceKind === "db") {
            setCommitStatus(backdrop, "Updating Rekordbox library directly…");
            await updateRekordboxDbDirectly(res.ledgerPath, decisions, outputPath, strategy);
        }
        else if (rbAction === "xml" && res.sourceKind === "xml" && res.xmlPath) {
            setCommitStatus(backdrop, "Exporting upgraded Rekordbox XML…");
            exportedXmlPath = await updateRekordboxXml(res.xmlPath, res.ledgerPath, decisions);
        }
        renderCommitResult(backdrop, commitResult.committed, commitResult.skipped, commitResult.failed, rbAction === "db" && res.sourceKind === "db", undefined, exportedXmlPath);
    }
    catch (err) {
        const committed = commitResult ? commitResult.committed : 0;
        const skipped = commitResult ? commitResult.skipped : 0;
        const failed = commitResult ? commitResult.failed : [];
        renderCommitResult(backdrop, committed, skipped, failed, false, `Error during commit: ${err}`);
    }
}
function destContainerWarning() {
    const dest = document.getElementById("commit-destination-input");
    if (!dest)
        return;
    dest.style.borderColor = "var(--red)";
    window.setTimeout(() => dest.removeAttribute("style"), 2500);
}
function showCommitResults() {
    removeAnyResultsModal();
    const root = document.createElement("div");
    root.className = "modal-backdrop show";
    root.id = "rv-commit-results";
    root.innerHTML = `
    <div class="modal" style="width:min(620px,92vw)">
      <div class="modal-title" id="rv-commit-title">Committing Upgrades</div>
      <div id="rv-commit-body">
        <div style="text-align:center;padding:22px 0">
          <div class="spinner"></div>
          <p id="rv-commit-loading" class="muted small" style="margin-top:12px">Preparing…</p>
        </div>
      </div>
      <div class="modal-actions hidden" id="rv-commit-actions">
        <button class="btn primary" id="rv-commit-close">Done</button>
      </div>
    </div>`;
    document.body.appendChild(root);
    return root;
}
function removeAnyResultsModal() {
    document.getElementById("rv-commit-results")?.remove();
}
function setCommitStatus(root, text) {
    const el = root.querySelector("#rv-commit-loading");
    if (el)
        el.textContent = text;
}
function renderCommitResult(root, committed, skipped, failed, dbUpdated, error, xmlExportPath) {
    const title = root.querySelector("#rv-commit-title");
    const body = root.querySelector("#rv-commit-body");
    const actions = root.querySelector("#rv-commit-actions");
    if (title) {
        title.textContent = error ? "Commit Issue" : "✔ Upgrades Applied";
        title.style.color = error ? "var(--red)" : "var(--green)";
    }
    if (body) {
        if (error) {
            body.innerHTML = `
        <div class="danger-text" style="font-family:var(--mono);font-size:12px;padding:10px;background:var(--red-bg);border:1px solid var(--red);border-radius:6px;margin-bottom:12px">${esc(error)}</div>
        ${committed > 0 ? `<p class="muted small" style="margin-bottom:8px">${committed} track(s) were replaced on disk, but Rekordbox sync failed. Your progress ledger is safely preserved so no work is lost.</p>` : "<p class=\"muted small\">Your session ledger has been preserved.</p>"}
      `;
        }
        else {
            body.innerHTML = `
        <div class="stats" style="margin-top:4px">
          <div class="stat"><div class="v">${committed}</div><div class="l">Committed</div></div>
          <div class="stat"><div class="v">${skipped}</div><div class="l">Skipped</div></div>
          <div class="stat"><div class="v">${failed.length}</div><div class="l">Failed</div></div>
        </div>
        ${dbUpdated ? `<p class="ok-text small" style="margin:10px 0 0">Rekordbox library updated successfully.</p>` : ""}
        ${xmlExportPath ? `<p class="ok-text small" style="margin:10px 0 0">Upgraded Rekordbox XML exported to:<br /><code style="font-family:var(--mono);font-size:11px;word-break:break-all">${esc(xmlExportPath)}</code></p>` : ""}
        ${failed.length > 0 ? `
          <div style="max-height:140px;overflow:auto;margin-top:12px;padding:10px 12px;background:var(--red-bg);border:1px solid var(--line2);border-radius:6px">
            <p class="danger-text small" style="margin:0 0 6px">Commit failures</p>
            ${failed.map((f) => `<div style="font-family:var(--mono);font-size:11px;color:var(--red);margin-bottom:5px"><b>${esc(f.relPath)}</b>: ${esc(f.error)}</div>`).join("")}
          </div>
        ` : ""}`;
        }
    }
    actions?.classList.remove("hidden");
    const closeBtn = root.querySelector("#rv-commit-close");
    if (closeBtn) {
        if (error)
            closeBtn.textContent = "Close (Keep Session)";
        closeBtn.addEventListener("click", () => {
            root.remove();
            if (error) {
                // Do not wipe the ledger on failure — leave review or let user retry
                leaveReview();
                cb?.onClose();
            }
            else {
                void finishSession();
            }
        });
    }
}
async function finishSession() {
    if (!res)
        return;
    try {
        await resetSession(res.rootPath, res.isSessionDir);
    }
    catch (err) {
        console.error("Failed to delete ledger on finish:", err);
    }
    clearSession();
    leaveReview();
    cb?.onFinish();
}
/* ---------------- global keyboard ---------------- */
function anyModalOpen() {
    return document.querySelectorAll(".modal-backdrop.show").length > 0;
}
window.addEventListener("keydown", (e) => {
    if (!active)
        return;
    if (!res || !ledger)
        return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT"))
        return;
    if (document.getElementById("rv-shortcuts-modal")) {
        if (e.key === "Escape" || e.key === "?" || e.key === "h" || e.key === "H") {
            e.preventDefault();
            removeAnyShortcutsModal();
            return;
        }
    }
    if (anyModalOpen())
        return;
    if (e.key === "?" || ((e.key === "h" || e.key === "H") && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        openShortcutsModal();
        return;
    }
    if ((e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        void undoLastDecision();
        return;
    }
    if ((e.key === "l" || e.key === "L") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        toggleLinkedScrub();
        return;
    }
    if (e.key === "Enter")
        e.preventDefault();
    if (currentIndex < 0 || currentIndex >= queue.length)
        return;
    const track = queue[currentIndex];
    switch (e.key) {
        case " ":
            e.preventDefault();
            if (track.status === "downloaded")
                togglePlayPause();
            else if (wsOrig) {
                if (wsOrig.isPlaying())
                    wsOrig.pause();
                else
                    void playWs(wsOrig);
            }
            break;
        case "ArrowUp":
            e.preventDefault();
            if (track.status === "downloaded")
                setFocus("original");
            break;
        case "ArrowDown":
            e.preventDefault();
            if (track.status === "downloaded")
                setFocus("staged");
            break;
        case "ArrowLeft":
            e.preventDefault();
            seekHand(track, -(e.metaKey || e.ctrlKey ? 20 : 5));
            break;
        case "ArrowRight":
            e.preventDefault();
            seekHand(track, e.metaKey || e.ctrlKey ? 20 : 5);
            break;
        case "Enter":
            e.preventDefault();
            if (track.status === "downloaded" || hasShazamMeta(track))
                void approveCurrent();
            break;
        case "Backspace":
            e.preventDefault();
            void skipCurrent();
            break;
    }
});
window.addEventListener("blur", () => {
    if (!active)
        return;
    pauseAll();
});
function seekHand(track, sec) {
    const ws = track.status === "downloaded" ? activeWs() : wsOrig;
    if (!ws)
        return;
    const media = ws.getMediaElement();
    const dur = media?.duration ?? ws.getDuration();
    const next = Math.max(0, Math.min(dur, ws.getCurrentTime() + sec));
    ws.setTime(next);
    if (linkedScrub && track.status === "downloaded") {
        const other = ws === wsOrig ? wsStaged : wsOrig;
        const otherDeck = ws === wsOrig ? "staged" : "original";
        syncSeek(ws, other, otherDeck);
    }
}
