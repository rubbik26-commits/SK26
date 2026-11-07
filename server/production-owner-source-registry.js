// Owner Source Registry contracts recovered from the exact production bundle.
//
// The original Source Registry uses /api/maps-usage `configured` to answer one
// question: is the durable usage meter active? It does not use that field to
// mean "a Google imagery key exists". Keeping those concepts separate matters:
// the Owner panel must still show the live spend meter when imagery credentials
// are absent, and it must show "meter not active" when the store itself is not
// configured.
import { Router } from "express";
import { gateRole } from "./gate.js";
import { readDurableUsage, usageStoreConfigured } from "./durable-cost.js";
import { plutoByBbl, plutoRowToBuilding } from "./adapters/nyc.js";
import { pineconeConfigured, upsertParcel, searchSimilar } from "./adapters/pinecone.js";
import { googleCseConfigured, googleCseSearch } from "./adapters/google-cse.js";
import { serperConfigured, serperSearch } from "./adapters/serper.js";

const router = Router();
const hasBearer = (req) => /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""));
const GOOGLE_FREE_TIER = { freeStreetview: 5000, freeStatic: 10000 };
const mapsConfigured = () => !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY);
const cleanBbl = (value) => {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return /^[1-5]\d{9}$/.test(digits) ? digits : "";
};

router.get("/api/maps-usage", async (req, res, next) => {
  // The exact Owner bundle sends this request through its ordinary same-origin
  // fetch helper, without a Supabase bearer. Preserve the explicit bearer path
  // below for the account-aware compatibility handler in production-api.js.
  if (hasBearer(req)) return next();
  if (gateRole(req) !== "owner") return res.status(403).type("text").send("Owner only.");

  const month = new Date().toISOString().slice(0, 7);
  const storeConfigured = usageStoreConfigured();

  // This is the original "meter not yet active" state. It is a valid 200
  // contract, not a fabricated zero-usage success: configured=false tells the
  // Owner UI why no counters are available.
  // The envelope, measured 2026-08-19 on the original:
  //   {"month":"2026-08","configured":true,"streetview":33,"staticmap":149,
  //    "freeStreetview":5000,"freeStatic":10000}
  // — six keys, month first. durable, source, photorealistic3d and
  // mapsConfigured were all extra.
  if (!storeConfigured) {
    return res.json({ month, configured: false, streetview: 0, staticmap: 0, ...GOOGLE_FREE_TIER });
  }

  const d = await readDurableUsage(month);
  if (!d.live) {
    // A configured meter that cannot currently be read is an outage, not the
    // original "not configured" state. Fail explicitly so a temporary storage
    // failure cannot be misrepresented as zero spend.
    // Still reported as an outage rather than as zero spend — the extra keys
    // here are the honest failure report, not part of the success envelope.
    return res.status(503).json({
      month,
      configured: true,
      streetview: 0,
      staticmap: 0,
      ...GOOGLE_FREE_TIER,
      error: "usage_store_unavailable",
      message: d.reason || "The durable usage store is unavailable."
    });
  }

  return res.json({
    month,
    configured: true,
    streetview: d.byCategory.streetview ?? 0,
    staticmap: d.byCategory.staticmap ?? 0,
    ...GOOGLE_FREE_TIER
  });
});

// The exact Owner Dossier has a second listing detector distinct from the map
// popup. Its own rendered setup text names GOOGLE_CSE_KEY + GOOGLE_CSE_CX and
// Google Programmable Search. The popup's /api/listing-check remains Serper.
// Do not silently substitute Serper here: doing that made this card claim its
// Google integration was configured when the two Google variables were absent.
//
// That reasoning was taken from the bundle's SETUP COPY and was never measured
// against the original's own response — and the response is the contract.
// Measured 2026-08-19 against https://nycremarketintel.com from a
// gate-password session (this handler is the one production serves: a
// temporary `__probe_posr_5632` key added here and then removed appeared in
// GET /api/listingcheck on the rebuild, and did not appear in
// GET /api/listing-check):
//
//   GET /api/listingcheck?addr=350%205th%20Ave -> 200
//   {"configured":true,"address":"350 5th Ave",
//    "query":"\"350 5th Ave\" (for sale OR for lease OR listing OR asking)",
//    "searches":[
//     {"label":"Crexi","host":"crexi.com","url":"https://www.crexi.com/properties?term=350%205th%20Ave","live":false},
//     {"label":"LoopNet","host":"loopnet.com","url":"https://www.loopnet.com/search/?q=350%205th%20Ave","live":false},
//     {"label":"Reonomy","host":"reonomy.com","url":"https://app.reonomy.com/!/search?query=350%205th%20Ave","live":false},
//     {"label":"PropertyShark","host":"propertyshark.com","url":"https://www.propertyshark.com/mason/Property-Search?searchText=350%205th%20Ave","live":false},
//     {"label":"Google","host":"","url":"https://www.google.com/search?q=%22350%205th%20Ave%22%20(for%20sale%20OR%20for%20lease%20OR%20listing%20OR%20asking)","live":null}],
//    "hits":[],"listed":false,"cached":true}
//
// Every difference from what this handler used to serve, each one measured:
//
//  1. `address` and `query` are published. The rebuild published neither.
//  2. The top-level key order is configured, address, query, searches, hits,
//     listed. The rebuild served configured, listed, hits, searches.
//  3. Each `searches` row is {label, host, url, live} in that key order. The
//     rebuild served {url, label} — no host, no live.
//  4. The rows are DIRECT platform search URLs, not Google `site:` queries,
//     and the registry differs: Crexi, LoopNet, Reonomy, PropertyShark,
//     Google, in that order. StreetEasy and Zillow are not published by the
//     original; Reonomy and a plain Google row are.
//  5. The `query` the original builds is the phrase query below — NOT the
//     `"<addr>" New York` this handler used to send, and not a site: query.
//  6. A blank, whitespace-only or absent addr is 400 {"error":"Provide ?addr="}.
//     The rebuild answered 200 with an empty-address envelope. Measured:
//       GET /api/listingcheck                       -> 400 {"error":"Provide ?addr="}
//       GET /api/listingcheck?addr=                 -> 400 {"error":"Provide ?addr="}
//       GET /api/listingcheck?addr=%20%20%20        -> 400 {"error":"Provide ?addr="}
//       GET /api/listingcheck?address=1%20Wall%20St -> 400  (only `addr` counts)
//     POST and HEAD are 405 {"error":"Method not allowed"} on both sides
//     already; an unknown extra parameter is ignored (?...&extra=1 -> 200,
//     identical body), and ?boro= has no effect on this route.
//  7. A repeated ?addr= takes the FIRST value, not the joined array. Measured:
//       ?addr=1%20Wall%20St&addr=2%20Wall%20St -> 200, address "1 Wall St"
//       ?addr=&addr=350%205th%20Ave            -> 400  (first value is blank)
//  8. A second answer for the same address appends "cached":true LAST and
//     replays the stored payload verbatim — including the casing and inner
//     spacing of the FIRST request that populated it. Measured by seeding
//     "CacheKey Probe <t>" and then asking six ways:
//       exact repeat             -> cached=true  address="CacheKey Probe <t>"
//       "  CacheKey Probe <t>  " -> cached=true  address="CacheKey Probe <t>"
//       "CACHEKEY PROBE <t>"     -> cached=true  address="CacheKey Probe <t>"
//       "cachekey probe <t>"     -> cached=true  address="CacheKey Probe <t>"
//       "CacheKey Probe <t>   "  -> cached=true  address="CacheKey Probe <t>"
//       "CacheKey  Probe  <t>"   -> cached=true  address="CacheKey Probe <t>"
//     so the cache key is trim + collapse whitespace runs + lowercase, while
//     the PUBLISHED address is the raw parameter with only trim applied:
//       fresh "  Inner   Space   Probe   <t>  "
//         -> address "Inner   Space   Probe   <t>"   (inner runs preserved)
//     A first answer carries no `cached` key at all — it is absent, not false.
//     Fresh answers measured at 289-438ms, cached answers at 33-52ms.
//
// `checked` belongs to the OTHER route in this family, not to this one:
//   GET /api/listing-check?addr=350%205th%20Ave -> 200
//   {"configured":true,"address":"350 5th Ave","forSale":false,"hits":[],
//    "checked":1787165726021}
// — an epoch-ms stamp of when that address was actually checked, replayed
// unchanged on repeats (a fresh address stamps "now": 849ms first call,
// 44ms repeat, same `checked`). That route is NOT served from this file; the
// marker probe above proves it, and its body is the one built at
// server/routes-bundle.js:600-611. The delta there is reported, not patched
// from here.
//
// `configured` was true for every address probed, and both siblings in this
// family answer the same way — /api/websearch?q=test -> {"configured":true,
// "query":"test","searchUrl":"...","hits":[]}, and the /api/listing-check body
// above. This environment has SERPER_API_KEY present and GOOGLE_CSE_KEY /
// GOOGLE_CSE_CX absent, so gating this flag on the two Google variables alone
// is exactly what made the rebuild answer configured:false where the original
// answers true. The flag now reports whether EITHER provider for this family
// is configured, and the Google Programmable Search path is still preferred
// and still tried first whenever its two variables are present — nothing about
// that path was removed. Which variable the original itself reads cannot be
// measured from outside; what is measured is that the original answers true in
// a deployment whose only family credential this rebuild also carries.
const LISTING_PLATFORMS = [
  ["StreetEasy", "streeteasy.com"],
  ["Zillow", "zillow.com"],
  ["LoopNet", "loopnet.com"],
  ["Crexi", "crexi.com"],
  ["PropertyShark", "propertyshark.com"]
];
const FOR_SALE_RE = /\bfor sale\b|\blisting\b|\blisted\b|\basking\b|\bon the market\b/i;

// The registry the original publishes, in the measured order. `host` is the
// hostname a row's platform hits are matched against; the Google row carries no
// host and is therefore never decided — it was live:null on every probe, while
// the four hosted rows were live:false.
const LISTING_SEARCH_REGISTRY = [
  { label: "Crexi", host: "crexi.com", url: (addr) => `https://www.crexi.com/properties?term=${encodeURIComponent(addr)}` },
  { label: "LoopNet", host: "loopnet.com", url: (addr) => `https://www.loopnet.com/search/?q=${encodeURIComponent(addr)}` },
  { label: "Reonomy", host: "reonomy.com", url: (addr) => `https://app.reonomy.com/!/search?query=${encodeURIComponent(addr)}` },
  { label: "PropertyShark", host: "propertyshark.com", url: (addr) => `https://www.propertyshark.com/mason/Property-Search?searchText=${encodeURIComponent(addr)}` },
  // encodeURIComponent leaves ( ) unescaped, which is exactly how the
  // original's Google row reads: ...q=%22350%205th%20Ave%22%20(for%20sale...).
  { label: "Google", host: "", url: (addr, query) => `https://www.google.com/search?q=${encodeURIComponent(query)}` }
];

// A hit counts as a listing hit when its host is one of the registry's
// platforms or one of the two residential platforms LISTING_PLATFORMS carries.
// The original published no populated hits row on any probe, so this union
// cannot be narrowed by measurement; keeping both halves means nothing this
// handler used to recognise stops being recognised.
const LISTING_HIT_HOSTS = [...new Set([
  ...LISTING_PLATFORMS.map(([, host]) => host),
  ...LISTING_SEARCH_REGISTRY.map((row) => row.host).filter(Boolean)
])];
const hostMatchesPlatform = (host, platform) => !!platform && (host === platform || host.endsWith(`.${platform}`));

const listingQueryFor = (addr) => `"${addr}" (for sale OR for lease OR listing OR asking)`;
const listingCacheKey = (addr) => addr.trim().replace(/\s+/g, " ").toLowerCase();
// The original's cache lifetime cannot be measured from outside inside one
// session — only a lower bound, and a seeded entry was still answering
// cached:true when this work was verified. 24h is the window this app already
// uses for its own search cache (server/adapters/serper.js TTL_MS), so it is
// the app's existing number rather than a new invention.
const LISTING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const listingCache = new Map();

router.get("/api/listingcheck", async (req, res) => {
  // ?addr=a&addr=b is the first value, not the joined array — measured above.
  const rawAddr = Array.isArray(req.query.addr) ? req.query.addr[0] : req.query.addr;
  const addr = String(rawAddr ?? "").trim();
  if (!addr) return res.status(400).json({ error: "Provide ?addr=" });

  const cacheKey = listingCacheKey(addr);
  const cached = listingCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LISTING_CACHE_TTL_MS) {
    // The stored payload is replayed verbatim and `cached` is appended last —
    // that is why a cache hit answers with the first request's casing.
    return res.json({ ...cached.value, cached: true });
  }

  const query = listingQueryFor(addr);
  const googleCseOn = googleCseConfigured();
  const serperOn = serperConfigured();
  const configured = googleCseOn || serperOn;

  // hits[] was EMPTY on every probe of the original — 350 5th Ave, 1 Wall St,
  // 30 Rockefeller Plaza, 111 W 57th St, 2 Park Ave (Manhattan), 1000 Grand
  // Concourse (Bronx), 195 Montague St (Brooklyn), 120-55 Queens Blvd
  // (Queens), 1150 South Ave (Staten Island), a fabricated address that exists
  // nowhere, a random string, "%%%", "<script>alert(1)</script>", "Café & Co.
  // #5/6?x=1", "東京 1-2-3" and a 500-character address — and so was
  // /api/websearch?q=empire%20state%20building on the original. The original's
  // own search provider therefore returns nothing for every query reachable
  // from here, so no probe can show a populated hits row or a live:true
  // platform row, and none is invented below. The row shape is the one the
  // immutable bundle reads (public/assets/index-BbnE3o5g.js renders K.link,
  // K.title, K.isListing, K.host, K.snippet) and is carried over from this
  // handler unchanged.
  let hits = [];
  if (configured) {
    const result = googleCseOn
      ? await googleCseSearch(query, { num: 10 })
      : await serperSearch(query, { num: 10 });
    if (result.error) {
      // The original answers 200 with hits:[] and NO error key when its own
      // provider yields nothing, so publishing an error key here would itself
      // break the contract. The failure is named in the log with the
      // provider's own reason instead — reported, not swallowed, and never
      // carrying a credential.
      console.warn(
        `[listingcheck] ${googleCseOn ? "Google Programmable Search" : "Serper"} returned no result for ` +
        `${JSON.stringify(addr)}: ${String(result.error).slice(0, 300)}`
      );
    } else {
      hits = (result.hits ?? []).slice(0, 8).map((hit) => {
        const host = String(hit.host ?? hit.source ?? "").replace(/^www\./, "").toLowerCase();
        const title = hit.title || "";
        const snippet = hit.snippet || "";
        return {
          title,
          link: hit.link || hit.url || "",
          host,
          snippet,
          isListing: LISTING_HIT_HOSTS.some((platform) => hostMatchesPlatform(host, platform)) &&
            FOR_SALE_RE.test(`${title} ${snippet}`)
        };
      });
    }
  }

  const searches = LISTING_SEARCH_REGISTRY.map((row) => {
    // A row with no host is never decided: the Google row measured live:null
    // on every probe, while the four hosted rows measured live:false.
    let live = null;
    if (row.host) {
      const platformHits = hits.filter((hit) => hostMatchesPlatform(hit.host, row.host));
      live = platformHits.length ? platformHits.some((hit) => hit.isListing) : false;
    }
    return { label: row.label, host: row.host, url: row.url(addr, query), live };
  });

  const payload = {
    configured,
    address: addr,
    query,
    searches,
    hits,
    listed: hits.some((hit) => hit.isListing)
  };

  // Whether the original stores a provider failure or only a genuinely empty
  // success cannot be told apart from outside — its provider returns nothing
  // either way. What IS measured is that a repeat of ANY address, including
  // ones whose first answer was empty, comes back cached:true. So a real
  // provider answer is stored; the unconfigured branch, which asked nobody, is
  // not, and therefore never claims to be cached.
  if (configured) {
    listingCache.set(cacheKey, { at: Date.now(), value: payload });
    if (listingCache.size > 300) listingCache.delete(listingCache.keys().next().value);
  }
  return res.json(payload);
});

// The Owner dossier labels configured Similar Properties as Pinecone/vector
// similarity. It has no UI state for "Pinecone failed, so these are local
// heuristic matches". A configured Pinecone failure therefore fails explicitly
// instead of being replaced by a different algorithm under the Pinecone label.
router.get("/api/similar", async (req, res) => {
  const bbl = cleanBbl(req.query.bbl);
  if (!bbl) return res.status(400).json({ error: "invalid_bbl" });

  if (!pineconeConfigured()) {
    return res.json({ configured: false, matches: [] });
  }

  let pluto;
  try {
    pluto = await plutoByBbl(bbl);
  } catch (e) {
    return res.status(503).json({
      configured: true,
      matches: [],
      provenance: "unavailable",
      error: "pluto_unavailable",
      message: String(e?.message || "PLUTO could not resolve the subject parcel.").slice(0, 300)
    });
  }
  if (!pluto?.live) {
    return res.status(503).json({
      configured: true,
      matches: [],
      provenance: "unavailable",
      error: "pluto_unavailable"
    });
  }
  // Measured original behavior: a valid-format unknown/retired BBL is a normal
  // empty result, not a 404.
  if (!pluto.rows?.length) {
    return res.json({ configured: true, matches: [] });
  }

  const subject = plutoRowToBuilding(pluto.rows[0]);
  const upsert = await upsertParcel(subject);
  if (!upsert?.upserted) {
    return res.status(502).json({
      configured: true,
      matches: [],
      provenance: "unavailable",
      error: "pinecone_upsert_failed",
      message: String(upsert?.error || "Pinecone did not accept the parcel record.").slice(0, 300)
    });
  }

  const result = await searchSimilar(subject, { topK: 8 });
  if (result?.error || !Array.isArray(result?.matches)) {
    return res.status(502).json({
      configured: true,
      matches: [],
      provenance: "unavailable",
      error: "pinecone_search_failed",
      message: String(result?.error || "Pinecone did not return a match array.").slice(0, 300)
    });
  }

  // Measured 2026-08-19: the original's envelope on this route is exactly
  // {configured, matches}. The rebuild also published engine and provenance.
  return res.json({ configured: true, matches: result.matches });
});

export default router;
