// Airtable CRM cross-reference: real queries against the owner's CRM base —
// seller relationships and buyer fits matched to a parcel by normalized entity
// name, address and BBL. Owner-only at the route layer.
//
// Airtable retired legacy user API keys in 2024. A current Personal Access Token
// begins with `pat`, while a base id begins with `app`. Merely having two
// non-empty environment variables is not proof that this integration can work;
// treating malformed values as "configured" made an empty/error response look
// exactly like a valid no-match result.
const airtableToken = () => String(process.env.AIRTABLE_PAT || process.env.AIRTABLE_API_KEY || "").trim();
const airtableBaseId = () => String(process.env.AIRTABLE_BASE_ID || "").trim();
const validPat = (v) => /^pat[A-Za-z0-9._-]+$/i.test(String(v || ""));
const validBase = (v) => /^app[A-Za-z0-9]+$/i.test(String(v || ""));

export function airtableConfiguration() {
  const token = airtableToken();
  const baseId = airtableBaseId();
  const reasons = [];
  if (!token) reasons.push("missing_token");
  else if (!validPat(token)) reasons.push("invalid_personal_access_token_format");
  if (!baseId) reasons.push("missing_base_id");
  else if (!validBase(baseId)) reasons.push("invalid_base_id_format");
  return { configured: reasons.length === 0, reasons };
}

export const airtableConfigured = () => airtableConfiguration().configured;

const sellersTable = () => process.env.AIRTABLE_SELLERS_TABLE || "Sellers";
const buyersTable = () => process.env.AIRTABLE_BUYERS_TABLE || "Buyers";

// Entity/parcel normalization: strip punctuation and corporate suffixes so
// "AVENUE C, L.L.C." matches "Avenue C LLC".
export function normalizeEntity(s) {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[.,'’&]/g, " ")
    .replace(/\b(LLC|L L C|INC|CORP|CO|LP|L P|LTD|TRUST|REALTY|HOLDINGS|ASSOCIATES|ASSOC|COMPANY|GROUP)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function listRecords(table, formula) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(airtableBaseId())}/${encodeURIComponent(table)}?maxRecords=12&filterByFormula=${encodeURIComponent(formula)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${airtableToken()}` },
    signal: AbortSignal.timeout(10000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message || json?.error?.type || `Airtable HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (!Array.isArray(json.records)) throw new Error("Airtable response did not contain a records array.");
  return json.records;
}

function matchFormula(terms) {
  const clauses = terms
    .filter(Boolean)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length >= 3)
    .map((t) => `SEARCH(LOWER("${t.toLowerCase()}"), LOWER(CONCATENATE(ARRAYJOIN(values))))`);
  return clauses.length ? `OR(${clauses.join(",")})` : "FALSE()";
}

// Exported so field matching is contract-testable without an Airtable network
// call. Base schemas differ, therefore names remain environment-overridable.
export const matchFields = () =>
  String(process.env.AIRTABLE_MATCH_FIELDS || "Name,Owner,Company,Address,Property Address,BBL")
    .split(",").map((f) => f.trim()).filter(Boolean);

export function crossFieldFormula(terms, fields) {
  const esc = (t) => String(t).toLowerCase().replace(/"/g, "");
  const searchIn = (field, t) => `IF({${field}}, SEARCH(LOWER("${esc(t)}"), LOWER({${field}}&"")), 0)`;
  const clauses = [];
  for (const t of terms) for (const f of fields) clauses.push(searchIn(f, t));
  return clauses.length ? `OR(${clauses.join(",")})` : "FALSE()";
}

export async function crmXref({ owner, address, bbl }) {
  const config = airtableConfiguration();
  if (!config.configured) {
    return {
      configured: false,
      operational: false,
      sellerMatches: [],
      buyerMatches: [],
      configurationErrors: config.reasons,
      note: "Airtable requires a current Personal Access Token and an Airtable base id."
    };
  }

  const terms = [normalizeEntity(owner), String(address ?? "").toUpperCase(), String(bbl ?? "")]
    .filter((t) => t && t.length >= 3);
  const fields = matchFields();
  const fallbackFormula = (candidateFields) => crossFieldFormula(terms, candidateFields);

  const pull = async (table) => {
    try {
      return { rows: await listRecords(table, matchFormula(terms)), error: null };
    } catch (e1) {
      try {
        return { rows: await listRecords(table, fallbackFormula(fields)), error: null, matchedFields: fields };
      } catch (e2) {
        try {
          return {
            rows: await listRecords(table, fallbackFormula(["Name"])),
            error: null,
            matchedFields: ["Name"],
            degraded: `Cross-field search failed on "${table}" (${String(e2?.message ?? e2).slice(0, 120)}); matched on Name only. Set AIRTABLE_MATCH_FIELDS to this base's real field names for address and BBL matching.`
          };
        } catch (e3) {
          return { rows: [], error: String(e3?.message ?? e3).slice(0, 300) };
        }
      }
    }
  };

  const [sellers, buyers] = await Promise.all([pull(sellersTable()), pull(buyersTable())]);
  const shape = (r) => ({
    id: r.id,
    fields: r.fields,
    name: r.fields?.Name ?? r.fields?.name ?? Object.values(r.fields ?? {})[0] ?? r.id
  });
  const degraded = [sellers.degraded, buyers.degraded].filter(Boolean);
  const errors = [sellers.error, buyers.error].filter(Boolean);

  // `configured` describes a usable integration, not just key presence. A bad
  // base/table/token must never be indistinguishable from a legitimate empty CRM
  // match. The detailed error remains available to server/operator callers; no
  // credential value is included.
  return {
    configured: errors.length === 0,
    operational: errors.length === 0,
    matchedOn: terms,
    matchedFields: sellers.matchedFields ?? buyers.matchedFields ?? "values rollup",
    sellerMatches: sellers.rows.map(shape),
    buyerMatches: buyers.rows.map(shape),
    errors,
    ...(degraded.length ? { degraded } : {})
  };
}
