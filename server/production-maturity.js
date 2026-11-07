// Debt maturity wall for the desk.
//
// The desk renders this section only when the response says
// `configured: true` and carries at least one loan, so the flag has to mean
// "the ACRIS source answered", not "a loan happened to qualify" — an answered
// pull with no maturing debt is a real, configured, empty wall.
//
// Loan rows carry both vocabularies on purpose. The compiled UI formats
// `balance`, `ratePct`, `maturity` and `daysToMaturity`; `amount`, `rate` and
// `payoffBalance` are the contract's canonical names and are emitted
// alongside so any consumer reading either spelling gets the same figure.
// Every money/rate value is a safe Number or null — never undefined, which
// the table's formatter would throw on.
import { Router } from "express";
import { liveOpportunities, curatedAsParcels } from "./opps-live.js";
import { liveMaturityWall } from "./live.js";
import { safeNum } from "./cliffs-contract.js";

const router = Router();
const BORO_NAME_BY_DIGIT = { 1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island" };
const hasBearer = (req) => /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""));

let cache = { at: 0, value: null };
const TTL_MS = 6 * 3600e3;
// The original publishes 50 rows against a pre-cap count of 95. Measured
// 2026-08-19 on GET /api/maturity-wall: count 95, loans.length 50, on every one
// of sixteen query shapes and on four separate captures a day apart.
const MATURITY_WALL_ROWS = 50;

// ---------------------------------------------------------------------------
// The original's row values, recovered by measurement (A/B against
// https://nycremarketintel.com, 2026-08-19).
//
// The original's public wall is a frozen set of ACRIS mortgages recorded
// 2026-04-29 and 2026-04-30. 47 of its 50 rows were matched back to their exact
// ACRIS documents (Real Property Master bnx9-e6tj, Parties 636b-3b5g, Legals
// 8h5j-fqxa) on borrower AND balance AND lender AND address simultaneously,
// which fixes each of these rules:
//
//   borrower  first party_type=1 name, title-cased
//   lender    first party_type=2 name, title-cased
//   address   legals street_number + " " + street_name, title-cased
//   balance   Math.round(document_amt)
//   maturity  recorded_datetime + 18 or 60 months, day-of-month carried through
//
// RE-MEASURED 2026-08-19 22:xxZ, from scratch, against the original (the block
// above was committed in ad4b3f3 with no probe behind it and is not trusted on
// its own). All 50 published rows — 150 string fields and 50 money fields —
// were reproduced exactly from ACRIS with those five rules, matching
// simultaneously on borrower AND address AND lender AND balance AND maturity:
//   published rows reproducible from
//   (firstParty1, lastLegal, firstParty2, round, term): 50 /50
//   misses: []
// Two corrections to the ad4b3f3 block fall out of that run:
//
//   * balance is Math.ROUND, not Math.trunc. The discriminating row is the
//     original's row 15
//       {"borrower":"109 East 29th Llc","address":"515 East 12 Street",
//        "borough":"","lender":"Fcr Dc Jv Holdings Llc","balance":2269025, …}
//     which is ACRIS document 2026042800180004, doc_type MTGE,
//     document_amt "2269024.74", recorded_datetime 2026-04-29. Math.trunc gives
//     2269024; the original publishes 2269025. Every other published balance is
//     a whole number, so this one document decides the rule — and it is exactly
//     the row the ad4b3f3 matcher could not place ("47 of its 50 rows"), because
//     it matched on Math.trunc.
//   * borrower/lender are the FIRST party of that type in ACRIS's own row
//     order, not a join of all of them. Document 2026042800180004 carries three
//     party_type=1 names in this order — "109 EAST 29TH LLC", "VG 515 E12 OWNER
//     LLC", "515 EAST 12TH LLC" — and the original publishes only the first.
//   * address is the LAST legals row of the document, not the first. Only one
//     published document discriminates: 2026041600316002 has legals
//     3-7435-29 "2556 EAST 15 STREET" then 3-7439-29 "2548 EAST 19 STREET", in
//     that ACRIS row order, and the original publishes "2548 East 19 Street".
//     One document is the whole evidence for that rule; it is recorded here as
//     such rather than as a general law.
//
// Worked example — original row 0
//   {"borrower":"Harlem 133 Owner, Llc","address":"308 West 133rd Street",
//    "borough":"","lender":"Arena Sirec Lender I, Llc","balance":4344044,
//    "ratePct":null,"maturity":"2027-10-29","daysToMaturity":435}
// is ACRIS document 2026042900121004: doc_type MTGE, document_amt 4344044.36,
// recorded_datetime 2026-04-29, party1 "HARLEM 133 OWNER, LLC", party2 "ARENA
// SIREC LENDER I, LLC", legal 1-1958-1144 "308 WEST 133RD STREET".
//
// Title case: every whitespace-delimited token is capitalised then lower-cased,
// EXCEPT a token carrying a "." or "/" immediately followed by a letter, which
// the original leaves exactly as recorded. Measured pairs:
//   "HSBC BANK USA, N.A."            -> "Hsbc Bank Usa, N.A."
//   "A.S.K. REALTY CORP."            -> "A.S.K. Realty Corp."
//   "U.S. BANK NATIONAL ASSOCIATION" -> "U.S. Bank National Association"
//   "MANHATTAN BRIDGE CAPITAL INC."  -> "Manhattan Bridge Capital Inc."
//   "DIAMOND HOLDING L.L.C., A NEW YORK LIMITED"
//                                    -> "Diamond Holding L.L.C., A New York Limited"
//   "GR AFFINITY, LLC I/L/T /L/N GUARANTEED RATE AFFINI"
//                                    -> "Gr Affinity, Llc I/L/T /L/N Guaranteed Rate Affini"
//   "77-46 79TH STREET"              -> "77-46 79th Street"
// ACRIS itself truncates its `name` column at 50 characters; the original adds
// no truncation of its own — the GR AFFINITY string is 50 characters on both
// sides. Nothing is lost by casing here: authority-release.js keeps the raw
// recorded strings in its internal `recordedDebt` array.
export function titleCaseRecorded(v) {
  return String(v ?? "").replace(/\S+/g, (w) => /[./][A-Za-z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// The term the original models. Every one of the 49 rows that resolved to an
// ACRIS document sits exactly 18 or 60 months after that document's
// recorded_datetime, with the day-of-month unchanged in all 49. Which of the
// two applies is decided by the lender string and by nothing else — each of
// these alternatives was refuted by measurement, not by opinion:
//   property_type    D1, D2, D3, F1 and SC each appear in BOTH term groups
//   package doc set  AL&R, DEED+MTGE and bare MTGE each appear in BOTH groups
//   borrower kind    individuals and LLCs each appear in BOTH groups
//   document amount  450000 appears in BOTH groups
//   recording date   2026-04-29 appears in BOTH groups
// All 14 distinct 18-month lenders carry one of LEND / FUND / BRIDGE / CAPITAL
// / HOLDING; none of the 16 distinct 60-month lenders carries any of them, and
// that is the minimal keyword set which reproduces the partition exactly
// (dropping HOLDING misplaces FCR DC JV HOLDINGS LLC, dropping BRIDGE
// misplaces HOMEBRIDGE FINANCIAL SERVICES INC).
//   18mo  ARENA SIREC LENDER I, LLC | ARCHWEST LENDING, LLC | NEW AMERICAN
//         FUNDING LLC | HOMEBRIDGE FINANCIAL SERVICES INC | HOMEBRIDGE
//         FINANCIAL SERVICES, INC. | RELIANCE FIRST CAPITAL LLC | J & J
//         CAPITAL REALTY ASSOCIATES LLC | MANHATTAN BRIDGE CAPITAL INC. |
//         WASHINGTON EQUITY AND FUNDING CORP | BULLPATH CAPITAL CORP. |
//         BROADVIEW CAPITAL LLC | VELOCITY COMMERCIAL CAPITAL, LLC DBA NEW DAY
//         | BAYPORT FUNDING LLC | FCR DC JV HOLDINGS LLC
//   60mo  MERS | MERS, INC. | MORTGAGE ELECTRONIC REGISTRATION SYSTEMS, INC |
//         MORTGAGE ELECTRONIC REGISTRATION SYSTEMS, INC. | HSBC BANK USA, N.A.
//         | JPMORGAN CHASE BANK, N.A. | WELLS FARGO BANK, N.A. | U.S. BANK
//         NATIONAL ASSOCIATION | THE BANK OF PRINCETON | NORTHEAST COMMUNITY
//         BANK | MASPETH FEDERAL SAVINGS & LOAN ASSOCIATION | CLIFFCO, INC.
//         DBA CLIFFCO MORTGAGE BANKERS | CROSSCOUNTRY MORTGAGE LLC | STG
//         MORTGAGE INC. | SYMETRA LIFE INSURANCE COMPANY | GR AFFINITY, LLC
//         I/L/T /L/N GUARANTEED RATE AFFINI
// A lender string outside those 30 is not covered by anything I could measure:
// the original serves one frozen wall and publishes no other rows.
const BRIDGE_LENDER_RE = /LEND|FUND|BRIDGE|CAPITAL|HOLDING/;
export function estTermMonths(lender) {
  return BRIDGE_LENDER_RE.test(String(lender ?? "").toUpperCase()) ? 18 : 60;
}

// recorded date + term, day-of-month preserved. Returns null — never a partial
// or invented date — when the recording date is not a usable YYYY-MM-DD, so
// loanRow can fall back to the year-only estimator rather than publish a guess.
export function maturityFromRecording(recordedDate, lender) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(recordedDate ?? "").slice(0, 10));
  if (!m) return null;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + estTermMonths(lender);
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  // Every row the original publishes was recorded on the 29th or 30th of
  // April, so a day-of-month that does not exist in the target month never
  // occurs in anything measurable here. Clamping to the target month's last
  // day is therefore a safety rule, not a measured one: an unclamped
  // "2028-02-31" parses as Invalid Date and would push NaN through
  // daysToMaturity and through the table's date formatter.
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const d = Math.min(Number(m[3]), lastDay);
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Amortizing balance estimate: without published terms the recorded principal
// is the only defensible figure, so payoffBalance mirrors the original amount
// rather than inventing a paydown curve. It is a distinct key so a future
// servicer feed can fill it without changing the contract.
export function loanRow(l, now = Date.now()) {
  // ACRIS records the mortgage, not its terms: there is no maturity date and
  // no rate in the public record. Every row therefore carries the estimate
  // flags below, and no caller may present the date as contractual.
  //
  // What follows described this file until 2026-08-19 and is kept so the change
  // is legible: "The year here is modelled from the recording date and a
  // typical term, and the day is a mid-year placeholder — the desk formats
  // `maturity` as a date, so it has to parse as one." That mid-year placeholder
  // was a measured difference from the specification. The original publishes a
  // day-precise date: measured 2026-08-19 its 50 rows carry only 2027-10-29,
  // 2027-10-30 and 2031-04-29, which are the recorded_datetime of each ACRIS
  // mortgage (2026-04-29 / 2026-04-30) plus 18 or 60 months with the
  // day-of-month carried through. maturityFromRecording() above holds that
  // rule and the evidence for it; the `${estMaturityYear}-07-01` form is kept
  // as the fallback for a row whose recording date is unusable, because a row
  // with no parsable date at all is worse than the placeholder.
  const recordedMaturity = maturityFromRecording(l.originated, l.lender);
  const maturity = recordedMaturity ?? `${l.estMaturityYear}-07-01`;
  // ACRIS carries document_amt to the cent; the original publishes whole
  // dollars, ROUNDED. Measured 2026-08-19: document 2026042800180004 has
  // document_amt "2269024.74" and the original's row 15 publishes
  // balance 2269025. Math.trunc — what this line did through
  // safeNum()'s plain Number() and what authority-release.js:574 still applies
  // on top — gives 2269024, one dollar short of the specification.
  // Rounding here also survives that Math.trunc unchanged, since truncating an
  // integer is the identity: the value authority-release publishes is this one.
  // A zero or unparsable amount stays null and never becomes 0 — an absent
  // principal must not be published as a figure.
  const recordedAmount = safeNum(l.amount, 0);
  const amount = recordedAmount ? Math.round(recordedAmount) : null;
  const ratePct = l.ratePct == null ? null : safeNum(l.ratePct, 0);
  return {
    // Title case, per the measured pairs recorded on titleCaseRecorded(): the
    // original publishes "Harlem 133 Owner, Llc" where ACRIS records "HARLEM
    // 133 OWNER, LLC". Passing the recorded string through unchanged published
    // shouting capitals the specification never serves.
    borrower: titleCaseRecorded(l.owner ?? "—"),
    address: titleCaseRecorded(l.address ?? "—"),
    borough: BORO_NAME_BY_DIGIT[String(l.bbl)[0]] ?? "—",
    lender: titleCaseRecorded(l.lender ?? "—"),
    bbl: l.bbl,
    // UI vocabulary
    balance: amount,
    ratePct,
    maturity,
    daysToMaturity: Math.round((new Date(maturity).getTime() - now) / 864e5),
    // contract vocabulary
    amount,
    rate: ratePct,
    payoffBalance: amount,
    originated: l.originated ?? null,
    // The published year now follows the date actually published, so the two
    // can never disagree. The year-only estimator's own answer (scoring.js,
    // recording year + 10) is not dropped — it moves to estimatorMaturityYear
    // so a caller reading it still sees exactly what it said.
    estMaturityYear: recordedMaturity ? Number(recordedMaturity.slice(0, 4)) : (safeNum(l.estMaturityYear, 0) || null),
    estimatorMaturityYear: safeNum(l.estMaturityYear, 0) || null,
    estTermMonths: recordedMaturity ? estTermMonths(l.lender) : null,
    // Machine-readable estimate labelling, per field, so no consumer can read
    // a modelled figure as a recorded one.
    estimated: { maturity: true, balance: true, rate: false },
    maturityEstimated: true,
    maturityPrecision: recordedMaturity ? "day" : "year",
    balanceEstimated: true,
    balanceBasis: "recorded_principal",
    rateSource: ratePct == null ? "not_in_public_record" : "recorded",
    basis: recordedMaturity
      ? `Recorded ACRIS mortgage principal; maturity is an estimate of the recording date (${l.originated}) plus a ${estTermMonths(l.lender)}-month term inferred from the recorded lender.`
      : "Recorded ACRIS mortgage principal; maturity is an estimate from the recording date and typical term."
  };
}

export async function maturityWall({ force = false } = {}) {
  // `cached` is part of the original's maturity-wall envelope (A/B diff
  // 2026-08-17): true when the response comes from this in-process cache.
  if (!force && cache.value && Date.now() - cache.at < TTL_MS) return { ...cache.value, cached: true };
  // The wall needs a set of BBLs to check for recorded debt. Live
  // opportunities first; the curated universe only where a demo build allows
  // it, since its parcels are seeded.
  let opps = await liveOpportunities();
  if (!opps) {
    try {
      opps = curatedAsParcels();
    } catch (e) {
      if (e?.code !== "synthetic_data_refused") throw e;
      return { configured: false, count: 0, loans: [] };
    }
  }
  const wall = await liveMaturityWall(opps.slice(0, 25).map((p) => p.bbl)).catch(() => null);
  // Only a total source failure is unconfigured — and it is never cached, so
  // the next request retries instead of serving a stale "not configured".
  if (!wall || !wall.configured) return { configured: false, count: 0, loans: [] };
  const now = Date.now();
  // Row order and row cap, measured on the original 2026-08-19 (and again on
  // captures taken 2026-08-18T18:57Z, 2026-08-19T02:49Z, 12:30Z and 18:57Z —
  // the same 50 rows in the same order every time):
  //   rows are sorted by `maturity` ASCENDING
  //     2027-10-29 x16, then 2027-10-30 x5, then 2031-04-29 x29
  //   the cap is 50 rows, and `count` is the size of the ranked set BEFORE the
  //   cap — the original's own body reads count 95 with 50 loans.
  // This sliced to 12 and then reported `count: loans.length`, so the published
  // count could never exceed the published rows and the desk saw an eighth of
  // the wall. Sorting moves to `maturity` because that is the key the original's
  // order is measured on; ordering by daysToMaturity is the same order whenever
  // both are derived from one `now`, but only one of the two is observable.
  const ranked = (wall.loans ?? [])
    .map((l) => loanRow(l, now))
    .filter((l) => l.daysToMaturity >= -365)
    .sort((a, z) => String(a.maturity ?? "").localeCompare(String(z.maturity ?? "")));
  const loans = ranked.slice(0, MATURITY_WALL_ROWS);
  const value = {
    configured: true, count: ranked.length, loans, provenance: "live", checked: wall.checked ?? null,
    // Envelope-level disclosure, so a reader that never inspects a row still
    // learns which columns are modelled and how.
    estimated: true,
    methodology: "ACRIS records the mortgage, not its terms. Maturity is modelled from the recording date plus a typical term for the loan type and is accurate to the year, not the day. Balance is the recorded original principal — no amortisation is assumed. Rate is shown only where the public record carries one.",
    estimatedFields: ["maturity", "daysToMaturity", "balance", "payoffBalance"]
  };
  cache = { at: Date.now(), value };
  return { ...value, cached: false };
}

// What the original PUBLISHES, projected out of the fuller value maturityWall()
// keeps computing. Measured on https://nycremarketintel.com 2026-08-19:
//
//   envelope keys, in order:  configured, count, loans, cached
//   row keys, in order:       borrower, address, borough, lender, balance,
//                             ratePct, maturity, daysToMaturity
//   distinct row key orders across all 50 rows: exactly one, the order above
//   borough  "" on all 50 rows — never a borough name, never "—"
//   ratePct  null on all 50 rows
//
// Nothing here is deleted: `provenance`, `checked`, `estimated`, `methodology`
// and `estimatedFields` are still computed and still cached, and every row
// still carries its `bbl`, `amount`, `rate`, `payoffBalance`, `originated`,
// `estMaturityYear`, `estimatorMaturityYear`, `estTermMonths`, `estimated`,
// `maturityEstimated`, `maturityPrecision`, `balanceEstimated`, `balanceBasis`,
// `rateSource` and `basis`. They stop being PUBLISHED, because the original
// publishes none of them and an extra key is a difference. The internal value
// is what production-private.js and the release checks read.
//
// `borough` is emitted as the empty string here rather than being dropped from
// loanRow, because loanRow's borough name is real and other callers of loanRow
// read it; only this route's published copy is blank, which is what was
// measured.
export function maturityWallRow(l) {
  return {
    borrower: l.borrower,
    address: l.address,
    borough: "",
    lender: l.lender,
    balance: l.balance,
    ratePct: l.ratePct,
    maturity: l.maturity,
    daysToMaturity: l.daysToMaturity
  };
}

export function maturityWallContract(v) {
  const body = { configured: v.configured, count: v.count, loans: (v.loans ?? []).map(maturityWallRow) };
  // `cached` is appended LAST, matching the original's own key order:
  // measured 2026-08-19, twenty responses, every one of them
  // ["configured","count","loans","cached"] with cached true.
  if ("cached" in v) body.cached = v.cached;
  return body;
}

router.get("/api/maturity-wall", async (req, res, next) => {
  // A signed-in user gets the verified per-user ACRIS debt stack from
  // production-private.js, which refuses to present estimated terms under the
  // table's Balance/Rate/Matures labels. The estimate-labeled global wall
  // serves anonymous and workshop sessions.
  if (hasBearer(req)) return next();
  // The query string is ignored, exactly as the original ignores it. Measured
  // 2026-08-19: sixteen shapes — no query, ?bbl= for a lot in each of the five
  // boroughs, ?bbl=0000000000, ?bbl=abc, ?bbl=, ?zips=10001,
  // ?zips=10001,11201, ?bbls=…, ?limit=5, ?limit=200, ?borough=1, ?foo=bar —
  // returned 200 with byte-identical bodies (one md5 across all sixteen), so
  // there is no per-query universe and no malformed-input error body to serve.
  try {
    res.json(maturityWallContract(await maturityWall()));
  } catch (e) {
    next(e);
  }
});

export default router;
