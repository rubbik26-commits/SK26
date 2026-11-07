// Tiny DOM helpers + shared widgets (no framework — template strings + delegation).
import { esc } from "./lib/format.js";
import { scoreColor, CATEGORY_COLORS, CATEGORY_SHORT, RISK_COLORS, FIT_COLORS } from "./lib/constants.js";

export const h = esc;
export const el = (sel, root = document) => root.querySelector(sel);
export const els = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, ms = 2400) {
  els(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function scorePill(score, size = 36) {
  const c = scoreColor(score);
  return `<span class="score-pill" style="width:${size}px;height:${size}px;font-size:${size > 30 ? 14 : 12}px;background:${c}1f;color:${c};border-color:${c}55">${score}</span>`;
}
export function categoryBadge(cat, compact = false) {
  const c = CATEGORY_COLORS[cat] ?? "#64748B";
  return `<span class="badge" title="${h(cat)}" style="background:${c}1a;color:${c};border-color:${c}44"><span class="dot"></span>${h(compact ? CATEGORY_SHORT[cat] ?? cat : cat)}</span>`;
}
export function riskBadge(risk) {
  const c = RISK_COLORS[risk] ?? "#64748B";
  return `<span class="badge" style="background:${c}1a;color:${c};border-color:${c}44">${h(risk)} risk</span>`;
}
export function fitBadge(fit) {
  if (!fit || fit === "N/A") return "";
  const c = FIT_COLORS[fit] ?? "#8a8782";
  return `<span class="badge" style="background:${c}1a;color:${c};border-color:${c}44">${h(fit)} conversion fit</span>`;
}
export function pillBadge(text) {
  return `<span class="badge" style="background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)">${h(text)}</span>`;
}
export function bandBadge(band, score) {
  const c = band === "High" ? "var(--red)" : band === "Elevated" ? "var(--amber)" : band === "Watch" ? "#9a7400" : "var(--ink-faint)";
  return `<span class="badge" style="color:${c};border-color:currentColor;background:transparent">${h(band)} · ${score}/100</span>`;
}

export function kvRow(k, v, mono = false) {
  return `<div class="kv"><span class="k">${h(k)}</span><span class="v ${mono ? "mono" : ""}">${v}</span></div>`;
}
export function sectionHead(title, sub = "") {
  return `<div class="sect-head"><span class="t">${h(title)}</span>${sub ? `<span class="s">${h(sub)}</span>` : ""}</div>`;
}
export function spinner(label = "Loading…") {
  return `<span style="display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-faint)"><span class="spin"></span>${h(label)}</span>`;
}
export function statCard({ value, label, note, tone = "", drill = false, attr = "" }) {
  const tag = drill ? "button" : "div";
  return `<${tag} class="stat ${tone}" ${attr}><div class="v">${value}</div><div class="l">${h(label)}</div>${note ? `<div class="n">${h(note)}</div>` : ""}${drill ? `<div class="drill">See the records →</div>` : ""}</${tag}>`;
}

export function openModal(title, bodyHtml, { wide = false } = {}) {
  const veil = document.createElement("div");
  veil.className = "modal-veil";
  veil.innerHTML = `<div class="modal" style="${wide ? "max-width:900px" : ""}">
    <div class="modal-head"><span class="t">${h(title)}</span><button class="xbtn" data-x>✕</button></div>
    <div class="modal-body scroll"></div>
  </div>`;
  veil.querySelector(".modal-body").innerHTML = bodyHtml;
  veil.addEventListener("click", (e) => { if (e.target === veil || e.target.closest("[data-x]")) veil.remove(); });
  const esch = (e) => { if (e.key === "Escape") { veil.remove(); window.removeEventListener("keydown", esch); } };
  window.addEventListener("keydown", esch);
  document.body.appendChild(veil);
  return veil;
}

// Print a full standalone HTML document (reports) via hidden iframe.
// Make a horizontal card strip actually scrollable for every input: mouse
// wheel translates to horizontal scroll, drag pans (without eating clicks),
// and ‹ › paddles appear whenever there is more content off-screen.
export function enhanceHScroll(scroller, { arrows = true } = {}) {
  if (!scroller || scroller.dataset.hscroll) return;
  scroller.dataset.hscroll = "1";
  scroller.style.overscrollBehaviorX = "contain";
  scroller.addEventListener("wheel", (e) => {
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    // A vertically-scrollable child (e.g. a kanban column) keeps its wheel.
    for (let n = e.target; n && n !== scroller; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return;
    }
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    scroller.scrollLeft += d;
    e.preventDefault();
  }, { passive: false });

  let drag = null;
  scroller.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    drag = { x: e.clientX, left: scroller.scrollLeft, moved: false };
  });
  scroller.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 6) { drag.moved = true; scroller.style.cursor = "grabbing"; }
    if (drag.moved) scroller.scrollLeft = drag.left - dx;
  });
  const endDrag = () => { if (drag?.moved) suppressNextClick(scroller); drag = null; scroller.style.cursor = ""; };
  scroller.addEventListener("pointerup", endDrag);
  scroller.addEventListener("pointerleave", endDrag);

  if (!arrows) return;
  const parent = scroller.parentElement;
  const cs = getComputedStyle(parent);
  if (cs.position === "static") parent.style.position = "relative";
  const mk = (dir) => {
    const b = document.createElement("button");
    b.className = "hpaddle";
    b.type = "button";
    b.textContent = dir < 0 ? "‹" : "›";
    b.style[dir < 0 ? "left" : "right"] = "6px";
    b.addEventListener("click", () => scroller.scrollBy({ left: dir * scroller.clientWidth * 0.8, behavior: "smooth" }));
    parent.appendChild(b);
    return b;
  };
  const left = mk(-1), right = mk(1);
  const sync = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    left.style.display = scroller.scrollLeft > 8 ? "" : "none";
    right.style.display = max - scroller.scrollLeft > 8 ? "" : "none";
    const top = scroller.offsetTop + scroller.offsetHeight / 2;
    left.style.top = right.style.top = `${top}px`;
  };
  scroller.addEventListener("scroll", sync, { passive: true });
  new ResizeObserver(sync).observe(scroller);
  requestAnimationFrame(sync);
}
function suppressNextClick(node) {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  node.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => node.removeEventListener("click", stop, { capture: true }), 80);
}

export function printDocument(title, html) {
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${html}</body></html>`);
  d.close();
  setTimeout(() => { f.contentWindow?.focus(); f.contentWindow?.print(); setTimeout(() => f.remove(), 1200); }, 350);
}
export function openDocumentPreview(title, html) {
  const veil = openModal(title, `<div class="doc-preview"></div>`, { wide: true });
  veil.querySelector(".modal-body").style.cssText = "background:#5B6B7E;padding:20px;max-height:80vh";
  veil.querySelector(".doc-preview").innerHTML = html;
  veil.querySelector(".doc-preview").style.cssText = "max-width:850px;margin:0 auto;box-shadow:0 10px 40px rgba(0,0,0,.35);background:#fff";
  const head = veil.querySelector(".modal-head");
  const btn = document.createElement("button");
  btn.className = "btn sm";
  btn.style.cssText = "background:#E4873C;border-color:#E4873C;color:#101C2F;font-weight:800";
  btn.textContent = "Save as PDF";
  btn.addEventListener("click", () => printDocument(title, html));
  head.insertBefore(btn, head.querySelector("[data-x]"));
  return veil;
}

export const icons = {
  map: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>`,
  file: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  kanban: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="14" rx="1"/><rect x="14" y="3" width="7" height="9" rx="1"/></svg>`,
  compass: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`,
  target: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  radar: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62a10 10 0 1 0 19.02-1.27"/><path d="M16.24 7.76a6 6 0 1 0-8.01 8.91"/><path d="M12 18h.01"/><path d="M17.99 11.66a6 6 0 0 1-2.22 4.75"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/></svg>`,
  calc: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="8" y2="12.01"/><line x1="12" y1="12" x2="12" y2="12.01"/><line x1="16" y1="12" x2="16" y2="12.01"/><line x1="8" y1="16" x2="8" y2="16.01"/><line x1="12" y1="16" x2="12" y2="16.01"/><line x1="16" y1="16" x2="16" y2="16.01"/></svg>`,
  chart: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>`,
  present: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/></svg>`,
  desk: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20"/></svg>`,
  users: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  db: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>`,
  external: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  logo: (size = 28) => `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-label="NYC RE Market Intel logo"><rect x="2" y="2" width="28" height="28" rx="7" fill="hsl(221 90% 53%)"/><path d="M7 24V8L25 24V8M11 12.5h10M11 17h10" stroke="white" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" fill="none"/><circle cx="16" cy="20.5" r="2.1" fill="white"/></svg>`
};
