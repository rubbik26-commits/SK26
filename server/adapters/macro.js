// Macro rate context from Federal Reserve published series.
// Every figure is a published observation with its own observation date; nothing
// here forecasts, interpolates or invents a rate.
const FRED = "https://api.stlouisfed.org/fred/series/observations";
const KEY = () => process.env.FRED_API_KEY || "";

const SERIES = [
  { id: "DGS10", label: "10-year Treasury", cadence: "daily" },
  { id: "SOFR", label: "SOFR", cadence: "daily" },
  { id: "FEDFUNDS", label: "Fed Funds effective", cadence: "monthly" }
];

const TTL_MS = 12 * 60 * 60 * 1000;
let cache = null;

async function observation(id, { limit = 1, sort = "desc" } = {}) {
  const url = `${FRED}?series_id=${id}&api_key=${KEY()}&file_type=json&sort_order=${sort}&limit=${limit}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`FRED ${id} HTTP ${r.status}`);
  const j = await r.json();
  return (j.observations ?? []).filter((o) => o.value !== "." && o.value != null);
}

async function series(id) {
  const [latest] = await observation(id, { limit: 1 });
  if (!latest) return null;
  const value = Number(latest.value);
  if (!Number.isFinite(value)) return null;

  let priorValue = null, priorDate = null;
  try {
    const window = await observation(id, { limit: 400 });
    const target = new Date(latest.date);
    target.setFullYear(target.getFullYear() - 1);
    let best = null;
    for (const o of window) {
      const d = new Date(o.date);
      const gap = Math.abs(d - target);
      if (!best || gap < best.gap) best = { gap, o };
    }
    if (best && best.gap <= 45 * 864e5) {
      const v = Number(best.o.value);
      if (Number.isFinite(v)) { priorValue = v; priorDate = best.o.date; }
    }
  } catch { /* year-ago comparison is optional */ }

  return { id, value, asOf: latest.date, priorValue, priorDate };
}

export async function macroRates() {
  if (!KEY()) return { configured: false, live: false, reason: "FRED_API_KEY is not set" };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const out = {};
    for (const s of SERIES) {
      const row = await series(s.id);
      if (row) out[s.id] = { ...row, label: s.label, cadence: s.cadence };
    }
    if (!Object.keys(out).length) throw new Error("no observations returned");
    const value = {
      configured: true, live: true, provenance: "live",
      source: "Federal Reserve Bank of St. Louis (FRED)",
      series: out
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (e) {
    return { configured: true, live: false, reason: String(e?.message ?? e) };
  }
}

export function macroNarrative(m) {
  if (!m?.live) return [];
  const s = m.series ?? {};
  const pct = (v) => `${Number(v).toFixed(2)}%`;
  const move = (row) => {
    if (row?.priorValue == null) return "";
    const bps = Math.round((row.value - row.priorValue) * 100);
    if (bps === 0) return " — flat year over year";
    return ` — ${Math.abs(bps)} bps ${bps > 0 ? "higher" : "lower"} than a year ago`;
  };

  const lines = [];
  const ten = s.DGS10;
  if (ten) {
    lines.push(
      `Cost-of-capital context as of ${ten.asOf}: the 10-year Treasury is ${pct(ten.value)}${move(ten)}. ` +
      `A going-in cap rate below that benchmark represents a negative property-yield spread to the risk-free reference rate; ` +
      `whether leverage itself is positive or negative depends on the actual debt coupon, amortization/debt constant, fees and financing structure.`
    );
  }

  const sofr = s.SOFR, ff = s.FEDFUNDS;
  if (sofr || ff) {
    const parts = [];
    if (sofr) parts.push(`SOFR ${pct(sofr.value)} (${sofr.asOf})`);
    if (ff) parts.push(`Fed Funds effective ${pct(ff.value)} (${ff.asOf})`);
    lines.push(
      `Floating-rate context: ${parts.join(", ")}${sofr ? move(sofr) : ""}. ` +
      `SOFR is the base index for many floating-rate bridge and construction loans; the property's actual borrowing cost is the index plus its negotiated spread and other loan economics.`
    );
  }
  if (lines.length) lines.push(`Rates above are published observations from ${m.source}, not estimates or loan quotes.`);
  return lines;
}
