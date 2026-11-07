// App shell + hash router. Pages are ES modules with mount(container, ctx).
import * as auth from "./auth.js";
import { el, els, icons, h } from "./ui.js";
import { desk, saveDesk } from "./api.js";

const NAV_MAIN = [
  { path: "/", label: "Market Intel", icon: icons.map },
  { path: "/dossier", label: "Parcel Dossier", icon: icons.file },
  { path: "/pipeline", label: "Pipeline / CRM", icon: icons.kanban },
  { path: "/live", label: "Live Details", icon: icons.compass },
  { path: "/territory", label: "Territory Mastery", icon: icons.target },
  { path: "/radar", label: "Deal Radar", short: "Radar", icon: icons.radar },
  { path: "/calculator", label: "Deal Calculator", short: "Calc", icon: icons.calc },
  { path: "/comps", label: "Comps / Land Index", short: "Comps", icon: icons.chart },
  { path: "/present", label: "Presentation Mode", short: "Present", icon: icons.present }
];
const NAV_WORK = [
  { path: "/desk", label: "My Desk", icon: icons.desk },
  { path: "/investors", label: "Investors", icon: icons.users },
  { path: "/sources", label: "Source Registry", short: "Sources", icon: icons.db }
];

const PAGES = {
  "/": () => import("./pages/map-room.js"),
  "/dossier": () => import("./pages/dossier.js"),
  "/pipeline": () => import("./pages/pipeline.js"),
  "/live": () => import("./pages/live.js"),
  "/territory": () => import("./pages/territory.js"),
  "/radar": () => import("./pages/radar.js"),
  "/calculator": () => import("./pages/calculator.js"),
  "/comps": () => import("./pages/comps.js"),
  "/present": () => import("./pages/present.js"),
  "/desk": () => import("./pages/desk.js"),
  "/investors": () => import("./pages/investors.js"),
  "/sources": () => import("./pages/sources.js")
};

const savedTheme = localStorage.getItem("nyc-intel-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

function shell() {
  el("#app").innerHTML = `
    <aside class="rail">
      <div class="rail-brand">${icons.logo(30)}<div><b>NYC RE Market Intel</b><span>Multifamily + Development</span></div></div>
      <nav class="rail-nav scroll">
        <div class="sect">Map room</div>
        ${NAV_MAIN.map((n) => railLink(n)).join("")}
        <div class="sect">Workspace</div>
        ${NAV_WORK.map((n) => railLink(n)).join("")}
      </nav>
      <div class="rail-foot">
        <div class="rail-card" style="margin-bottom:9px" id="railAuth"></div>
        <div class="rail-card" id="dataPosture">
          <div class="k">Data posture</div>
          <p>Checking the data connection…</p>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <span class="pulse"></span>
        <p><b>NYC multifamily + development intelligence</b> <span class="hide-sm">— Manhattan, Brooklyn, LIC/Queens. Block-by-block coverage.</span></p>
        <div class="spacer"></div>
        <button class="iconbtn" id="themeBtn" title="Toggle light / dark">◐</button>
      </header>
      <div id="page"></div>
    </div>
    <nav class="mobilebar">
      ${[...NAV_MAIN, ...NAV_WORK].map((n) => `<a href="#${n.path}" data-mnav="${n.path}">${n.icon}<span>${h(n.short ?? n.label.split(" ")[0])}</span></a>`).join("")}
    </nav>`;

  el("#themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme === "dark" ? "" : "dark";
    if (cur) document.documentElement.dataset.theme = cur; else delete document.documentElement.dataset.theme;
    localStorage.setItem("nyc-intel-theme", cur);
    window.dispatchEvent(new CustomEvent("themechange"));
  });
  // Honest data-posture card: reflects what the server is actually serving.
  fetch("/api/status").then((r) => r.json()).then((s) => {
    const card = el("#dataPosture");
    if (!card) return;
    card.innerHTML = s.dataMode === "live"
      ? `<div class="k">Data posture</div>
         <p>Serving <b style="color:var(--green)">live NYC public records</b> — PLUTO parcels, recorded deeds &amp; mortgages, DOB permits, HPD, DOF assessments, lien sale, MTA transit.</p>
         <p>The 34 curated tour parcels are authored demo records and stay labeled <b>Demo</b>.</p>`
      : `<div class="k">Data posture</div>
         <p><b style="color:var(--amber)">Demo engine active</b> — live NYC Open Data is unreachable from this host, so responses are modeled and labeled <b>Demo</b>.</p>
         <p>Nothing modeled is presented as a live record.</p>`;
  }).catch(() => {
    const card = el("#dataPosture");
    if (card) card.innerHTML = `<div class="k">Data posture</div><p>Server unreachable.</p>`;
  });
  renderRailAuth();
  window.addEventListener("authchange", renderRailAuth);
}

// The original sidebar account card: "Sign in (optional)" with email +
// password (magic-link message when a transport is configured), and the
// signed-in profile with report identity + Sign out.
async function renderRailAuth() {
  const box = el("#railAuth");
  if (!box) return;
  const u = await auth.me({ fresh: true });
  const railField = `background:hsl(0 0% 100%/0.07);border-color:var(--rail-line);color:#fff;font-size:12px;padding:6px 9px`;
  if (u.signedIn) {
    box.innerHTML = `
      <div class="k">${h(u.email)}${u.role === "owner" || u.role === "admin" ? " · owner" : ""}</div>
      <div class="k" style="margin-top:7px">Your name on reports</div>
      <input id="railName" class="field" style="${railField}" placeholder="e.g. Robert K." value="${h(u.display_name || "")}" />
      <button class="btn sm" id="railSignOut" style="margin-top:8px;width:100%;justify-content:center;background:hsl(0 0% 100%/0.07);border-color:var(--rail-line);color:#fff">Sign out</button>`;
    el("#railName").addEventListener("change", async (e) => {
      try { await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: e.target.value.trim() }) }); } catch { /* keep typing */ }
      const d = desk(); d.name = e.target.value.trim(); saveDesk(d); // cache for report generators
    });
    el("#railSignOut").addEventListener("click", async () => { await auth.logout(); });
    return;
  }
  box.innerHTML = `
    <div class="k">Sign in (optional)</div>
    <div id="railAuthMsg" class="k" style="text-transform:none;letter-spacing:0;display:none;margin:4px 0"></div>
    <input id="railEmail" class="field" style="${railField};margin-top:4px" type="email" placeholder="you@email.com" />
    <input id="railPass" class="field" style="${railField};margin-top:5px" type="password" placeholder="Password" />
    <div style="display:flex;gap:6px;margin-top:7px">
      <button class="btn sm" id="railSignIn" style="flex:1;justify-content:center">Sign in</button>
      <button class="btn sm" id="railSignUp" style="flex:1;justify-content:center;background:hsl(0 0% 100%/0.07);border-color:var(--rail-line);color:#fff">Create account</button>
    </div>`;
  const msg = (t, tone) => {
    const n = el("#railAuthMsg");
    n.style.display = "block";
    n.style.color = tone === "err" ? "hsl(0 80% 72%)" : "hsl(140 55% 68%)";
    n.textContent = t;
  };
  const creds = () => [el("#railEmail").value.trim(), el("#railPass").value];
  el("#railSignIn").addEventListener("click", async () => {
    const [email, pass] = creds();
    if (!email) return msg("Enter your email.", "err");
    if (!pass) {
      try { const r = await auth.magicLink(email); msg(r.sent ? "Check your email for a sign-in link." : r.message, r.sent ? "ok" : "err"); }
      catch (e2) { msg(e2.message, "err"); }
      return;
    }
    try { await auth.login(email, pass); await auth.importLocalDesk(); }
    catch (e2) { msg(e2.message, "err"); }
  });
  el("#railSignUp").addEventListener("click", async () => {
    const [email, pass] = creds();
    if (!email || !pass) return msg("Email and a password (8+ characters) create your account.", "err");
    try { await auth.signup(email, pass, desk().name || ""); await auth.importLocalDesk(); }
    catch (e2) { msg(e2.message, "err"); }
  });
}
function railLink(n) {
  return `<a class="rail-link" href="#${n.path}" data-nav="${n.path}">${n.icon}${h(n.label)}</a>`;
}

let current = { destroy: null, path: null };
export function currentPath() {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  return hash.split("?")[0];
}
export function queryParams() {
  const hash = window.location.hash;
  const search = window.location.search.replace(/^\?/, "");
  const hq = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return new URLSearchParams(search + (search && hq ? "&" : "") + hq);
}

async function route() {
  const path = currentPath();
  const loader = PAGES[path];
  if (!loader) {
    els("[data-nav],[data-mnav]").forEach((a) => a.classList.remove("on"));
    if (current.destroy) { try { current.destroy(); } catch { /* page cleans itself up */ } }
    current = { destroy: null, path };
    el("#page").innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%">
      <div class="card card-pad" style="max-width:380px">
        <h1 class="page-title" style="font-size:22px">404 Page Not Found</h1>
        <p class="sub" style="margin-top:6px">Did you forget to add the page to the router?</p>
        <a class="btn primary" href="#/" style="margin-top:14px;display:inline-flex">‹ Back to the map</a>
      </div></div>`;
    return;
  }
  els("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === path));
  els("[data-mnav]").forEach((a) => a.classList.toggle("on", a.dataset.mnav === path));
  if (current.destroy) { try { current.destroy(); } catch {} }
  const page = el("#page");
  page.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%"><span class="spin"></span></div>`;
  try {
    const mod = await loader();
    page.innerHTML = "";
    current = { destroy: (await mod.mount(page, { params: queryParams() }))?.destroy ?? null, path };
  } catch (err) {
    console.error(err);
    page.innerHTML = `<div style="padding:40px" class="scroll"><h1 class="page-title">Something broke</h1><p class="sub">${h(String(err?.message ?? err))}</p></div>`;
  }
}

if (!window.location.hash) window.location.hash = "#/";
shell();
window.addEventListener("hashchange", route);
route();
