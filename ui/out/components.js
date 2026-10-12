/* Shared view primitives. Keep these dumb: layout + type only.
   Native macOS vocabulary: cards (.sect), rows (.frow/.opt), stats. */
export function phaseHead(kicker, title, lede) {
    return `
    <div class="phead">
      <span class="k">${kicker}</span>
      <h1>${title}</h1>
      <p>${lede}</p>
    </div>`;
}
export function sectionLabel(label) {
    return `<h2 class="sl">${label}</h2>`;
}
export function card(title, body) {
    return `<div class="sect"><h3>${title}</h3>${body}</div>`;
}
/** kv row with mono, right-aligned value. */
export function kv(label, value) {
    return `<div class="kv-row"><span class="k-label">${label}</span><span class="k-value">${value}</span></div>`;
}
/** Native checkbox line: checked + label + optional sub-detail. */
export function chkRow(checked, label, detail = "") {
    const icon = `<span class="chk ${checked ? "on" : ""}"></span>`;
    return `<label class="opt">${icon}<span class="of">${label}${detail ? `<span class="ob">${detail}</span>` : ""}</span></label>`;
}
