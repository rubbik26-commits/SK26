// Source Registry — the public records, live systems, and planning sources
// that power the validation workflow, plus integration status.
import { api } from "../api.js";
import { el, h, spinner } from "../ui.js";

export async function mount(root) {
  root.innerHTML = `<div class="scroll" style="height:100%"><div style="max-width:880px;margin:0 auto;padding:22px 18px 70px" id="src">${spinner()}</div></div>`;
  let sources;
  try {
    sources = await api("/api/sources", { fresh: true });
  } catch {
    el("#src").innerHTML = `
      <div class="eyebrow">Source Registry</div>
      <h1 class="page-title">Public records, live systems &amp; planning sources</h1>
      <div class="card card-pad" style="margin-top:14px;max-width:520px">
        <b style="font-size:13.5px">This page is private to the account owner.</b>
        <p class="sub" style="margin-top:6px">Sign in (left sidebar) with the owner account to view integration status and the source registry.</p>
      </div>`;
    const onAuth = () => mount(root);
    window.addEventListener("authchange", onAuth, { once: true });
    return { destroy() { window.removeEventListener("authchange", onAuth); } };
  }
  const [pinecone, maps] = await Promise.all([
    api("/api/pinecone-status").catch(() => ({ configured: false })),
    api("/api/maps-usage").catch(() => ({ configured: false }))
  ]);
  el("#src").innerHTML = `
    <div class="eyebrow">Source Registry</div>
    <h1 class="page-title">Public records, live systems & planning sources</h1>
    <p class="sub" style="max-width:700px">These power the validation workflow. Exact-address targets must reconcile across parcel, permit, ownership, zoning, housing, environmental, flood, and policy-incentive checks before they become acquisition-grade records.</p>

    <div class="card card-pad" style="margin:16px 0 10px">
      <b style="font-size:13px">Integrations</b>
      <div style="display:grid;gap:7px;margin-top:9px">
        <div class="kv"><span class="k">Basemap imagery (CARTO / OSM / Esri)</span><span class="v" style="color:var(--green)">Proxied · free tier</span></div>
        <div class="kv"><span class="k">Street View</span><span class="v" style="color:${maps.configured ? "var(--green)" : "var(--ink-faint)"}">${maps.configured ? `Connected${maps.used != null ? ` · ${maps.used} pulls` : ""}` : "Add GOOGLE_MAPS_KEY to enable"}</span></div>
        <div class="kv"><span class="k">Aerial (static) maps</span><span class="v" style="color:var(--green)">Proxied · free (Esri export)</span></div>
        <div class="kv"><span class="k">AI vector search (Pinecone)</span><span class="v" style="color:${pinecone.configured ? "var(--green)" : "var(--ink-faint)"}">${pinecone.configured ? "Connected" : "Add PINECONE_API_KEY to enable"}</span></div>
        ${pinecone.configured ? "" : `<p class="note" style="margin:2px 0 0;padding-left:2px">Add <span class="mono">PINECONE_API_KEY</span> (paste your key). Then send the index <b>Host</b> (from the index page); set <span class="mono">PINECONE_INDEX_HOST</span> as a var and restart.</p>`}
        <div class="kv"><span class="k">Listing detection (web search)</span><span class="v" style="color:var(--ink-faint)">Add SERPER_API_KEY / Google CSE to enable</span></div>
        <p class="note" style="margin:2px 0 0;padding-left:2px">Inline listing detection turns on once a free Google Programmable Search key is added (GOOGLE_CSE_KEY + GOOGLE_CSE_CX).</p>
        <div class="kv"><span class="k">Live NYC Open Data (Socrata)</span><span class="v" style="color:var(--ink-faint)">Demo engine active — swap adapters in server/citymodel.js</span></div>
      </div>
    </div>

    <div style="display:grid;gap:10px">
      ${sources.map((s) => `
        <div class="card card-pad">
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div><b style="font-size:13.5px">${h(s.name)}</b><p class="note" style="margin:2px 0 0">${h(s.publisher)} · Updated ${h(s.updated)}</p></div>
          </div>
          <div class="callout blue" style="margin-top:9px;padding:9px 12px"><span class="eyebrow" style="display:block;margin-bottom:2px">Powers</span><span style="font-size:12px">${h(s.powers)}</span></div>
          <ul style="margin:9px 0 0;padding-left:16px;display:grid;gap:4px">${s.facts.map((f) => `<li style="font-size:12px;line-height:1.5">${h(f)}</li>`).join("")}</ul>
        </div>`).join("")}
    </div>
    <p class="note" style="margin-top:14px">Validation posture: current records are public-data-shaped seed targets. Exact addresses are live-ready for reconciliation; corridor, vicinity, and assemblage records require precise BBLs before they can be treated as verified opportunities.</p>`;
  return {};
}
