import test from "node:test";
import assert from "node:assert/strict";

const OLD = {
  key: process.env.PINECONE_API_KEY,
  host: process.env.PINECONE_INDEX_HOST,
  fetch: globalThis.fetch
};

function parcel() {
  return {
    bbl: "1003720009",
    address: "60 WALL STREET",
    borough: "Manhattan",
    zip: "10005",
    zoning: "C5-5",
    bldgClass: "O4",
    landUse: "05",
    unitsRes: 0,
    bldgArea: 1400000,
    lotArea: 57853,
    builtFar: 24.2,
    maxFar: 15,
    unusedFarSf: 0,
    yearBuilt: 1989,
    owner: "60 WALL STREET OWNER LLC"
  };
}

async function mod() {
  return import(`../server/adapters/pinecone.js?test=${Date.now()}-${Math.random()}`);
}

test.afterEach(() => {
  if (OLD.key === undefined) delete process.env.PINECONE_API_KEY; else process.env.PINECONE_API_KEY = OLD.key;
  if (OLD.host === undefined) delete process.env.PINECONE_INDEX_HOST; else process.env.PINECONE_INDEX_HOST = OLD.host;
  globalThis.fetch = OLD.fetch;
});

test("Owner Pinecone text upsert uses the current Records API NDJSON contract", async () => {
  process.env.PINECONE_API_KEY = "pcsk_test";
  process.env.PINECONE_INDEX_HOST = "example-index.svc.example.pinecone.io";
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
  };

  const { upsertParcel } = await mod();
  const out = await upsertParcel(parcel());
  assert.equal(out.upserted, true);
  assert.equal(seen.url, "https://example-index.svc.example.pinecone.io/records/namespaces/nyc-parcels/upsert");
  assert.equal(seen.init.headers["Content-Type"], "application/x-ndjson");
  assert.equal(seen.init.headers["X-Pinecone-Api-Version"], "2026-04");
  assert.ok(seen.init.body.endsWith("\n"));
  const record = JSON.parse(seen.init.body.trim());
  assert.equal(record._id, "1003720009");
  assert.equal(record.bbl, "1003720009");
  assert.match(record.text, /60 WALL STREET/);
  assert.equal(Object.hasOwn(record, "records"), false);
});

test("Owner Pinecone text search remains JSON and asks for the metadata the UI renders", async () => {
  process.env.PINECONE_API_KEY = "pcsk_test";
  process.env.PINECONE_INDEX_HOST = "https://example-index.svc.example.pinecone.io/";
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({
      result: { hits: [
        { _id: "1003720009", _score: 1, fields: { address: "60 WALL STREET" } },
        { _id: "1000160010", _score: 0.91, fields: { address: "55 BATTERY PLACE", zip: "10280", bldgclass: "O4" } }
      ] }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { searchSimilar } = await mod();
  const out = await searchSimilar(parcel(), { topK: 8 });
  assert.equal(seen.url, "https://example-index.svc.example.pinecone.io/records/namespaces/nyc-parcels/search");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.equal(seen.init.headers["X-Pinecone-Api-Version"], "2026-04");
  const request = JSON.parse(seen.init.body);
  assert.equal(request.query.inputs.text.includes("60 WALL STREET"), true);
  assert.equal(request.query.top_k, 9);
  assert.deepEqual(request.query.filter, { borough: { $eq: "Manhattan" } });
  assert.ok(request.fields.includes("address"));
  assert.deepEqual(out.matches, [
    { bbl: "1000160010", score: 0.91, address: "55 BATTERY PLACE", zip: "10280", bldgclass: "O4" }
  ]);
});

test("Pinecone HTTP failures stay explicit and do not become synthetic matches", async () => {
  process.env.PINECONE_API_KEY = "pcsk_test";
  process.env.PINECONE_INDEX_HOST = "example-index.svc.example.pinecone.io";
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "field_map mismatch" }), {
    status: 400,
    headers: { "content-type": "application/json" }
  });

  const { upsertParcel } = await mod();
  const out = await upsertParcel(parcel());
  assert.equal(out.configured, true);
  assert.equal(out.upserted, false);
  assert.match(out.error, /Pinecone 400: field_map mismatch/);
});
