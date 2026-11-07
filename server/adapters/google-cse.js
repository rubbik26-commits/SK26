// Google Programmable Search (Custom Search JSON API) for the exact Owner
// Dossier marketing/listing check. The immutable production bundle explicitly
// names GOOGLE_CSE_KEY + GOOGLE_CSE_CX for this card; the map popup's separate
// /api/listing-check continues to use SERPER_API_KEY.

const apiKey = () => String(process.env.GOOGLE_CSE_KEY || "").trim();
const engineId = () => String(process.env.GOOGLE_CSE_CX || "").trim();

export function googleCseConfiguration() {
  const reasons = [];
  if (!apiKey()) reasons.push("missing_google_cse_key");
  if (!engineId()) reasons.push("missing_google_cse_cx");
  return { configured: reasons.length === 0, reasons };
}

export const googleCseConfigured = () => googleCseConfiguration().configured;

export async function googleCseSearch(q, { num = 10 } = {}) {
  const config = googleCseConfiguration();
  if (!config.configured) return { configured: false, hits: [], reasons: config.reasons };

  const query = String(q || "").trim();
  if (!query) return { configured: true, hits: [], query };

  const params = new URLSearchParams({
    key: apiKey(),
    cx: engineId(),
    q: query,
    num: String(Math.max(1, Math.min(10, Math.floor(Number(num) || 10))))
  });

  try {
    const res = await fetch(`https://customsearch.googleapis.com/customsearch/v1?${params.toString()}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      return {
        configured: true,
        error: json?.error?.message || text.slice(0, 300) || `Google Programmable Search HTTP ${res.status}`,
        status: res.status,
        hits: []
      };
    }

    const hits = (Array.isArray(json.items) ? json.items : []).map((item) => {
      let host = "";
      try { host = new URL(item.link || "").hostname.replace(/^www\./, ""); } catch { /* leave blank */ }
      return {
        title: item.title || "",
        link: item.link || "",
        host: host || item.displayLink || "",
        snippet: item.snippet || ""
      };
    }).filter((hit) => hit.link);

    return { configured: true, hits, query };
  } catch (e) {
    return { configured: true, error: String(e?.message || e), hits: [] };
  }
}
