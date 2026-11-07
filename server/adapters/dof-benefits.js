// NYC DOF Property Tax System benefit lookup. This adapter deliberately reads
// the current official benefit page because J-51 is published by DOF as a
// benefit lookup/file rather than a clean, continuously-updated Socrata table.
// No missing benefit is inferred: parsing failures are surfaced as unavailable.
const BASE = "https://a836-pts-access.nyc.gov/care/datalets/datalet.aspx";
const cache = new Map();
const cleanBbl = (v) => {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return d.length === 10 ? d : "";
};
const money = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const text = (html) => String(html || "")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<br\s*\/?\s*>/gi, "\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/g, "'").replace(/&quot;/gi, '"')
  .replace(/[\t\r ]+/g, " ").replace(/\n\s+/g, "\n");

function fiscalTaxYear() {
  // NYC fiscal year that ends in the next calendar year from July onward.
  const now = new Date();
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

export async function dofBenefitsByBbl(bbl, taxYear = fiscalTaxYear()) {
  const pin = cleanBbl(bbl);
  if (!pin) return { live: false, error: "invalid bbl", j51: null };
  const year = Number(taxYear) || fiscalTaxYear();
  const key = `${pin}:${year}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const params = new URLSearchParams({ LMparent: "20", UseSearch: "no", jur: "65", mode: "benefits_comm", pin, taxyr: String(year) });
  const sourceUrl = `${BASE}?${params}`;
  try {
    const r = await fetch(sourceUrl, {
      headers: { "user-agent": "NYC-RE-Market-Intel/production (+public-record lookup)", accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(`DOF benefit lookup HTTP ${r.status}`);
    const html = await r.text();
    const body = text(html);
    // A valid page that has no J-51 language is a verified no-current-J51 result
    // for the requested tax year. A maintenance/error page is not.
    if (/system is currently unavailable|problem encountered rendering/i.test(body) && !/J-?51/i.test(body)) {
      throw new Error("DOF benefit lookup temporarily unavailable");
    }
    const hasJ51 = /\bJ-?51\b/i.test(body);
    let j51 = null;
    if (hasJ51) {
      const start = (body.match(/Start Date\s+(\d{2}\/\d{2}\/\d{4})/i) || body.match(/J51\s+[\d,.]+\s+(\d{2}\/\d{2}\/\d{4})/i))?.[1] || null;
      // The benefit page publishes the exemption period as "J-51 Alteration
      // YYYY - YYYY" — the authoritative init/expiry years when present.
      const period = body.match(/J-?51 Alteration\s+(\d{4})\s*-\s*(\d{4})/i);
      const abatement = money((body.match(/J51\s+J51\s+J51\s+([\d,.]+)/i) || [])[1]);
      const exemption = money((body.match(/J-51 Alteration\s+\d{4}\s*-\s*\d{4}\s+([\d,.]+)/i) || [])[1]);
      const lifetime = money((body.match(/Lifetime Abatement Amount\s+Abatement Percentage\s+J51 Remaining Benefit\s+Alteration Cost\s+J51\s+[\d,.]+\s+\d{2}\/\d{2}\/\d{4}\s+([\d,.]+)/i) || [])[1]);
      const remaining = money((body.match(/J51\s+[\d,.]+\s+\d{2}\/\d{2}\/\d{4}\s+[\d,.]+\s+[\d.]+\s+([\d,.]+)/i) || [])[1]);
      const alterationCost = money((body.match(/J51\s+[\d,.]+\s+\d{2}\/\d{2}\/\d{4}\s+[\d,.]+\s+[\d.]+\s+[\d,.]+\s+([\d,.]+)/i) || [])[1]);
      j51 = {
        active: true, taxYear: year, startDate: start,
        periodStart: period ? Number(period[1]) : null,
        periodEnd: period ? Number(period[2]) : null,
        exemptionAmount: exemption, abatementAmount: abatement,
        lifetimeAbatementAmount: lifetime, remainingBenefit: remaining,
        alterationCost, source: "NYC Department of Finance — J-51 benefit lookup", sourceUrl
      };
    }
    const value = {
      live: true, provenance: "live", bbl: pin, taxYear: year,
      j51: j51 || { active: false, taxYear: year, source: "NYC Department of Finance — benefit lookup", sourceUrl },
      fetchedAt: new Date().toISOString(), sourceUrl
    };
    cache.set(key, { value, expires: Date.now() + 12 * 60 * 60 * 1000 });
    return value;
  } catch (e) {
    return { live: false, provenance: "unavailable", bbl: pin, taxYear: year, j51: null, sourceUrl, error: String(e?.message || e) };
  }
}
