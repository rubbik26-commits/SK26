// Investors — buy-box pool. Define each investor's criteria; parcels
// auto-match against the pool in the dossier and Deal Radar.
import { api, apiSend, invalidate } from "../api.js";
import { el, els, h, toast } from "../ui.js";

const ASSET_CLASSES = ["Multifamily", "Mixed-use", "Development / Land", "Office", "Retail", "Hotel", "Industrial / Warehouse", "1–3 Family / Townhouse", "Condo", "Co-op"];
const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];

export async function mount(root) {
  let pool = [];
  try {
    pool = (await api("/api/investors", { fresh: true })).investors ?? [];
  } catch (err) {
    root.innerHTML = `<div class="scroll" style="height:100%"><div style="max-width:640px;margin:0 auto;padding:22px 18px">
      <div class="eyebrow">Owner-private</div>
      <h1 class="page-title">Investor buy boxes</h1>
      <div class="card card-pad" style="margin-top:14px">
        <b style="font-size:13.5px">The investor pool is private to the account owner.</b>
        <p class="sub" style="margin-top:6px">${String(err?.message ?? "").includes("401") ? "Sign in (left sidebar) with the owner account to manage the pool." : "Your account doesn't have owner access to this page."}</p>
      </div></div></div>`;
    const onAuth = () => mount(root);
    window.addEventListener("authchange", onAuth, { once: true });
    return { destroy() { window.removeEventListener("authchange", onAuth); } };
  }
  let dirty = false;
  root.innerHTML = `<div class="scroll" style="height:100%"><div style="max-width:760px;margin:0 auto;padding:22px 18px 70px" id="iv"></div></div>`;
  render();

  function blank() {
    return { id: `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, name: "", firm: "", email: "", phone: "", buyBox: { assetClasses: [], boroughs: [], priceMin: null, priceMax: null, unitsMin: null, unitsMax: null, notes: "" } };
  }
  function render() {
    el("#iv").innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div><div class="eyebrow">Owner-private</div>
        <h1 class="page-title">Investor buy boxes</h1>
        <p class="sub" style="max-width:560px">Define each investor's criteria. Open any parcel's dossier and it auto-matches against this pool with a BD outreach angle. Only you can see this.</p></div>
        <button class="btn primary" id="iv-save" ${dirty ? "" : "disabled"}>${dirty ? "Save pool" : "Saved"}</button>
      </div>
      <div style="display:grid;gap:14px;margin-top:16px" id="iv-list">
        ${pool.length ? pool.map((inv, i) => card(inv, i)).join("") : `<div class="card" style="border-style:dashed;padding:30px;text-align:center"><p class="sub">No investors yet. Add your first buy box.</p></div>`}
      </div>
      <button class="btn" id="iv-add" style="margin-top:12px">＋ Add investor</button>`;
    el("#iv-add").addEventListener("click", () => { pool.push(blank()); dirty = true; render(); });
    el("#iv-save").addEventListener("click", async () => {
      try { await apiSend("/api/investors", "POST", { investors: pool }); invalidate("/api/investors"); dirty = false; render(); toast("Pool saved"); }
      catch { toast("Save failed"); }
    });
    els("[data-f]").forEach((inp) => inp.addEventListener("input", () => {
      const [i, key] = inp.dataset.f.split("|");
      pool[+i][key] = inp.value; dirty = true; el("#iv-save").disabled = false; el("#iv-save").textContent = "Save pool";
    }));
    els("[data-bb]").forEach((inp) => inp.addEventListener("input", () => {
      const [i, key] = inp.dataset.bb.split("|");
      const v = parseInt(inp.value.replace(/[^0-9]/g, ""), 10);
      pool[+i].buyBox[key] = Number.isFinite(v) ? v : null; dirty = true; el("#iv-save").disabled = false; el("#iv-save").textContent = "Save pool";
    }));
    els("[data-notes]").forEach((inp) => inp.addEventListener("input", () => {
      pool[+inp.dataset.notes].buyBox.notes = inp.value;
      dirty = true; el("#iv-save").disabled = false; el("#iv-save").textContent = "Save pool";
    }));
    els("[data-chip]").forEach((b) => b.addEventListener("click", () => {
      const [i, key, val] = b.dataset.chip.split("|");
      const arr = pool[+i].buyBox[key] ?? [];
      pool[+i].buyBox[key] = arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
      dirty = true; render();
    }));
    els("[data-del]").forEach((b) => b.addEventListener("click", () => { pool.splice(+b.dataset.del, 1); dirty = true; render(); }));
  }
  function card(inv, i) {
    return `<div class="card card-pad">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="field" data-f="${i}|name" placeholder="Investor name" value="${h(inv.name)}" style="flex:1;min-width:150px;font-weight:650" />
        <input class="field" data-f="${i}|firm" placeholder="Firm" value="${h(inv.firm ?? "")}" style="flex:1;min-width:130px" />
        <button class="btn sm" data-del="${i}">✕</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <input class="field" data-f="${i}|email" placeholder="Email" value="${h(inv.email ?? "")}" style="flex:1;min-width:170px" />
        <input class="field" data-f="${i}|phone" placeholder="Phone" value="${h(inv.phone ?? "")}" style="flex:1;min-width:130px" />
      </div>
      <p class="eyebrow dim" style="margin:11px 0 5px">Asset classes</p>
      <div style="display:flex;flex-wrap:wrap;gap:5px">${ASSET_CLASSES.map((c) => `<button class="chip ${inv.buyBox.assetClasses?.includes(c) ? "on" : ""}" data-chip="${i}|assetClasses|${h(c)}" style="font-size:10.5px;padding:3px 10px">${h(c)}</button>`).join("")}</div>
      <p class="eyebrow dim" style="margin:10px 0 5px">Boroughs</p>
      <div style="display:flex;flex-wrap:wrap;gap:5px">${BOROUGHS.map((c) => `<button class="chip ${inv.buyBox.boroughs?.includes(c) ? "on" : ""}" data-chip="${i}|boroughs|${c}" style="font-size:10.5px;padding:3px 10px">${c}</button>`).join("")}</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px">
        <label class="lab">Price min<input class="field" data-bb="${i}|priceMin" placeholder="$" value="${inv.buyBox.priceMin ?? ""}" /></label>
        <label class="lab">Price max<input class="field" data-bb="${i}|priceMax" placeholder="$" value="${inv.buyBox.priceMax ?? ""}" /></label>
        <label class="lab">Units min<input class="field" data-bb="${i}|unitsMin" value="${inv.buyBox.unitsMin ?? ""}" /></label>
        <label class="lab">Units max<input class="field" data-bb="${i}|unitsMax" value="${inv.buyBox.unitsMax ?? ""}" /></label>
      </div>
      <label class="lab" style="margin-top:8px;display:block">Notes<input class="field" placeholder="Notes — strategy, hold period, structure preferences…" value="${h(inv.buyBox.notes ?? "")}" data-notes="${i}" /></label>
    </div>`;
  }
  return {};
}
