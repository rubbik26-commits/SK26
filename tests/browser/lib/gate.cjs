// Sign a Playwright context in through the site gate.
//
// WHY THIS EXISTS
// Six of the eight browser suites never authenticated. They passed anyway,
// because the harness did not set SITE_PASSWORD — so `siteGate()` disabled
// itself and every suite ran against an UNGATED server. That is not the
// configuration this application is ever deployed in, and it meant the gate
// itself, a security control, was exercised by exactly two suites.
//
// The moment the harness started booting with a password (so that owner-only
// surfaces could be tested at all), those six suites began failing on the login
// wall — correctly. This is the shared fix: one helper, used by every suite, so
// a suite cannot silently be testing an open server again.
//
// Tier matters. SITE_PASSWORD admits a member; OWNER_PASSWORD admits the owner
// and is what flips the app-wide owner mode Investors and Source Registry read.
// Sign in at the highest tier available, because a suite that needs only member
// access is unaffected by having more, while a suite that needs owner access
// fails confusingly without it.
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "";

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} base
 * @returns {Promise<{signedIn:boolean, tier:string, reason?:string}>}
 */
async function signIn(context, base) {
  const password = OWNER_PASSWORD || SITE_PASSWORD;
  // No password configured means no gate is running either — that is a valid
  // local setup, not a failure, and it is reported as such rather than silently
  // looking identical to a successful login.
  if (!password) return { signedIn: false, tier: "ungated", reason: "no SITE_PASSWORD/OWNER_PASSWORD configured" };

  try {
    await context.request.post(`${base}/__gate`, { form: { password }, timeout: 30000 });
  } catch (e) {
    return { signedIn: false, tier: "none", reason: `gate POST failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }

  const jar = await context.cookies();
  const signedIn = jar.some((c) => c.name === "ndi_gate") || jar.some((c) => c.name === "site_access");
  if (!signedIn) return { signedIn: false, tier: "none", reason: "the gate issued no session cookie — wrong password?" };

  return { signedIn: true, tier: OWNER_PASSWORD ? "owner" : "member" };
}

module.exports = { signIn, SITE_PASSWORD, OWNER_PASSWORD };
