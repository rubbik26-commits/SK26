// Pipeline / CRM — kanban over the curated universe; stage transitions
// persist to your account (cre_pipeline) and sync across devices.
import { api, apiSend, invalidate } from "../api.js";
import * as auth from "../auth.js";
import { el, els, h, scorePill, categoryBadge, toast, enhanceHScroll } from "../ui.js";

const STAGES = ["Watchlist", "Contacted", "Diligence", "Offer", "Closed"];
const DEFAULT_STAGE = { "MR-001": "Diligence", "MR-005": "Contacted", "QN-001": "Diligence", "BK-001": "Contacted", "MR-003": "Offer" };

export async function mount(root) {
  const u = await auth.me();
  const [seeds, saved] = await Promise.all([
    api("/api/opportunities"),
    u.signedIn ? api("/api/pipeline", { fresh: true }).catch(() => ({ pipeline: [] })) : Promise.resolve({ pipeline: [] })
  ]);
  const rows = saved.pipeline ?? [];
  const stageOf = (id) => rows.find((r) => (r.oppId ?? r.opp_id) === id)?.stage ?? DEFAULT_STAGE[id] ?? "Watchlist";
  const stages = new Map(seeds.map((p) => [p.id, stageOf(p.id)]));

  root.innerHTML = `<div style="display:flex;flex-direction:column;height:100%">
    <div style="padding:14px 18px;border-bottom:1px solid var(--line)">
      <div class="eyebrow">Pipeline / CRM</div>
      <h1 class="page-title" style="font-size:17px">Move sites across stages</h1>
      <p class="sub">Move sites across stages — transitions persist to the backend. Use the arrows to advance or regress a deal.${u.signedIn ? "" : ` <b>Sign in (left sidebar) to save stage changes — they're private to your account.</b>`}</p>
    </div>
    <div class="scroll" style="flex:1;overflow-x:auto" id="kb-scroll"><div class="kanban" id="kb"></div></div>
  </div>`;
  enhanceHScroll(el("#kb-scroll"));

  function render() {
    el("#kb").innerHTML = STAGES.map((stage) => {
      const cards = seeds.filter((p) => stages.get(p.id) === stage);
      return `<div class="kan-col">
        <header><span>${h(stage)}</span><span class="tabular" style="color:var(--ink-faint)">${cards.length}</span></header>
        <div class="kan-cards scroll">
          ${cards.map((p) => `
            <div class="card" style="padding:10px 11px">
              <a style="display:flex;gap:9px;text-decoration:none;color:inherit" href="#/dossier?bbl=${p.bbl.replace(/[^0-9]/g, "")}&addr=${encodeURIComponent(p.address)}">
                ${scorePill(p.opportunityScore, 28)}
                <div style="min-width:0"><div style="font-size:12px;font-weight:650;line-height:1.25">${h(p.address)}</div>
                <div class="note" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h(p.neighborhood)}</div></div>
              </a>
              <div style="margin-top:7px">${categoryBadge(p.category, true)}</div>
              <p class="note" style="margin:6px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${h(p.nextAction)}</p>
              <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:7px;border-top:1px solid var(--line-soft)">
                <button class="btn sm" data-move="${p.id}|-1" ${stage === STAGES[0] ? "disabled" : ""}>‹ Back</button>
                <button class="btn sm ghost" data-move="${p.id}|1" ${stage === STAGES[STAGES.length - 1] ? "disabled" : ""}>Advance ›</button>
              </div>
            </div>`).join("") || `<p class="note" style="text-align:center;padding:14px 0">Empty</p>`}
        </div>
      </div>`;
    }).join("");
    els("[data-move]").forEach((b) => b.addEventListener("click", async () => {
      const [id, dir] = b.dataset.move.split("|");
      const cur = stages.get(id);
      const next = STAGES[Math.min(STAGES.length - 1, Math.max(0, STAGES.indexOf(cur) + Number(dir)))];
      if (next === cur) return;
      if (!auth.isSignedIn()) return toast("Sign in (left sidebar) to save stage changes — they're private to your account.");
      const seed = seeds.find((s) => s.id === id);
      stages.set(id, next);
      render();
      try { await apiSend("/api/pipeline", "POST", { oppId: id, stage: next, address: seed?.address ?? "", bbl: "" }); invalidate("/api/pipeline"); }
      catch { toast("Could not save stage"); }
    }));
  }
  render();
  return {};
}
