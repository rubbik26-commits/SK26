import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const source = readFileSync(new URL("../public/js/production-auth-bridge.js", import.meta.url), "utf8");
const LEGACY = "https://qrcpeskqkoyacnmjuxni.supabase.co";
const TARGET = "https://pdvyuepsdnpxctmagdcq.supabase.co";
const APP = "https://owner.example";
const LEGACY_KEY = "legacy-publishable";
const TARGET_KEY = "target-publishable";

function tokenFor(issuer) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ iss: issuer })}.sig`;
}

function harness({ includeTargetSession = true } = {}) {
  const legacyToken = tokenFor(`${LEGACY}/auth/v1`);
  const targetToken = tokenFor(`${TARGET}/auth/v1`);
  const entries = [
    ["sb-qrcpeskqkoyacnmjuxni-auth-token", JSON.stringify({ access_token: legacyToken })]
  ];
  if (includeTargetSession) {
    entries.push(["sb-pdvyuepsdnpxctmagdcq-auth-token", JSON.stringify({ access_token: targetToken })]);
  }
  const values = new Map(entries);
  const calls = [];

  const storage = {
    get length() { return values.size; },
    key(i) { return [...values.keys()][i] ?? null; },
    getItem(key) { return values.get(key) ?? null; }
  };
  const nativeFetch = async (input, init = {}) => {
    calls.push({ input, init });
    return { ok: true };
  };
  const window = {
    fetch: nativeFetch,
    location: { href: `${APP}/#/dossier`, origin: APP },
    __SUPABASE_ENV__: {
      url: TARGET,
      publishableKey: TARGET_KEY,
      legacyUrl: LEGACY,
      legacyPublishableKey: LEGACY_KEY
    }
  };

  const context = createContext({
    window,
    localStorage: storage,
    URL,
    Headers,
    Request,
    atob,
    Buffer
  });
  new Script(source, { filename: "production-auth-bridge.js" }).runInContext(context);
  return { window, calls, targetToken, legacyToken };
}

test("same-origin Owner APIs preserve the original gate-only transport even when a Supabase session exists", async () => {
  const { window, calls } = harness();
  await window.fetch("/api/investors");
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), null,
    "the exact production bundle does not implicitly attach its Supabase session to Owner application APIs");
});

test("same-origin Owner API never receives a stale legacy-project session", async () => {
  const { window, calls } = harness({ includeTargetSession: false });
  await window.fetch("/api/investors");
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), null,
    "gate Owner access must not be reclassified by a foreign Supabase session");
});

test("same-origin API keeps an Authorization header explicitly supplied by original bundle code", async () => {
  const { window, calls, targetToken } = harness();
  await window.fetch("/api/account-delete", {
    method: "POST",
    headers: { authorization: `Bearer ${targetToken}` }
  });
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${targetToken}`);
});

test("legacy Supabase requests are retargeted and publishable keys are swapped", async () => {
  const { window, calls } = harness();
  await window.fetch(`${LEGACY}/rest/v1/cre_profiles`, {
    headers: {
      apikey: LEGACY_KEY,
      authorization: `Bearer ${LEGACY_KEY}`
    }
  });
  assert.equal(String(calls[0].input), `${TARGET}/rest/v1/cre_profiles`);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("apikey"), TARGET_KEY);
  assert.equal(headers.get("authorization"), `Bearer ${TARGET_KEY}`);
});

test("legacy-project user JWT is replaced with the active-project session during retargeting", async () => {
  const { window, calls, targetToken, legacyToken } = harness();
  await window.fetch(`${LEGACY}/auth/v1/user`, {
    headers: { apikey: LEGACY_KEY, authorization: `Bearer ${legacyToken}` }
  });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(String(calls[0].input), `${TARGET}/auth/v1/user`);
  assert.equal(headers.get("apikey"), TARGET_KEY);
  assert.equal(headers.get("authorization"), `Bearer ${targetToken}`);
});

test("legacy-project user JWT is stripped when no active-project session exists", async () => {
  const { window, calls, legacyToken } = harness({ includeTargetSession: false });
  await window.fetch(`${LEGACY}/auth/v1/user`, {
    headers: { apikey: LEGACY_KEY, authorization: `Bearer ${legacyToken}` }
  });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(String(calls[0].input), `${TARGET}/auth/v1/user`);
  assert.equal(headers.get("apikey"), TARGET_KEY);
  assert.equal(headers.get("authorization"), null,
    "a foreign user JWT must never be sent to the active Supabase project");
});

test("password recovery is retargeted to the live deployment origin", async () => {
  const { window, calls } = harness();
  await window.fetch(`${LEGACY}/auth/v1/recover`, { method: "POST" });
  const url = new URL(String(calls[0].input));
  assert.equal(url.origin, TARGET);
  assert.equal(url.searchParams.get("redirect_to"), APP);
});