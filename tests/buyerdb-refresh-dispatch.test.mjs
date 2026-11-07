import assert from "node:assert/strict";
import test from "node:test";
import { dispatchBuyerDbRefresh } from "../scripts/buyerdb-refresh-dispatch.mjs";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? "" : JSON.stringify(payload);
    }
  };
}

test("the Render buyerDB dispatcher is a no-op until cutover is explicitly enabled", async () => {
  let called = false;
  const result = await dispatchBuyerDbRefresh({
    env: {},
    fetchImpl: async () => {
      called = true;
      throw new Error("must not run");
    }
  });
  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "BUYERDB_REFRESH_ENABLED is not 1"
  });
});

test("enabled dispatch uses buyerDB's canonical control-plane contract", async () => {
  const calls = [];
  const secret = "shared-test-secret-that-must-not-be-returned";
  const result = await dispatchBuyerDbRefresh({
    env: {
      BUYERDB_REFRESH_ENABLED: "1",
      BUYERDB_CONTROL_PLANE_URL: "https://buyerdb.netlify.app/ignored/path?ignored=1",
      BUYERDB_SCRAPER_TRIGGER_SECRET: secret,
      BUYERDB_REFRESH_JOB: "full_refresh"
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return response(202, {
        ok: true,
        runs: [
          { job: "acris_refresh", runId: "11111111-1111-4111-8111-111111111111", status: "requested" },
          { job: "rolling_sales", run_id: "22222222-2222-4222-8222-222222222222", status: "requested" }
        ],
        privateDetail: secret
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://buyerdb.netlify.app/api/scrapers/run");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-scraper-trigger-secret"], secret);
  assert.deepEqual(JSON.parse(calls[0].init.body), { job: "full_refresh", options: {} });
  assert.equal(result.httpStatus, 202);
  assert.equal(result.job, "full_refresh");
  assert.equal(result.runs.length, 2);
  assert.equal(JSON.stringify(result).includes(secret), false, "credentials and raw upstream payloads stay out of logs");
});

test("enabled dispatch fails closed on missing credentials, invalid jobs, and non-HTTPS targets", async () => {
  await assert.rejects(
    dispatchBuyerDbRefresh({ env: { BUYERDB_REFRESH_ENABLED: "1" } }),
    /BUYERDB_SCRAPER_TRIGGER_SECRET is required/
  );
  await assert.rejects(
    dispatchBuyerDbRefresh({
      env: {
        BUYERDB_REFRESH_ENABLED: "1",
        BUYERDB_SCRAPER_TRIGGER_SECRET: "secret",
        BUYERDB_REFRESH_JOB: "invented_job"
      }
    }),
    /Unsupported BUYERDB_REFRESH_JOB/
  );
  await assert.rejects(
    dispatchBuyerDbRefresh({
      env: {
        BUYERDB_REFRESH_ENABLED: "1",
        BUYERDB_SCRAPER_TRIGGER_SECRET: "secret",
        BUYERDB_CONTROL_PLANE_URL: "http://buyerdb.example.test"
      }
    }),
    /must use HTTPS/
  );
});

test("upstream failures expose only an HTTP status, never the response body", async () => {
  const hidden = "upstream diagnostic that must stay private";
  await assert.rejects(
    dispatchBuyerDbRefresh({
      env: {
        BUYERDB_REFRESH_ENABLED: "1",
        BUYERDB_SCRAPER_TRIGGER_SECRET: "secret"
      },
      fetchImpl: async () => response(503, { error: hidden })
    }),
    (error) => {
      assert.match(error.message, /\(503\)/);
      assert.equal(error.message.includes(hidden), false);
      return true;
    }
  );
});

