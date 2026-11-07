// Lightweight production security controls without another runtime dependency.
// The database-backed 3D quota remains the financial backstop; these limits
// additionally prevent a single client from hammering paid/CPU-heavy adapters.
import { Router } from "express";

const router = Router();
const buckets = new Map();
const LIMITS = [
  { re: /^\/api\/3d-session$/, max: 35, windowMs: 60_000 },
  { re: /^\/api\/streetview$/, max: 30, windowMs: 60_000 },
  { re: /^\/api\/(websearch|listing-check|listingcheck)$/, max: 30, windowMs: 60_000 },
  { re: /^\/api\/airtable-xref$/, max: 40, windowMs: 60_000 },
  { re: /^\/api\/similar$/, max: 90, windowMs: 60_000 },
  { re: /^\/api\/(market-report|market-index|territory|area-buildings)$/, max: 120, windowMs: 60_000 },
  { re: /^\/api\/account-delete$/, max: 5, windowMs: 10 * 60_000 }
];

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}
function prune(now) {
  if (buckets.size < 5000) return;
  for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  if (buckets.size > 10000) buckets.clear();
}

router.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

router.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const rule = LIMITS.find((r) => r.re.test(req.path));
  if (!rule) return next();
  const now = Date.now();
  prune(now);
  const key = `${clientKey(req)}:${rule.re.source}`;
  let b = buckets.get(key);
  if (!b || b.reset <= now) b = { count: 0, reset: now + rule.windowMs };
  b.count += 1;
  buckets.set(key, b);
  res.setHeader("RateLimit-Limit", String(rule.max));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, rule.max - b.count)));
  res.setHeader("RateLimit-Reset", String(Math.ceil(b.reset / 1000)));
  if (b.count > rule.max) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((b.reset - now) / 1000))));
    return res.status(429).json({ error: "rate_limited", message: "Too many requests. Try again shortly." });
  }
  next();
});

export default router;
