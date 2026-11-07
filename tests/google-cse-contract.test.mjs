import test from "node:test";
import assert from "node:assert/strict";

const ORIGINAL = {
  key: process.env.GOOGLE_CSE_KEY,
  cx: process.env.GOOGLE_CSE_CX,
  fetch: globalThis.fetch
};

async function load() {
  return import(`../server/adapters/google-cse.js?test=${Date.now()}-${Math.random()}`);
}

test.afterEach(() => {
  if (ORIGINAL.key === undefined) delete process.env.GOOGLE_CSE_KEY; else process.env.GOOGLE_CSE_KEY = ORIGINAL.key;
  if (ORIGINAL.cx === undefined) delete process.env.GOOGLE_CSE_CX; else process.env.GOOGLE_CSE_CX = ORIGINAL.cx;
  globalThis.fetch = ORIGINAL.fetch;
});

test("Owner dossier search is unconfigured unless both Google CSE variables exist", async () => {
  delete process.env.GOOGLE_CSE_KEY;
  delete process.env.GOOGLE_CSE_CX;
  const { googleCseConfiguration, googleCseSearch } = await load();
  assert.deepEqual(googleCseConfiguration(), {
    configured: false,
    reasons: ["missing_google_cse_key", "missing_google_cse_cx"]
  });
  assert.deepEqual(await googleCseSearch("60 Wall Street"), {
    configured: false,
    hits: [],
    reasons: ["missing_google_cse_key", "missing_google_cse_cx"]
  });
});

test("Owner dossier search sends key, cx and q to the Google Custom Search JSON endpoint", async () => {
  process.env.GOOGLE_CSE_KEY = "test-google-key";
  process.env.GOOGLE_CSE_CX = "test-engine-id";
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: new URL(String(url)), init };
    return new Response(JSON.stringify({ items: [{
      title: "60 Wall Street",
      link: "https://www.loopnet.com/Listing/60-Wall-Street-New-York-NY/123/",
      displayLink: "www.loopnet.com",
      snippet: "Office property listing"
    }] }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { googleCseSearch } = await load();
  const out = await googleCseSearch('"60 Wall Street" New York');
  assert.equal(seen.url.origin, "https://customsearch.googleapis.com");
  assert.equal(seen.url.pathname, "/customsearch/v1");
  assert.equal(seen.url.searchParams.get("key"), "test-google-key");
  assert.equal(seen.url.searchParams.get("cx"), "test-engine-id");
  assert.equal(seen.url.searchParams.get("q"), '"60 Wall Street" New York');
  assert.equal(seen.url.searchParams.get("num"), "10");
  assert.equal(seen.init.method, "GET");
  assert.deepEqual(out.hits, [{
    title: "60 Wall Street",
    link: "https://www.loopnet.com/Listing/60-Wall-Street-New-York-NY/123/",
    host: "loopnet.com",
    snippet: "Office property listing"
  }]);
});

test("Google CSE provider failures remain explicit", async () => {
  process.env.GOOGLE_CSE_KEY = "test-google-key";
  process.env.GOOGLE_CSE_CX = "test-engine-id";
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
    status: 400,
    headers: { "content-type": "application/json" }
  });

  const { googleCseSearch } = await load();
  const out = await googleCseSearch("60 Wall Street");
  assert.equal(out.configured, true);
  assert.equal(out.status, 400);
  assert.equal(out.error, "API key not valid");
  assert.deepEqual(out.hits, []);
});
