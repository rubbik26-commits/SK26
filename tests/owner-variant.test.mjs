import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAppVariant, appVariant } from "../server/owner-variant.js";
import { gateRole } from "../server/gate.js";

function withProcessEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("owner is the default reconstruction variant", () => {
  const env = { SITE_PASSWORD: "site", OWNER_PASSWORD: "separate" };
  assert.equal(appVariant(env), "owner");
  assert.equal(normalizeAppVariant(env), "owner");
  assert.equal(env.OWNER_PASSWORD, "site");
});

test("explicit owner variant promotes the normal site credential to the owner tier", () => {
  const env = { APP_VARIANT: "owner", SITE_PASSWORD: "site", OWNER_PASSWORD: "separate" };
  assert.equal(normalizeAppVariant(env), "owner");
  assert.equal(env.OWNER_PASSWORD, "site");
});

test("the ordinary site credential resolves to gateRole owner in the owner build", () => {
  withProcessEnv({ APP_VARIANT: "owner", SITE_PASSWORD: "site", OWNER_PASSWORD: "separate" }, () => {
    normalizeAppVariant(process.env);
    const basic = Buffer.from("owner-test:site").toString("base64");
    const req = { headers: { authorization: `Basic ${basic}` } };
    assert.equal(gateRole(req), "owner");
  });
});

test("user variant preserves the member/owner credential split for the later reduced product", () => {
  const env = { APP_VARIANT: "user", SITE_PASSWORD: "site", OWNER_PASSWORD: "owner" };
  assert.equal(normalizeAppVariant(env), "user");
  assert.equal(env.SITE_PASSWORD, "site");
  assert.equal(env.OWNER_PASSWORD, "owner");
});
