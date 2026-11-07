// The site gate decides who counts as the owner, and the owner's private book
// (investor buy boxes, CRM cross-reference, the BD angle on a dossier) hangs off
// that decision. server/routes-bundle.js reads it through isOwner(req), which is
// gateRole(req) === "owner".
//
// gate.js has one branch that is easy to misread as a leak and one that would be
// a real one:
//
//   * With neither SITE_PASSWORD nor OWNER_PASSWORD set, the deployment is
//     private/local and every request is the owner. That is deliberate — a local
//     checkout has no one to hide from — and it is why the browser suite asserts
//     the owner *contract* rather than "no panel for an anonymous visitor",
//     which would depend on which environment the suite ran in.
//   * With a gate configured, an uncredentialed request must NOT be the owner.
//     Nothing else in the test suite pins that, and it is the branch the
//     deployed service actually runs under.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { gateRole } = await import("../server/gate.js");

// Mirrors the token gate.js sets on POST /__gate. Recomputed rather than
// imported so a change to the cookie derivation fails this test instead of
// silently agreeing with itself.
const token = (password) =>
  crypto.createHmac("sha256", "ndi-gate-v2").update(password).digest("base64url").slice(0, 20) + "-v2";

const req = (headers = {}) => ({ headers });
const withCookie = (name, value) => req({ cookie: `${name}=${value}` });
const withBasic = (password) => req({ authorization: `Basic ${Buffer.from(`x:${password}`).toString("base64")}` });

// node:test runs a file's tests sequentially, so swapping process.env around
// each case is safe here; each test restores what it changed.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const NO_GATE = { SITE_PASSWORD: undefined, OWNER_PASSWORD: undefined };

test("with no gate configured the deployment is private and owner mode is on", () => {
  withEnv(NO_GATE, () => {
    assert.equal(gateRole(req()), "owner");
  });
});

test("with a gate configured an uncredentialed request is not the owner", () => {
  withEnv({ ...NO_GATE, SITE_PASSWORD: "creintel-test" }, () => {
    assert.equal(gateRole(req()), "anon");
    assert.equal(gateRole(withCookie("ndi_gate", "not-the-token")), "anon");
    assert.equal(gateRole(withCookie("site_access", "not-the-token")), "anon");
    assert.equal(gateRole(withBasic("wrong-password")), "anon");
  });
});

test("the site password admits a member, not the owner", () => {
  withEnv({ ...NO_GATE, SITE_PASSWORD: "creintel-test", OWNER_PASSWORD: "owner-test" }, () => {
    assert.equal(gateRole(withCookie("ndi_gate", token("creintel-test"))), "member");
    assert.equal(gateRole(withCookie("site_access", token("creintel-test"))), "member");
    assert.equal(gateRole(withBasic("creintel-test")), "member");
  });
});

test("the owner password admits the owner through every accepted credential", () => {
  withEnv({ ...NO_GATE, SITE_PASSWORD: "creintel-test", OWNER_PASSWORD: "owner-test" }, () => {
    assert.equal(gateRole(withCookie("ndi_gate", token("owner-test"))), "owner");
    assert.equal(gateRole(withCookie("site_access", token("owner-test"))), "owner");
    assert.equal(gateRole(withBasic("owner-test")), "owner");
  });
});

test("a member credential never reaches owner mode when only SITE_PASSWORD is set", () => {
  // Deployments that set no separate owner password must not promote every
  // gate-holder to the owner's private book.
  withEnv({ ...NO_GATE, SITE_PASSWORD: "creintel-test" }, () => {
    assert.equal(gateRole(withCookie("ndi_gate", token("creintel-test"))), "member");
    assert.equal(gateRole(withBasic("creintel-test")), "member");
  });
});

test("an owner-only gate still refuses an uncredentialed request", () => {
  withEnv({ ...NO_GATE, OWNER_PASSWORD: "owner-test" }, () => {
    assert.equal(gateRole(req()), "anon");
    assert.equal(gateRole(withCookie("ndi_gate", token("owner-test"))), "owner");
  });
});
