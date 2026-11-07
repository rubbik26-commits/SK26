// Security + project bridge for the immutable production bundle.
//
// The supplied compiled frontend authenticates directly with Supabase, keeps
// the access token in Supabase's browser storage, and bakes the original
// project URL + publishable key into the minified assets. Without changing a
// byte of those assets, this bridge does two narrowly-scoped compatibility jobs:
//
//   1. Project retargeting — when the deployment configures a different
//      Supabase project (served same-origin at /js/supabase-env.js as
//      window.__SUPABASE_ENV__), requests aimed at the legacy baked-in project
//      are transparently repointed at the configured project, and the baked-in
//      publishable key in apikey/authorization headers is swapped for the
//      configured one. A user JWT issued by the legacy project is never sent to
//      the configured project: it is replaced by that project's current session
//      when one exists, otherwise removed. With no override the bridge changes
//      nothing.
//
//   2. Recovery redirect hardening — password-recovery requests carry this
//      deployment's actual browser origin as redirect_to. The original bundle
//      omitted it, so Supabase fell back to the project's stale localhost Site
//      URL and production recovery email links returned users to localhost.
//
// IMPORTANT OWNER-PARITY RULE:
// The original bundle's ordinary same-origin /api/* requests do NOT implicitly
// carry the Supabase session. Owner mode, the shared Pipeline / CRM board,
// Investors, Source Registry usage meters and Airtable cross-reference are
// password-gate application surfaces. Injecting a bearer into those requests
// silently changes them into the signed-in per-user routes and can even turn an
// authenticated gate Owner into a 403 when the Supabase profile is a normal
// user. Therefore this bridge never adds Authorization to same-origin APIs.
// Explicit Authorization supplied by the original bundle (for example account
// deletion) is preserved unchanged.
(() => {
  const nativeFetch = window.fetch.bind(window);
  const ENV = window.__SUPABASE_ENV__ || {};

  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return ""; } };
  const legacyHost = hostOf(ENV.legacyUrl || "https://qrcpeskqkoyacnmjuxni.supabase.co");
  const targetOrigin = (() => { try { return new URL(ENV.url || "").origin; } catch (_) { return ""; } })();
  const targetHost = hostOf(targetOrigin);
  const retarget = !!(targetOrigin && legacyHost && targetHost !== legacyHost);

  function issuerHost(token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return hostOf(String(payload && payload.iss || ""));
    } catch (_) { return ""; }
  }

  function accessToken() {
    // Used only while retargeting a request to the configured Supabase host.
    // Prefer the session issued by the ACTIVE project. A browser can hold
    // sb-*-auth-token entries for more than one Supabase project (the legacy
    // one and a configured one), and the bundle's storage key names its baked-
    // in ref even when retargeting is on, so the key alone cannot identify the
    // issuer. The token's own `iss` claim can.
    const activeHost = retarget ? targetHost : legacyHost;
    let fallback = "";
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        if (!/^sb-.*-auth-token$/.test(key)) continue;
        let token = "";
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          token = parsed?.access_token || parsed?.currentSession?.access_token || parsed?.session?.access_token;
        } catch (_) {
          continue; // one corrupt entry must not hide a valid session in another
        }
        if (typeof token !== "string" || token.split(".").length !== 3) continue;
        if (activeHost && issuerHost(token) === activeHost) return token;
        if (!fallback) fallback = token;
      }
    } catch (_) {
      // Corrupt/stale browser auth state must never break public API requests.
    }
    return retarget ? "" : fallback;
  }

  function swapProjectKeys(headers) {
    if (!ENV.legacyPublishableKey || !ENV.publishableKey || ENV.publishableKey === ENV.legacyPublishableKey) return;
    for (const name of ["apikey", "authorization"]) {
      const value = headers.get(name);
      if (!value) continue;
      if (value === ENV.legacyPublishableKey) headers.set(name, ENV.publishableKey);
      else if (value === "Bearer " + ENV.legacyPublishableKey) headers.set(name, "Bearer " + ENV.publishableKey);
    }
  }

  function replaceForeignUserBearer(headers) {
    if (!retarget) return;
    const value = headers.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(value);
    if (!match) return;
    const token = match[1].trim();

    // Publishable/anon authorization is project configuration, not a user
    // session. swapProjectKeys() already handles it and it must remain present.
    if (token === ENV.legacyPublishableKey || token === ENV.publishableKey) return;

    // Only JWT-shaped authorization can be a Supabase user session. Unknown
    // non-JWT bearer schemes are left alone rather than silently rewritten.
    if (token.split(".").length !== 3) return;
    if (issuerHost(token) === targetHost) return;

    const active = accessToken();
    if (active) headers.set("authorization", "Bearer " + active);
    else headers.delete("authorization");
  }

  function isConfiguredSupabaseHost(host) {
    return !!host && (host === legacyHost || host === targetHost);
  }

  function hardenRecoveryRedirect(url) {
    if (!isConfiguredSupabaseHost(url.host) || url.pathname !== "/auth/v1/recover") return false;
    // Supabase Auth's recovery action_link is
    // /auth/v1/verify?...&type=recovery&redirect_to=<redirectTo>. Supplying this
    // explicitly prevents fallback to a stale Dashboard Site URL. Preserve an
    // explicit redirect supplied by future bundle code rather than overwriting it.
    if (url.searchParams.has("redirect_to")) return false;
    url.searchParams.set("redirect_to", window.location.origin);
    return true;
  }

  window.fetch = function productionAuthenticatedFetch(input, init = {}) {
    try {
      const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      const url = new URL(rawUrl, window.location.href);
      let nextUrl = new URL(url.toString());
      let changedUrl = false;

      // 1. Repoint only the legacy Supabase host at the configured project.
      if (retarget && nextUrl.host === legacyHost) {
        nextUrl = new URL(nextUrl.pathname + nextUrl.search + nextUrl.hash, targetOrigin);
        changedUrl = true;
      }

      // 2. A production recovery request must never silently inherit localhost.
      if (hardenRecoveryRedirect(nextUrl)) changedUrl = true;

      if (changedUrl) {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
        swapProjectKeys(headers);
        replaceForeignUserBearer(headers);
        if (input instanceof Request) input = new Request(nextUrl.toString(), input);
        else input = nextUrl.toString();
        init = { ...init, headers };
      } else if (retarget && url.host === legacyHost && !(input instanceof Request)) {
        // Defensive fallback; normally the branch above already handled this.
        const headers = new Headers(init.headers || {});
        swapProjectKeys(headers);
        replaceForeignUserBearer(headers);
        init = { ...init, headers };
      }

      // Do not attach a Supabase bearer to same-origin application APIs. The
      // exact production bundle did not do that. Any Authorization header that
      // was explicitly supplied by the caller remains untouched here.
    } catch (_) {
      // Preserve native fetch semantics if URL/header normalization fails.
    }
    return nativeFetch(input, init);
  };
})();