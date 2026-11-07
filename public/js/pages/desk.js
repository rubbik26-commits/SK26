// My Desk — your private workspace: pipeline, watchlist, recent canvass,
// the debt-maturity wall across everything you track, and report branding.
// Account-backed (cre_watchlist / cre_pipeline / cre_canvass / cre_profiles);
// the browser copy is only a cache. Signed-in only.
import { api, apiSend, desk, saveDesk } from "../api.js";
import * as auth from "../auth.js";
import { el, els, h, toast, openModal } from "../ui.js";
import { num, usd, exportCsv } from "../lib/format.js";

const STAGES = ["Lead", "Contacted", "Meeting", "Pitched", "Under Contract", "Closed", "Passed"];
const BRAND_FIELDS = [
  ["brand_name", "Brand / firm name", "Shown on covers & footers"],
  ["display_name", "Your name", "Signature line on the BOV"],
  ["contact_line", "Contact line", "e.g. Jane Roe · jane@firm.com"],
  ["license_state", "License state", "NY"],
  ["license_number", "License number", ""],
  ["logo_url", "Logo URL", "White-on-transparent works best"],
  ["primary_color", "Primary color", "#0E1F33"],
  ["accent_color", "Accent color", "#B08D42"]
];

export async function mount(root) {
  root.innerHTML = `<div class="scroll" style="height:100%"><div style="max-width:960px;margin:0 auto;padding:22px 18px 70px" id="dk"></div></div>`;
  const u = await auth.me();
  if (!u.signedIn) {
    el("#dk").innerHTML = `
      <div class="eyebrow">My Desk</div>
      <h1 class="page-title">Your private workspace</h1>
      <div class="card card-pad" style="margin-top:14px;max-width:520px">
        <b style="font-size:13.5px">Sign in (left sidebar) to use My Desk.</b>
        <p class="sub" style="margin-top:6px">Your watchlist, pipeline, canvass log and report branding are private to your account (row-level security) and sync across devices. Create an account with just an email and password.</p>
      </div>`;
    const onAuth = () => mount(root);
    window.addEventListener("authchange", onAuth, { once: true });
    return { destroy() { window.removeEventListener("authchange", onAuth); } };
  }

  let data = { watchlist: [], pipeline: [], canvass: [], profile: { display_name: "", brand: {} } };
  async function load() {
    const [w, p, c, prof] = await Promise.all([
      api("/api/watchlist", { fresh: true }).catch(() => ({ watchlist: [] })),
      api("/api/pipeline", { fresh: true }).catch(() => ({ pipeline: [] })),
      api("/api/canvass", { fresh: true }).catch(() => ({ canvass: [] })),
      api("/api/profile", { fresh: true }).catch(() => ({ display_name: "", brand: {} }))
    ]);
    data = {
      watchlist: w.watchlist ?? [],
      pipeline: (p.pipeline ?? []).filter((r) => r.bbl), // parcel deals; kanban opp rows live on the Pipeline page
      canvass: c.canvass ?? [],
      profile: prof
    };
    // Cache to the browser so reports and offline views keep working (item 45).
    const d = desk();
    d.name = prof.display_name ?? d.name;
    d.brand = prof.brand ?? d.brand;
    d.watchlist = data.watchlist.map((x) => ({ bbl: x.bbl, address: x.address }));
    d.pipeline = data.pipeline.map((x) => ({ bbl: x.bbl, address: x.address, owner: x.owner, stage: x.stage, propensity: x.propensity, assessed: x.assessed, lastSale: x.last_sale }));
    d.canvass = data.canvass;
    saveDesk(d);
  }
  await load();
  render();

  function render() {
    const { watchlist, pipeline, canvass, profile } = data;
    el("#dk").innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div><div class="eyebrow">My Desk</div>
        <h1 class="page-title">Your private workspace</h1>
        <p class="sub">${h(profile.display_name || u.email)} · private to you · synced to your account</p></div>
        <button class="btn sm" id="dk-export" ${pipeline.length ? "" : "disabled"}>Export pipeline CSV</button>
      </div>

      <div class="sect-head"><span class="t">Pipeline</span><span class="s">${pipeline.length} deal${pipeline.length === 1 ? "" : "s"}</span></div>
      ${pipeline.length ? `<div class="table-wrap card"><table class="tbl">
        <thead><tr><th>Address</th><th>Owner</th><th>Stage</th><th class="r">Propensity</th><th class="r">Assessed</th><th class="r">Last sale</th><th></th></tr></thead>
        <tbody>${pipeline.map((r) => `<tr>
          <td><a href="#/dossier?bbl=${r.bbl}&addr=${encodeURIComponent(r.address ?? "")}">${h(r.address || `BBL ${r.bbl}`)}</a>
            ${(r.stageHistory ?? []).length > 1 ? `<div class="note">${r.stageHistory.length} stage moves · since ${String(r.created_at ?? "").slice(0, 10)}</div>` : ""}</td>
          <td class="note" style="max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(r.owner || "—")}</td>
          <td><select class="field" data-stage="${r.id}" style="padding:4px 7px;font-size:11px;width:auto">${STAGES.map((s) => `<option ${r.stage === s ? "selected" : ""}>${s}</option>`).join("")}</select></td>
          <td class="r">${r.propensity ?? "—"}</td><td class="r">${usd(r.assessed)}</td><td class="r">${usd(r.last_sale)}</td>
          <td class="r"><button class="btn sm" data-del-pipe="${r.id}">✕</button></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="card" style="border-style:dashed;padding:22px;text-align:center"><p class="sub">No deals yet. Open a parcel and hit <b>Add to Pipeline</b>.</p></div>`}

      <div class="sect-head"><span class="t">Watchlist</span><span class="s">${watchlist.length}</span></div>
      ${watchlist.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px">
        ${watchlist.map((w) => `<div class="card" style="padding:10px 13px;display:flex;justify-content:space-between;gap:8px;align-items:center">
          <a href="#/dossier?bbl=${w.bbl}&addr=${encodeURIComponent(w.address ?? "")}" style="font-weight:650;font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(w.address || `BBL ${w.bbl}`)}</a>
          <button class="btn sm" data-del-watch="${w.id}">✕</button></div>`).join("")}</div>`
        : `<div class="card" style="border-style:dashed;padding:22px;text-align:center"><p class="sub">Nothing watched yet — hit <b>☆ Watch</b> on any dossier.</p></div>`}

      <div class="sect-head"><span class="t">Maturity wall</span><span class="s">loans nearest maturity first — refi/sale pressure</span></div>
      <div id="dk-wall"><div class="card" style="border-style:dashed;padding:18px;text-align:center"><p class="sub">Watch or pipeline a few parcels and their recorded debt shows up here, soonest balloon first.</p></div></div>

      <div class="sect-head"><span class="t">Report branding</span><span class="s">covers, footers &amp; signature on the BOV / OM / Deck</span></div>
      <div class="card card-pad">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:9px">
          ${BRAND_FIELDS.map(([k, label, ph]) => `<label class="lab">${label}<input class="field" data-brand="${k}" value="${h(k === "display_name" ? (profile.brand?.display_name ?? profile.display_name ?? "") : profile.brand?.[k] ?? "")}" placeholder="${h(ph)}" /></label>`).join("")}
        </div>
        <label class="lab" style="display:block;margin-top:9px">Custom disclaimer (optional — a standard confidentiality block is used otherwise)
          <textarea class="field" data-brand="disclaimer" rows="2">${h(profile.brand?.disclaimer ?? "")}</textarea></label>
        <p class="note" style="margin-top:7px">Saved to your account and applied the next time you generate a document from the Deal Calculator.</p>
      </div>

      <div class="sect-head"><span class="t">Recent canvass</span><span class="s">your private touch history — calls, doors, emails, meetings</span></div>
      ${canvass.length ? `<div style="display:grid;gap:6px">${canvass.slice(0, 40).map((c) => `
        <div class="card" style="padding:9px 12px;display:flex;gap:9px;align-items:flex-start">
          <span class="badge" style="background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent-line)">${h(c.type)}</span>
          <div style="min-width:0;flex:1">
            <a href="#/dossier?bbl=${c.bbl}&addr=${encodeURIComponent(c.address ?? "")}" style="font-weight:650;font-size:12.5px">${h(c.address || `BBL ${c.bbl}`)}</a>
            ${c.note ? `<p style="margin:2px 0 0;font-size:12px">${h(c.note)}</p>` : ""}
            ${c.outcome ? `<p class="note" style="margin:2px 0 0">Outcome: ${h(c.outcome)}</p>` : ""}
            <p class="note" style="margin:2px 0 0">${new Date(c.at).toLocaleString()}${c.follow ? ` · follow up ${c.follow}` : ""}</p>
          </div></div>`).join("")}</div>`
        : `<div class="card" style="border-style:dashed;padding:22px;text-align:center"><p class="sub">No touches logged yet. Log calls, doors and meetings from any parcel dossier.</p></div>`}

      <div class="card card-pad" style="margin-top:22px;border-color:color-mix(in srgb, var(--red) 35%, var(--line))">
        <b style="font-size:13px">Danger zone</b>
        <p class="sub" style="margin-top:5px">Permanently delete your account and everything saved to it — pipeline, watchlist, canvass logs, profile. This cannot be undone.</p>
        <button class="btn sm" id="dk-del-acct" style="margin-top:9px;color:var(--red);border-color:currentColor">Delete account…</button>
      </div>`;

    els("[data-stage]").forEach((s) => s.addEventListener("change", async () => {
      try { await fetch(`/api/pipeline/${s.dataset.stage}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: s.value }) }); }
      catch { toast("Could not save the stage."); }
    }));
    els("[data-del-pipe]").forEach((b) => b.addEventListener("click", async () => {
      await fetch(`/api/pipeline/${b.dataset.delPipe}`, { method: "DELETE" }).catch(() => null);
      await load(); render();
    }));
    els("[data-del-watch]").forEach((b) => b.addEventListener("click", async () => {
      await fetch(`/api/watchlist/${b.dataset.delWatch}`, { method: "DELETE" }).catch(() => null);
      await load(); render();
    }));
    els("[data-brand]").forEach((inp) => inp.addEventListener("change", async () => {
      const brand = { ...(data.profile.brand ?? {}) };
      brand[inp.dataset.brand] = inp.value.trim();
      data.profile.brand = brand;
      try {
        await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand }) });
        const d = desk(); d.brand = brand; saveDesk(d);
        toast("Branding saved");
      } catch { toast("Could not save branding."); }
    }));
    el("#dk-del-acct").addEventListener("click", () => {
      const veil = openModal("Delete account…", `
        <p style="font-size:13px;line-height:1.6">Permanently delete your account and everything saved to it — pipeline, watchlist, canvass logs, profile. This cannot be undone.</p>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
          <button class="btn" data-keep>Keep account</button>
          <button class="btn" data-del-yes style="background:var(--red);border-color:var(--red);color:#fff">Delete account…</button>
        </div>`);
      veil.querySelector("[data-keep]").addEventListener("click", () => veil.remove());
      veil.querySelector("[data-del-yes]").addEventListener("click", async () => {
        try {
          await auth.deleteAccount();
          localStorage.removeItem("nyc-intel-desk-v1");
          localStorage.removeItem("nyc-intel-desk-imported");
          veil.remove();
          toast("Account deleted");
          mount(root);
        } catch (e2) { toast(e2.message || "Deletion failed — nothing was removed."); }
      });
    });
    loadWall();
    el("#dk-export")?.addEventListener("click", () => exportCsv("my_pipeline", [
      { header: "Address", value: (r) => r.address }, { header: "BBL", value: (r) => r.bbl },
      { header: "Owner", value: (r) => r.owner ?? "" }, { header: "Stage", value: (r) => r.stage },
      { header: "Propensity", value: (r) => r.propensity ?? "" }, { header: "Assessed", value: (r) => r.assessed ?? "" },
      { header: "Last sale", value: (r) => r.last_sale ?? "" }
    ], data.pipeline));
  }

  async function loadWall() {
    const bbls = [...new Set([...data.pipeline, ...data.watchlist].map((r) => String(r.bbl || "").replace(/[^0-9]/g, "")).filter((b) => b.length === 10))];
    if (!bbls.length) return;
    try {
      const wall = await api(`/api/maturity-wall?bbls=${bbls.join(",")}`, { fresh: true });
      if (!wall.loans?.length) {
        el("#dk-wall").innerHTML = `<div class="card" style="border-style:dashed;padding:18px;text-align:center"><p class="sub">No recorded mortgages found on the parcels you track.</p></div>`;
        return;
      }
      const stCol = (s) => s === "past" ? "var(--red)" : s === "approaching" ? "var(--amber)" : "var(--ink-faint)";
      const stLabel = (s) => s === "past" ? "Past est. maturity" : s === "approaching" ? "Approaching" : "Seasoned";
      el("#dk-wall").innerHTML = `<div class="table-wrap card"><table class="tbl">
        <thead><tr><th>Matures</th><th>Address</th><th>Owner</th><th>Lender</th><th class="r">Recorded amount</th><th>Originated</th><th></th></tr></thead>
        <tbody>${wall.loans.map((l) => `<tr>
          <td><b class="tabular">${l.estMaturityYear}</b> <span class="badge" style="color:${stCol(l.status)};border-color:currentColor;margin-left:5px">${stLabel(l.status)}</span></td>
          <td><a href="#/dossier?bbl=${l.bbl}&addr=${encodeURIComponent(l.address ?? "")}">${h(l.address || `BBL ${l.bbl}`)}</a></td>
          <td class="note" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(l.owner || "—")}</td>
          <td class="note">${h(l.lender || "—")}</td>
          <td class="r">${usd(l.amount)}</td><td class="note">${h(l.originated || "—")}</td>
          <td class="r"><a class="btn sm" href="#/dossier?bbl=${l.bbl}">Dossier</a></td></tr>`).join("")}</tbody></table></div>
        <p class="note" style="margin-top:6px">Assumes a ~10-year term from each recording — confirm the actual maturity in the mortgage document before positioning.</p>`;
    } catch { /* wall is additive — desk still works without it */ }
  }
  return {};
}
