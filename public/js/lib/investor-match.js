// Investor buy-box matching (audit item 28): scores a parcel against the
// owner's private pool — borough, asset class, price band, unit band — with
// fit %, the gaps that block a clean fit, and a BD outreach angle.
const ASSET_CLASS_OF_BLDGCLASS = (cls) => {
  const c = String(cls ?? "")[0]?.toUpperCase() ?? "";
  if (["C", "D"].includes(c)) return "Multifamily";
  if (c === "S" || c === "K") return "Mixed-use";
  if (c === "O") return "Office";
  if (["V", "Z", "G"].includes(c)) return "Development / Land";
  if (c === "H") return "Hotel";
  if (["E", "F", "L", "M"].includes(c)) return "Industrial / Warehouse";
  if (["A", "B"].includes(c)) return "1–3 Family / Townhouse";
  if (c === "R") return "Condo";
  return "Retail";
};

export function matchInvestors(pool, target) {
  const borough = target.borough ?? null;
  const assetClass = target.assetClass ?? ASSET_CLASS_OF_BLDGCLASS(target.bldgClass);
  const price = target.price ?? target.lastSale ?? target.assessed ?? null;
  const units = target.units ?? null;
  return (pool ?? []).map((inv) => {
    const bb = inv.buyBox ?? {};
    const reasons = [], gaps = [];
    let score = 0, weight = 0;
    if (bb.boroughs?.length) {
      weight += 30;
      if (borough && bb.boroughs.includes(borough)) { score += 30; reasons.push(`buys in ${borough}`); }
      else gaps.push(`borough (wants ${bb.boroughs.join("/")})`);
    }
    if (bb.assetClasses?.length) {
      weight += 30;
      if (assetClass && bb.assetClasses.includes(assetClass)) { score += 30; reasons.push(assetClass.toLowerCase()); }
      else gaps.push(`asset class (wants ${bb.assetClasses.join(", ")})`);
    }
    if (bb.priceMin != null || bb.priceMax != null) {
      weight += 25;
      if (price == null) gaps.push("price unknown");
      else if ((bb.priceMin == null || price >= bb.priceMin) && (bb.priceMax == null || price <= bb.priceMax)) {
        score += 25; reasons.push("in price band");
      } else gaps.push(`price band $${(bb.priceMin ?? 0).toLocaleString()}–$${(bb.priceMax ?? "∞").toLocaleString()}`);
    }
    if (bb.unitsMin != null || bb.unitsMax != null) {
      weight += 15;
      if (units == null) gaps.push("unit count unknown");
      else if ((bb.unitsMin == null || units >= bb.unitsMin) && (bb.unitsMax == null || units <= bb.unitsMax)) {
        score += 15; reasons.push("unit count fits");
      } else gaps.push(`units ${bb.unitsMin ?? 0}–${bb.unitsMax ?? "∞"}`);
    }
    const pct = weight ? score / weight : 0;
    return { investor: inv, fit: weight > 0 && pct >= 0.99, score: Math.round(pct * 100) / 100, reasons, gaps };
  }).sort((a, b) => b.score - a.score);
}

export function bdAngle(matches, target) {
  const top = matches.filter((m) => m.fit || m.score >= 0.6).slice(0, 3);
  if (!top.length) return null;
  const names = top.map((m) => m.investor.name || m.investor.firm).filter(Boolean).join(", ");
  const why = top[0].reasons.slice(0, 2).join(" and ");
  return `You already represent ${top.length === 1 ? "a buyer" : `${top.length} buyers`} for this exact profile (${names})${why ? ` — ${why}` : ""}. Lead the owner conversation with a real buyer in hand, not a listing pitch.`;
}
