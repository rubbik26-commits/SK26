// Global/gate-only maturity wall using the same ACRIS Cross References evidence
// standard as the signed-in My Desk wall. A later satisfaction elsewhere on the
// parcel is not enough to discharge a specific mortgage: the satisfaction must
// actually be linked to that mortgage in ACRIS References.
import { Router } from "express";
import { fullAcrisByLot } from "./adapters/acris-full.js";
import { liveBuilding } from "./live.js";
import { liveOpportunities, curatedAsParcels } from "./opps-live.js";
import { estimateDebtMaturity } from "./scoring.js";
import { loanRow } from "./production-maturity.js";

const router = Router();
const TTL = 6 * 60 * 60 * 1000;
let cache = { at: 0, value: null };

async function buildWall() {
  const live = await liveOpportunities().catch(() => null);
  let parcels;
  if (live?.length) parcels = live;
  else if (process.env.ALLOW_DEMO_FALLBACK === "1") parcels = curatedAsParcels();
  else parcels = [];

  const bbls = [...new Set(parcels.map((p) => String(p.bbl || "").replace(/[^0-9]/g, "")).filter((b) => /^[1-5]\d{9}$/.test(b)))].slice(0, 25);
  if (!bbls.length) {
    return { configured: false, count: 0, loans: [], provenance: "unavailable", checked: 0, note: "No live parcel universe was available for the maturity wall." };
  }

  const loans = [];
  const unresolvedSatisfaction = [];
  let acrisFailures = 0;
  let verifiedParcels = 0;

  for (const bbl of bbls) {
    const [acris, building] = await Promise.all([
      fullAcrisByLot(bbl).catch((e) => ({ live: false, error: e?.message || String(e) })),
      liveBuilding(bbl).catch(() => null)
    ]);
    if (!acris?.live) {
      acrisFailures += 1;
      continue;
    }
    if (acris.referenceStatus !== "live") {
      unresolvedSatisfaction.push(bbl);
      continue;
    }
    verifiedParcels += 1;

    // financingTimeline is newest-first. Keep every recorded mortgage whose
    // own ACRIS reference set contains no linked satisfaction/release. Do not
    // infer discharge from an unrelated later SAT document on the same parcel.
    for (const mortgage of acris.financingTimeline.filter((d) =>
      d.kind === "mortgage" && (d.amount || 0) > 0 && !d.linkedSatisfactions?.length
    )) {
      const date = mortgage.recordedDate || mortgage.documentDate || null;
      const lender = mortgage.party2?.join("; ") || "—";
      const est = estimateDebtMaturity({
        loans: [{ date, amount: mortgage.amount || 0, docType: "MORTGAGE", lender }]
      }, new Date().getUTCFullYear());
      if (!est?.estMaturityYear) continue;
      const row = loanRow({
        bbl,
        owner: mortgage.party1?.join("; ") || building?.owner || "—",
        address: building?.address || `BBL ${bbl}`,
        lender,
        amount: mortgage.amount || 0,
        originated: date,
        estMaturityYear: est.estMaturityYear
      });
      row.documentId = mortgage.documentId;
      row.referenceStatus = "live";
      row.satisfactionStatus = "no_linked_satisfaction_returned";
      loans.push(row);
    }
  }

  loans.sort((a, b) => a.daysToMaturity - b.daysToMaturity);
  const visible = loans.filter((l) => l.daysToMaturity >= -365).slice(0, 12);
  return {
    configured: verifiedParcels > 0,
    count: visible.length,
    loans: visible,
    provenance: acrisFailures === bbls.length ? "unavailable" : "live",
    checked: bbls.length,
    verifiedParcels,
    estimated: true,
    methodology: "Each modeled row begins with an ACRIS mortgage whose own Cross References set returned successfully and contains no linked satisfaction/release. Maturity is then estimated from the mortgage recording date using the same typical-term model as My Desk. A satisfaction on some other mortgage on the parcel does not discharge this row.",
    estimatedFields: ["maturity", "daysToMaturity", "balance", "payoffBalance"],
    ...(unresolvedSatisfaction.length ? {
      unresolvedSatisfaction: {
        bbls: unresolvedSatisfaction,
        count: unresolvedSatisfaction.length,
        reason: "ACRIS Cross References did not answer for these parcels, so their mortgages were omitted rather than guessed outstanding or satisfied."
      }
    } : {}),
    note: "ACRIS does not publish contractual maturity, current payoff balance or a complete loan-term schedule. Only recorded mortgage principal is a published amount; all maturity timing remains explicitly modeled."
  };
}

router.get("/api/maturity-wall", async (req, res, next) => {
  if (/^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""))) return next();
  try {
    if (cache.value && Date.now() - cache.at < TTL) return res.json({ ...cache.value, cached: true });
    const value = await buildWall();
    cache = { at: Date.now(), value };
    return res.status(value.provenance === "unavailable" ? 503 : 200).json(value);
  } catch (e) {
    return res.status(503).json({ configured: false, count: 0, loans: [], provenance: "unavailable", error: "maturity_wall_unavailable", message: e?.message || "Maturity wall unavailable." });
  }
});

export { buildWall as buildLinkedMaturityWall };
export default router;
