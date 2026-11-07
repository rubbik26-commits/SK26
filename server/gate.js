// Global site gate — parity with the legacy production deployment's password
// wall (the "creintel2026" gate): when SITE_PASSWORD is set, every route is
// protected except the immutable compiled assets (/assets/*) and the /healthz
// probe. Three credentials are accepted:
//   1. the HttpOnly `ndi_gate` token cookie set by POST /__gate (the form),
//   2. a legacy-compatible `site_access` cookie carrying the same token,
//   3. an HTTP Basic `Authorization` header whose password half matches the
//      site (or owner) password — for curl/CI and pre-authenticated clients.
// Unauthenticated /api/* requests get 401 JSON; page requests get the form.
import crypto from "node:crypto";

const COOKIE = "ndi_gate";
const LEGACY_COOKIE = "site_access";

// Liveness probes a platform health check may be pointed at. These must answer
// without credentials or the deploy is marked unhealthy and rolled back.
const HEALTH_PATHS = new Set(["/healthz", "/api/status"]);

const token = (password) =>
  crypto.createHmac("sha256", "ndi-gate-v2").update(password).digest("base64url").slice(0, 20) + "-v2";

const eq = (a, b) => {
  const A = Buffer.from(String(a ?? ""));
  const B = Buffer.from(String(b ?? ""));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie ?? "");
  return cookies.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

// Basic <base64(user:password)> — the password half (or the whole decoded
// string when no colon is present) is compared against the gate passwords.
function basicPassword(req) {
  const h = String(req.headers.authorization ?? "");
  const m = h.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!m) return "";
  try {
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon >= 0 ? decoded.slice(colon + 1) : decoded;
  } catch { return ""; }
}

// Two gate tiers: SITE_PASSWORD admits a member; OWNER_PASSWORD (optional)
// admits the owner — same form, same cookies, different value. The owner
// credential is what flips the app-wide owner mode the frontend reads from
// /api/pinecone-status.
export function gateRole(req) {
  const site = process.env.SITE_PASSWORD;
  const owner = process.env.OWNER_PASSWORD;
  // With no gate configured this is a private/local deployment: owner mode on.
  if (!site && !owner) return "owner";
  for (const name of [COOKIE, LEGACY_COOKIE]) {
    const val = cookieValue(req, name);
    if (!val) continue;
    if (owner && val === token(owner)) return "owner";
    if (site && val === token(site)) return "member";
  }
  const basic = basicPassword(req);
  if (basic) {
    if (owner && eq(basic, owner)) return "owner";
    if (site && eq(basic, site)) return "member";
  }
  return "anon";
}

// The access page is the first Skyline surface anyone sees, so it carries the
// brand: Deep Navy ground, the official mark, Warm Gold accents. The mark is
// inlined as a data URI because this gate deliberately serves nothing but
// /assets/* and /healthz to an unauthenticated visitor — a linked image or
// webfont would be blocked by the very check this page exists to enforce, so
// the page has to be self-contained. Helvetica stands in for Archivo here,
// which the type board names as the acceptable substitute.
//
// Presentation only: the form's action, field name, autofocus, show-password
// toggle and error state are unchanged, as is every credential check below.
const MARK = "data:image/png;base64,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";

const page = (err) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#0B1B2B"><title>Skyline Properties</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:radial-gradient(120% 90% at 50% 0%,#12304b 0%,#0B1B2B 62%,#08131F 100%);
       font-family:"Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;color:#F3F1EA;padding:16px}
  .card{width:100%;max-width:372px;background:rgba(22,38,54,.92);border:1px solid rgba(201,162,75,.28);
        border-radius:6px;padding:30px 28px 26px;box-shadow:0 24px 60px rgba(3,10,18,.62);text-align:left}
  .mark{display:block;width:74px;height:74px;margin:0 auto 16px}
  .rule{height:1px;background:linear-gradient(90deg,#B78A38 0%,#CEA731 50%,#A16E1B 100%);margin:0 0 18px;opacity:.85}
  h1{font-size:19px;line-height:1.15;margin:0 0 3px;font-weight:700;letter-spacing:-.4px;text-align:center;color:#F3F1EA}
  .tag{font-size:8.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#C9A24B;text-align:center;margin:0 0 18px}
  p{font-size:12.5px;color:#ABB8C4;margin:0 0 18px;line-height:1.5}
  label{display:block;font-size:10px;font-weight:600;color:#C9A24B;margin:0 0 6px;text-transform:uppercase;letter-spacing:.12em}
  input{width:100%;padding:11px 12px;font-size:16px;border:1px solid #394D60;border-radius:4px;outline:none;
        background:#0F2233;color:#F3F1EA}
  input:focus{border-color:#C9A24B;box-shadow:0 0 0 3px rgba(201,162,75,.18)}
  button{width:100%;margin-top:16px;padding:12px;font-size:13px;font-weight:700;letter-spacing:.06em;
         text-transform:uppercase;color:#0B1B2B;border:0;border-radius:4px;cursor:pointer;
         background:linear-gradient(105deg,#BC913F 0%,#CFAD60 20%,#FAF2AF 44%,#C9A02F 62%,#A3701D 100%)}
  button:hover{filter:brightness(1.06)}
  .err{color:#EF6C75;font-size:12px;margin:10px 0 0}
  .brand{font-weight:700;letter-spacing:-.01em}
  .show{display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px;color:#ABB8C4;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;user-select:none}
  .show input{width:auto;margin:0;accent-color:#C9A24B}
</style></head>
<body><form class="card" method="POST" action="/__gate">
  <img class="mark" src="${MARK}" alt="Skyline Properties" width="74" height="74">
  <h1 class="brand">Skyline Properties</h1>
  <div class="tag">Manhattan&rsquo;s Off-Market Investment Sales Authority</div>
  <div class="rule"></div>
  <p>This site is private. Enter the access password to continue.</p>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autofocus autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" />
  <label class="show"><input type="checkbox" onchange="document.getElementById('p').type=this.checked?'text':'password'"> Show password</label>
  ${err ? `<p class="err">Incorrect password. Try again.</p>` : ""}
  <button type="submit">Enter</button>
</form></body></html>`;

export function siteGate() {
  return (req, res, next) => {
    const password = process.env.SITE_PASSWORD;
    if (!password) return next();

    if (req.method === "POST" && req.path === "/__gate") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on("end", () => {
        const given = new URLSearchParams(body).get("password") ?? "";
        const accepted = eq(given, password) ? password
          : (process.env.OWNER_PASSWORD && eq(given, process.env.OWNER_PASSWORD)) ? process.env.OWNER_PASSWORD
          : null;
        if (!accepted) return res.status(401).type("html").set("cache-control", "no-store").send(page(true));
        const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
        const attrs = `Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=2592000`;
        res.status(303)
          .set("location", "/")
          .set("cache-control", "no-store")
          .set("set-cookie", [
            `${COOKIE}=${token(accepted)}; ${attrs}`,
            `${LEGACY_COOKIE}=${token(accepted)}; ${attrs}`
          ])
          .end();
      });
      return;
    }

    // Ungated: the immutable compiled assets and the liveness probes.
    //
    // Both probe paths are exempt on purpose. /healthz is what render.yaml
    // health-checks, but a service whose health check was configured in the
    // dashboard still points at /api/status — the path the blueprint used
    // before this gate existed — and a 401 there fails every deploy. Keeping
    // /api/status open costs nothing: the legacy deployment left the whole
    // /api/* surface public, and this endpoint only reports data mode and
    // which subsystems are configured. Everything else, pages and API alike,
    // requires the gate. CORS preflights carry no data and pass; the actual
    // request they precede is still gated.
    if (HEALTH_PATHS.has(req.path) || req.path.startsWith("/assets/")) return next();
    if (req.method === "OPTIONS") return next();

    if (gateRole(req) !== "anon") return next();

    if (req.path.startsWith("/api/")) {
      return res.status(401)
        .set("cache-control", "no-store")
        .set("www-authenticate", 'Basic realm="NYC RE Market Intel"')
        .json({ error: "unauthorized", message: "Site password required — sign in at / or send Basic auth / the site_access cookie." });
    }
    res.status(200).type("html").set("cache-control", "no-store").send(page(false));
  };
}
