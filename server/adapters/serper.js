// Serper.dev web search (audit items 21-23): the real integration behind
// listing detection and /api/websearch. Results are normalized, cached with a
// TTL so listing hits expire instead of going stale, and every failure is an
// explicit error state — never a silent empty success.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", "cache");
mkdirSync(CACHE_DIR, { recursive: true });

const TTL_MS = 24 * 60 * 60 * 1000; // stale-result expiration (item 21)

export const serperConfigured = () => !!process.env.SERPER_API_KEY;

function cacheFile(q) {
  return path.join(CACHE_DIR, "serper-" + crypto.createHash("sha1").update(q).digest("hex") + ".json");
}

export async function serperSearch(q, { num = 10 } = {}) {
  if (!serperConfigured()) return { configured: false, hits: [] };
  const file = cacheFile(`${q}|${num}`);
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (Date.now() - j.at < TTL_MS) return { ...j.value, cached: true, fetchedAt: new Date(j.at).toISOString() };
    }
  } catch { /* cache miss */ }
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ q, num }),
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) return { configured: true, error: `Search provider returned HTTP ${res.status}`, hits: [] };
    const data = await res.json();
    const hits = (data.organic ?? []).map((r) => {
      let source = "web";
      try { source = new URL(r.link).hostname.replace(/^www\./, ""); } catch { /* keep default */ }
      return { title: r.title ?? "", url: r.link ?? "", snippet: r.snippet ?? "", source };
    }).filter((h) => h.url);
    const value = { configured: true, hits, query: q };
    try {
      const tmp = file + ".tmp";
      writeFileSync(tmp, JSON.stringify({ at: Date.now(), value }));
      renameSync(tmp, file);
    } catch { /* cache is best-effort */ }
    return { ...value, cached: false, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { configured: true, error: `Search failed: ${String(e?.message ?? e)}`, hits: [] };
  }
}

const LISTING_PLATFORMS = ["streeteasy.com", "loopnet.com", "crexi.com", "zillow.com", "costar.com", "propertyshark.com", "realtor.com", "compass.com"];
const FOR_SALE_RE = /for sale|listing|asking|offering|on the market|available/i;

// On-market determination with per-hit platform + confidence (item 21).
export async function listingCheck(address, borough) {
  if (!serperConfigured()) return { configured: false };
  const q = `"${address}"${borough ? ` ${borough}` : ""} (${LISTING_PLATFORMS.slice(0, 5).map((d) => `site:${d}`).join(" OR ")})`;
  const r = await serperSearch(q, { num: 10 });
  if (!r.configured || r.error) return r;
  const addrTokens = String(address).toUpperCase().split(/\s+/).filter((t) => t.length > 1);
  const hits = r.hits
    .filter((h) => LISTING_PLATFORMS.some((d) => h.source.endsWith(d)))
    .map((h) => {
      const text = `${h.title} ${h.snippet}`.toUpperCase();
      const addrScore = addrTokens.length ? addrTokens.filter((t) => text.includes(t)).length / addrTokens.length : 0;
      const saleSignal = FOR_SALE_RE.test(`${h.title} ${h.snippet}`);
      const confidence = Math.round(Math.min(1, addrScore * 0.7 + (saleSignal ? 0.3 : 0)) * 100) / 100;
      return { ...h, saleSignal, confidence };
    })
    .sort((a, b) => b.confidence - a.confidence);
  const best = hits[0];
  return {
    configured: true,
    forSale: !!(best && best.saleSignal && best.confidence >= 0.6),
    confidence: best?.confidence ?? 0,
    hits: hits.slice(0, 6),
    cached: r.cached ?? false,
    fetchedAt: r.fetchedAt,
    expiresNote: "Listing hits are cached for 24 hours, then re-checked."
  };
}
