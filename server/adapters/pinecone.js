// Pinecone vector similarity (Owner integration): real queries against a
// serverless index with an integrated embedding model. The index grows as
// parcels are opened: each viewed parcel is upserted, and /api/similar answers
// from a real vector search with metadata filters and similarity scores.
// Unconfigured or failing states are reported honestly.
//
// Pinecone's current Records API (2026-04) uses NDJSON for text upserts and
// JSON for search. Keeping those transports separate is required: sending the
// text-upsert payload as { records: [...] } JSON is not a valid Records API
// request and causes a configured Owner integration to fail at runtime.
const NAMESPACE = "nyc-parcels";
const API_VERSION = "2026-04";

export const pineconeConfigured = () =>
  !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_HOST);

function hostUrl(pathname) {
  const host = String(process.env.PINECONE_INDEX_HOST ?? "").replace(/\/+$/, "");
  return `${host.startsWith("http") ? host : `https://${host}`}${pathname}`;
}

async function pcFetch(pathname, { body, contentType = "application/json" } = {}) {
  const res = await fetch(hostUrl(pathname), {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": contentType,
      "Accept": "application/json",
      "X-Pinecone-Api-Version": API_VERSION
    },
    body,
    signal: AbortSignal.timeout(10000)
  });
  const text = await res.text();
  let json = {};
  if (text) {
    try { json = JSON.parse(text); }
    catch { json = { message: text.slice(0, 500) }; }
  }
  if (!res.ok) {
    const detail = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new Error(`Pinecone ${res.status}: ${detail}`);
  }
  return json;
}

// The text the integrated model embeds — built only from real parcel attributes.
export function parcelText(b) {
  return [
    b.address, b.borough, `ZIP ${b.zip}`, `zoning ${b.zoning}`, `class ${b.bldgClass}`,
    `land use ${b.landUse}`, `${b.unitsRes} residential units`, `${b.bldgArea} sf built on ${b.lotArea} sf lot`,
    `FAR ${b.builtFar} of ${b.maxFar}`, b.unusedFarSf > 0 ? `${b.unusedFarSf} sf unused development rights` : "built out",
    `built ${b.yearBuilt}`, `owner ${b.owner}`
  ].filter(Boolean).join(" · ");
}

export async function upsertParcel(b) {
  if (!pineconeConfigured() || !b?.bbl) return { configured: pineconeConfigured(), upserted: false };
  try {
    // Records API text upserts are newline-delimited JSON, one record per line.
    // The integrated index field map for this deployment is `text -> text`.
    const record = {
      _id: b.bbl,
      text: parcelText(b),
      bbl: b.bbl,
      address: b.address ?? "",
      borough: b.borough ?? "",
      zip: b.zip ?? "",
      bldgclass: b.bldgClass ?? "",
      classFamily: (b.bldgClass ?? "")[0] ?? "",
      unitsres: b.unitsRes ?? 0,
      bldgarea: b.bldgArea ?? 0,
      yearbuilt: b.yearBuilt ?? 0
    };
    await pcFetch(`/records/namespaces/${encodeURIComponent(NAMESPACE)}/upsert`, {
      contentType: "application/x-ndjson",
      body: `${JSON.stringify(record)}\n`
    });
    return { configured: true, upserted: true };
  } catch (e) {
    return { configured: true, upserted: false, error: String(e?.message ?? e) };
  }
}

export async function searchSimilar(b, { topK = 8 } = {}) {
  if (!pineconeConfigured()) return { configured: false };
  try {
    const out = await pcFetch(`/records/namespaces/${encodeURIComponent(NAMESPACE)}/search`, {
      body: JSON.stringify({
        query: {
          inputs: { text: parcelText(b) },
          top_k: topK + 1,
          filter: { borough: { $eq: b.borough ?? "" } }
        },
        fields: ["bbl", "address", "borough", "zip", "bldgclass", "classFamily", "unitsres", "bldgarea", "yearbuilt"]
      })
    });
    const rows = (out?.result?.hits ?? [])
      .filter((h) => (h._id ?? h.id) !== b.bbl)
      .slice(0, topK)
      .map((h) => ({
        bbl: h._id ?? h.id,
        score: h._score ?? h.score ?? null,
        address: h.fields?.address ?? "",
        zip: h.fields?.zip ?? "",
        bldgclass: h.fields?.bldgclass ?? ""
      }));
    return { configured: true, engine: "pinecone", matches: rows };
  } catch (e) {
    return { configured: true, engine: "pinecone", error: String(e?.message ?? e), matches: [] };
  }
}
