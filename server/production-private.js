// Private exact-frontend API routes that require the propagated Supabase bearer.
import { Router } from "express";
import { requireUser, supabaseFetch } from "./production-api.js";
import { fullAcrisByLot } from "./adapters/acris-full.js";
import { liveBuilding } from "./live.js";
import { estimateDebtMaturity } from "./scoring.js";
import { loanRow } from "./production-maturity.js";
import { bblFromOppId as authorityBblFromOppId } from "./authority-release.js";

const router = Router();
const digits = (v) => String(v ?? "").replace(/[^0-9]/g, "");
const KANBAN_STAGES = new Set(["Watchlist", "Diligence", "Contact Owner", "Model Conversion", "IC Memo", "Active Pursuit"]);
const cleanOppId = (v) => String(v ?? "").trim().slice(0, 160);
const validStage = (v) => KANBAN_STAGES.has(String(v ?? "")) ? String(v) : null;

// cre_pipeline.bbl is what /api/maturity-wall selects on
// (`bbl=not.is.null`), but nothing ever wrote it: the POST and PATCH handlers
// persisted user_id / opp_id / stage / metadata only, so the column stayed
// null on every row and the signed-in wall queried an always-empty set. A user
// could fill their kanban and My Desk would still report "No parcel pipeline
// records."
//
// The compiled frontend sends `{oppId, stage}` and nothing else — it cannot be
// changed — so the BBL has to come out of the opportunity id. Live parcels are
// keyed "LIVE-" + the ten-digit BBL (server/opps-live.js), which is the entire
// production universe; the seeded MR-### ids carry no BBL and only exist in a
// demo build, where curatedAsParcels() is gated behind assertSyntheticAllowed.
// A null return means "this id does not encode a parcel", which is a truthful
// null rather than a guess.
//
// ONE RULE, NOT TWO THAT DISAGREE
//
// server/authority-release.js grew its own bblFromOppId and, being mounted
// ahead of this router, is the one that actually answers /api/pipeline. A
// second local copy here diverged from it on seven of eleven inputs — most
// importantly the hyphenated "1-00835-0041" form the seed parcels use, which
// that implementation resolves and this one rejected. Two functions deciding
// which parcel a saved card refers to, disagreeing, is precisely how a row gets
// a BBL through one path and not the other.
//
// The authoritative implementation is imported rather than reimplemented, so
// this fallback path and the live path can never answer differently. `|| null`
// preserves this module's contract of returning null rather than "" for "this
// id does not encode a parcel".
export function bblFromOppId(oppId) {
  return authorityBblFromOppId(oppId) || null;
}

// ---------------------------------------------------------------- exact Pipeline / CRM
// /api/pipeline is two endpoints sharing a pathname. Without `zips` it is the
// signed-in user's kanban. With `zips` it is the public DOB development
// pipeline for an area, which no one has to be signed in to read — requiring a
// user here answered 401 to an anonymous market report instead of the feed.
const isDevelopmentFeed = (req) => req.query.zips !== undefined;

router.get("/api/pipeline", (req, res, next) => (isDevelopmentFeed(req) ? next("router") : next()), requireUser, async (req, res) => {
  try {
    const uid = req.productionUser.id;
    const rows = await supabaseFetch(
      `/rest/v1/cre_pipeline?select=opp_id,stage,updated_at,bbl&user_id=eq.${encodeURIComponent(uid)}&opp_id=not.is.null&order=updated_at.desc`,
      { token: req.productionUser.token }
    );
    // bbl is additive — the compiled frontend reads oppId/stage and ignores the
    // rest — and it makes the column the maturity wall depends on inspectable
    // without a database session.
    return res.json((Array.isArray(rows) ? rows : []).map((r) => ({
      oppId: r.opp_id, stage: r.stage, updatedAt: r.updated_at, bbl: r.bbl ?? null
    })));
  } catch (e) {
    return res.status(502).json({ error: "pipeline_unavailable", message: e?.message || "Pipeline could not be loaded." });
  }
});

router.post("/api/pipeline", requireUser, async (req, res) => {
  const oppId = cleanOppId(req.body?.oppId);
  const stage = validStage(req.body?.stage);
  if (!oppId || !stage) return res.status(400).json({ error: "invalid_pipeline_record" });
  const uid = req.productionUser.id;
  const token = req.productionUser.token;
  const query = `/rest/v1/cre_pipeline?user_id=eq.${encodeURIComponent(uid)}&opp_id=eq.${encodeURIComponent(oppId)}`;
  const bbl = bblFromOppId(oppId);
  try {
    const existing = await supabaseFetch(`${query}&select=id,opp_id,stage,bbl&limit=1`, { token });
    if (Array.isArray(existing) && existing.length) {
      // Backfill on the way through. Rows written before bbl was persisted are
      // repaired the next time their stage moves, so the maturity wall recovers
      // an existing kanban instead of only seeing records created after the fix.
      const body = { stage, updated_at: new Date().toISOString() };
      if (bbl && !existing[0].bbl) body.bbl = bbl;
      const updated = await supabaseFetch(query, { token, method: "PATCH", prefer: "return=representation", body });
      const row = Array.isArray(updated) ? updated[0] : null;
      return res.json({ oppId: row?.opp_id || oppId, stage: row?.stage || stage, bbl: row?.bbl ?? bbl ?? null });
    }
    const created = await supabaseFetch("/rest/v1/cre_pipeline", {
      token, method: "POST", prefer: "return=representation",
      body: {
        user_id: uid, opp_id: oppId, stage,
        // Written only when the id actually encodes one. The column is the
        // maturity wall's selector; a guessed value there would put a parcel
        // the user never saved onto their debt wall.
        ...(bbl ? { bbl } : {}),
        metadata: { source: "production-kanban" }
      }
    });
    const row = Array.isArray(created) ? created[0] : null;
    return res.status(201).json({ oppId: row?.opp_id || oppId, stage: row?.stage || stage, bbl: row?.bbl ?? bbl ?? null });
  } catch (e) {
    return res.status(e?.status === 409 ? 409 : 502).json({ error: "pipeline_save_failed", message: e?.message || "Pipeline stage was not saved." });
  }
});

router.patch("/api/pipeline/:oppId", requireUser, async (req, res) => {
  const oppId = cleanOppId(req.params.oppId);
  const stage = validStage(req.body?.stage);
  if (!oppId || !stage) return res.status(400).json({ error: "invalid_pipeline_record" });
  try {
    const uid = req.productionUser.id;
    const bbl = bblFromOppId(oppId);
    const scope = `/rest/v1/cre_pipeline?user_id=eq.${encodeURIComponent(uid)}&opp_id=eq.${encodeURIComponent(oppId)}`;
    // Same backfill as POST: a drag between kanban columns is the most common
    // write this app performs, so it is where pre-fix rows get their bbl.
    const current = await supabaseFetch(`${scope}&select=bbl&limit=1`, { token: req.productionUser.token });
    const needsBbl = bbl && !(Array.isArray(current) && current[0]?.bbl);
    const rows = await supabaseFetch(
      scope,
      {
        token: req.productionUser.token, method: "PATCH", prefer: "return=representation",
        body: { stage, updated_at: new Date().toISOString(), ...(needsBbl ? { bbl } : {}) }
      }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return res.status(404).json({ error: "pipeline_record_not_found" });
    return res.json({ oppId: row.opp_id || oppId, stage: row.stage || stage, bbl: row.bbl ?? null });
  } catch (e) {
    return res.status(502).json({ error: "pipeline_save_failed", message: e?.message || "Pipeline stage was not saved." });
  }
});

router.delete("/api/pipeline/:oppId", requireUser, async (req, res) => {
  const oppId = cleanOppId(req.params.oppId);
  if (!oppId) return res.status(400).json({ error: "invalid_pipeline_record" });
  try {
    const uid = req.productionUser.id;
    await supabaseFetch(
      `/rest/v1/cre_pipeline?user_id=eq.${encodeURIComponent(uid)}&opp_id=eq.${encodeURIComponent(oppId)}`,
      { token: req.productionUser.token, method: "DELETE", prefer: "return=minimal" }
    );
    return res.status(204).end();
  } catch (e) {
    return res.status(502).json({ error: "pipeline_delete_failed", message: e?.message || "Pipeline record was not deleted." });
  }
});

// ---------------------------------------------------------------- My Desk maturity wall
// ACRIS reliably publishes mortgage documents/amounts/parties but not the loan
// contract's interest rate, contractual maturity or current payoff balance.
// The original reconstruction invented those terms. Production now verifies the
// user's recorded debt stack but does not render a fake maturity wall unless a
// source actually establishes the missing terms.
router.get("/api/maturity-wall", requireUser, async (req, res) => {
  try {
    const uid = req.productionUser.id;
    const rows = await supabaseFetch(`/rest/v1/cre_pipeline?select=bbl&user_id=eq.${encodeURIComponent(uid)}&bbl=not.is.null`, { token: req.productionUser.token });
    const bbls = [...new Set((Array.isArray(rows) ? rows : []).map((r) => digits(r.bbl)).filter((b) => b.length === 10))].slice(0, 60);
    if (!bbls.length) return res.json({ configured: true, provenance: "live", count: 0, loans: [], bbls: [], note: "No parcel pipeline records." });

    const recordedDebt = [];
    let acrisFailures = 0;
    // Parcels whose satisfaction linkage could not be resolved. Their mortgages
    // are NOT presented as outstanding debt.
    const unresolvedSatisfaction = [];
    for (const bbl of bbls) {
      const [acris, building] = await Promise.all([fullAcrisByLot(bbl), liveBuilding(bbl).catch(() => null)]);
      if (!acris.live) { acrisFailures += 1; continue; }

      // "No linked satisfaction" only means "not satisfied" when the linkage
      // could actually be checked.
      //
      // fullAcrisByLot is careful here: when the ACRIS Cross References source
      // fails it sets referenceStatus:"unavailable" and refuses to infer current
      // debt, precisely because it cannot know which mortgages were released.
      // But an unavailable reference source also makes every linkedSatisfactions
      // array empty — so filtering on `!d.linkedSatisfactions?.length` without
      // checking referenceStatus turns "we could not check" into "nothing was
      // satisfied", and a mortgage discharged years ago enters the maturity wall
      // as live debt. On a product that exists to tell an owner what is coming
      // due, that is the worst direction to be wrong in.
      if (acris.referenceStatus !== "live") {
        unresolvedSatisfaction.push(bbl);
        continue;
      }

      for (const debt of acris.financingTimeline.filter((d) => d.kind === "mortgage" && !d.linkedSatisfactions?.length)) {
        recordedDebt.push({
          bbl,
          borrower: debt.party1?.join("; ") || "—",
          lender: debt.party2?.join("; ") || "—",
          address: building?.address || "",
          borough: building?.borough || "",
          recordedAmount: debt.amount || null,
          recordedDate: debt.recordedDate || debt.documentDate || null,
          documentId: debt.documentId,
          balance: null,
          ratePct: null,
          maturity: null,
          daysToMaturity: null,
          source: "NYC ACRIS",
          valueType: "published mortgage document; contractual maturity/balance unavailable"
        });
      }
    }

    // This used to return `configured:false`, which switched the section off
    // entirely for signed-in users — the people it exists for — while an
    // anonymous visitor still saw the global wall. The reason was sound: ACRIS
    // publishes the mortgage document, not its terms, and presenting a modelled
    // figure under the labels Balance / Rate / Matures would read as
    // contractual.
    //
    // That objection is now answered rather than avoided. Every row carries
    // per-field estimate flags, and public/js/estimate-labels.js marks the
    // modelled columns "(est.)" in the rendered table and prints the
    // methodology beneath it. The wall is built from the user's own pipeline
    // parcels, which is a better set than the global one, and the maturity year
    // is modelled by the same estimator the global wall uses so the two can
    // never disagree.
    const loans = recordedDebt
      .map((d) => {
        const est = estimateDebtMaturity(
          { loans: [{ date: d.recordedDate, amount: d.recordedAmount ?? 0, docType: "MORTGAGE", lender: d.lender }] },
          new Date().getUTCFullYear()
        );
        if (!est?.estMaturityYear) return null;
        return loanRow({
          bbl: d.bbl,
          owner: d.borrower,
          address: d.address || `BBL ${d.bbl}`,
          lender: d.lender,
          amount: d.recordedAmount,
          originated: d.recordedDate,
          estMaturityYear: est.estMaturityYear
        });
      })
      .filter(Boolean)
      .filter((l) => l.daysToMaturity >= -365)
      .sort((a, z) => a.daysToMaturity - z.daysToMaturity)
      .slice(0, 12);

    return res.json({
      configured: true,
      count: loans.length,
      loans,
      // Parcels excluded because their satisfaction linkage could not be
      // resolved. An empty wall must be distinguishable from a clean one: the
      // caller can see that N parcels were skipped and why, rather than reading
      // "no debt" off a source outage.
      ...(unresolvedSatisfaction.length ? {
        unresolvedSatisfaction: {
          bbls: unresolvedSatisfaction,
          count: unresolvedSatisfaction.length,
          reason: "The ACRIS Cross References source did not answer for these parcels, so recorded satisfactions and releases could not be linked to their mortgages. Their mortgages are omitted rather than presented as outstanding — a discharged loan and an unverifiable one look identical without that linkage."
        }
      } : {}),
      estimated: true,
      methodology: "ACRIS records the mortgage, not its terms. Maturity is modelled from the recording date plus a typical term for the loan type and is accurate to the year, not the day. Balance is the recorded original principal — no amortisation is assumed. Rate is shown only where the public record carries one.",
      estimatedFields: ["maturity", "daysToMaturity", "balance", "payoffBalance"],
      provenance: acrisFailures === bbls.length ? "unavailable" : "live",
      // The verified records stay in the payload alongside the modelled rows,
      // so a consumer can always reach the underlying documents.
      recordedDebtCount: recordedDebt.length,
      recordedDebt,
      missingFields: ["current payoff balance", "interest rate", "contractual maturity date"],
      note: "Balance is the recorded ACRIS principal and maturity is modelled from the recording date; both are labelled as estimates in the payload and in the rendered table. ACRIS does not publish the contractual rate, maturity date or payoff balance, and none has been invented."
    });
  } catch (e) {
    return res.status(e?.status === 401 ? 401 : 502).json({ configured: false, provenance: "unavailable", error: "maturity_wall_unavailable", message: e?.message || "Private debt wall could not be loaded.", loans: [] });
  }
});

export default router;
