// The production tripwire for invented property facts (P7.5, P7.6, P7.7).
//
// server/seed-parcels.js and server/citymodel.js are real generators of
// property-shaped data: seeded owners ("Demo Holdings LLC"), authored
// opportunity scores, hand-typed lot and building areas, invented theses. They
// exist on purpose, for offline work and for the demo tier, and they are
// useful there.
//
// What must never happen is one of them answering a production request. A
// user cannot tell a seeded owner from a recorded one — both arrive in the
// same field, in the same shape, with the same confidence. An outage at NYC
// Open Data must produce a visibly empty state, not a plausible one.
//
// So: a call into a generator throws in production unless the deployment has
// explicitly opted in. Callers catch it and answer with an honest unavailable
// state; server/production-live-guard.js turns that into a 503 for every
// authoritative path.
//
// Set ALLOW_SYNTHETIC_DEMO=1 to run the demo tier in a production build. It is
// deliberately awkward to enable, and it is logged the first time it is used.

const ALLOW = String(process.env.ALLOW_SYNTHETIC_DEMO ?? "") === "1";
let warned = false;

export class SyntheticDataRefused extends Error {
  constructor(source) {
    super(
      `Refused to serve synthetic property data from ${source} in production. `
      + "Live public records were unavailable; the correct answer is an explicit "
      + "unavailable state, not invented facts. Set ALLOW_SYNTHETIC_DEMO=1 to run "
      + "the demo tier deliberately."
    );
    this.name = "SyntheticDataRefused";
    this.source = source;
    this.code = "synthetic_data_refused";
  }
}

export function syntheticAllowed() {
  return process.env.NODE_ENV !== "production" || ALLOW;
}

// Call at the top of any function that can produce a property fact which is
// not in a public record.
export function assertSyntheticAllowed(source) {
  if (syntheticAllowed()) {
    if (ALLOW && process.env.NODE_ENV === "production" && !warned) {
      warned = true;
      console.warn(`[synthetic] ALLOW_SYNTHETIC_DEMO=1 — ${source} may answer production requests with seeded data.`);
    }
    return;
  }
  throw new SyntheticDataRefused(source);
}
