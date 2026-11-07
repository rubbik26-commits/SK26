// NYC DOB 2026 Sustainability Laws Covered Buildings List (CBL).
// Official source: https://www.nyc.gov/assets/buildings/excel/cbl26.xlsx
//
// The workbook is intentionally parsed without a third-party XLSX dependency so
// the lightweight Render service keeps its existing dependency footprint. XLSX
// is a ZIP of XML parts; this reader supports the standard deflate/stored parts
// used by DOB's published workbook and maps the first worksheet by its headers.
//
// WHICH WORKSHEET. Measured 2026-08-19 by reading cbl26.xlsx's own workbook part:
//
//   <sheets>
//     <sheet name="Data_Dictionary"    sheetId="2" r:id="rId1"/>   -> sheet1.xml
//     <sheet name="Sustainability_CBL" sheetId="3" r:id="rId2"/>   -> sheet2.xml
//   </sheets>
//
// This module used to take `[...zip.keys()].filter(worksheet).sort()[0]`, which
// is "xl/worksheets/sheet1.xml" — the DATA DICTIONARY. Its "Column Name" column
// literally contains the strings "BBL" and "BIN", so rowsToObjects accepted it
// as the schema header and the adapter answered `live: true` with 37 rows of
// prose that can never match a lot. sustainabilityCblByBbl matched ZERO BBLs
// citywide while reporting a healthy source — a false liveness signal, which is
// exactly the failure CLAUDE.md forbids.
//
// The covered-buildings rows are in sheet2.xml: 1,048,014 <row>s, twelve
// columns — BBL, BIN, On LL97 CBL (Y/N), LL97 Compliance Pathway, On LL84 CBL
// (Y/N), Required to Report Water Data from DEP (Y/N), On LL88 CBL (Y/N), On
// LL87 (Y/N), DOF BBL Address, DOF BBL Zip Code, DOF BBL Building Count, DOF
// BBL Gross Square Footage (GSF).
//
// The worksheet is now resolved BY NAME through xl/workbook.xml and its rels,
// never by sort order, and it is read as a STREAM (see streamCblRows) because
// inflating it whole is 201 MB of resident string on a 512 MB instance.
import { inflateRawSync, createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";

const URL = "https://www.nyc.gov/assets/buildings/excel/cbl26.xlsx";
let cache = null;
const TTL = 12 * 60 * 60 * 1000;

const decodeXml = (s) => String(s ?? "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

// Reads the central directory and inflates a part only when it is asked for.
//
// This used to inflate EVERY part up front and hold them all in a Map. The
// workbook DOB publishes makes that ruinous. Measured 2026-08-18 by reading the
// central directory of https://www.nyc.gov/assets/buildings/excel/cbl26.xlsx:
//
//   download                      24,961,358 bytes
//   xl/worksheets/sheet2.xml     201,157,429 bytes uncompressed
//   xl/sharedStrings.xml           1,501,784 bytes uncompressed
//   xl/worksheets/sheet1.xml          10,785 bytes uncompressed (37 <row>s)
//
// When this comment was written only sheet1 and sharedStrings were read, so the
// 201 MB sheet2 was inflated into resident memory on every rebuild of the cache
// and then dropped unused. The interface is unchanged — get / keys / clear —
// and every part still inflates to exactly the same bytes on demand.
//
// Since 2026-08-19 sheet2 IS the sheet that matters (the header note above says
// why), so a fourth accessor was added: `raw`, which hands back the still
// compressed slice and its method so the caller can inflate it as a stream
// instead of as one 201 MB string. `get` is untouched and still the whole-part
// reader every small part uses.
//
// Compression-method validation stays eager, during the directory scan, so an
// unreadable workbook still throws here rather than at first access.
function unzip(buffer) {
  const dir = new Map();
  // Locate EOCD signature backwards (max ZIP comment length is 65535 bytes).
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Invalid XLSX ZIP: EOCD not found");
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let p = centralOffset;
  for (let i = 0; i < entries; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("Invalid XLSX ZIP central directory");
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid XLSX ZIP local header");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported XLSX ZIP compression method ${method}`);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    dir.set(name, { method, start, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  let source = buffer;
  return {
    keys: () => dir.keys(),
    // The compressed bytes and their method, for a caller that wants to inflate
    // incrementally. Returns undefined for a part this workbook does not carry.
    raw(name) {
      const e = dir.get(name);
      if (!e || !source) return undefined;
      return { method: e.method, payload: source.subarray(e.start, e.start + e.compressedSize) };
    },
    get(name) {
      const e = dir.get(name);
      if (!e || !source) return undefined;
      const payload = source.subarray(e.start, e.start + e.compressedSize);
      return e.method === 0 ? payload : inflateRawSync(payload);
    },
    clear() { dir.clear(); source = null; }
  };
}

function sharedStrings(xml) {
  if (!xml) return [];
  const values = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const pieces = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]));
    values.push(pieces.join(""));
  }
  return values;
}
function colIndex(ref) {
  const letters = String(ref || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
function parseSheet(xml, strings) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1], body = cm[2];
      const ref = attrs.match(/\br="([A-Z]+\d+)"/i)?.[1] || `A${rows.length + 1}`;
      const type = attrs.match(/\bt="([^"]+)"/i)?.[1] || "";
      const inline = body.match(/<is\b[^>]*>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/)?.[1];
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      let value = inline != null ? decodeXml(inline) : raw != null ? decodeXml(raw) : "";
      if (type === "s" && /^\d+$/.test(value)) value = strings[Number(value)] ?? "";
      if (type === "b") value = value === "1";
      cells[colIndex(ref)] = value;
    }
    rows.push(cells);
  }
  return rows;
}
function normalizeHeader(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}
function rowsToObjects(rows) {
  // DOB workbooks occasionally begin with title/note rows. Pick the first row
  // that visibly contains BBL and/or BIN as the schema header.
  const headerAt = rows.findIndex((r) => r.some((v) => /\bBBL\b|borough.?block.?lot/i.test(String(v || ""))) && r.some((v) => /\bBIN\b|building identification/i.test(String(v || ""))));
  const h = headerAt >= 0 ? headerAt : rows.findIndex((r) => r.some((v) => /\bBBL\b/i.test(String(v || ""))));
  if (h < 0) throw new Error("DOB CBL workbook header not recognized");
  const headers = rows[h].map(normalizeHeader);
  return rows.slice(h + 1).map((row) => {
    const o = {};
    headers.forEach((key, i) => { if (key) o[key] = row[i] ?? ""; });
    return o;
  }).filter((o) => Object.values(o).some((v) => String(v).trim()));
}
function findField(row, tests) {
  const entry = Object.entries(row).find(([k]) => tests.some((re) => re.test(k)));
  return entry ? entry[1] : null;
}
function cleanDigits(v) { return String(v ?? "").replace(/\.0$/, "").replace(/[^0-9]/g, ""); }

// One build at a time, shared by every waiting caller.
//
// This whole workbook — download, ZIP inflate, sheet XML string, shared-string
// table, then one object per row — is materialised to answer a single-BBL
// lookup, and the peak allocation is enormous next to the 13 KB the endpoint
// returns. Measured on this machine 2026-08-18 with `node --expose-gc`:
//
//   start                  rss 43 MB   heapUsed 4 MB
//   after import           rss 46 MB   heapUsed 4 MB
//   after ONE lookup       rss 503 MB  heapUsed 13 MB   (1.9 s)
//   after second lookup    rss 503 MB  heapUsed 13 MB   (0.0 s, cached)
//   after global gc        rss 499 MB  heapUsed 8 MB
//
// Note heapUsed: the RETAINED JavaScript is 8 MB. The other ~490 MB is the
// transient buffers and XML strings of the parse, which the allocator does not
// return to the OS. So the cost is per-PARSE, not per-cached-row.
//
// That is what made /api/cliffs the single worst endpoint in the service. With
// no in-flight guard, N concurrent first requests each ran their own download
// and parse. Measured against a fresh server:
//
//   /api/cliffs at concurrency 1  RSS 100 MB -> 316 MB  (+216 MB)
//   /api/cliffs at concurrency 8  RSS 103 MB -> 697 MB  (+594 MB)
//   every other BBL endpoint       +2 MB to +18 MB
//
// Render's instance has 512 MB, which is why the live service restarted twice
// while it was being probed and returned 502 on endpoints that answer 200 when
// probed one at a time.
//
// The guard below is a single-flight, not a new cache: the first caller builds,
// everyone who arrives during that build awaits the SAME promise, and the
// result and its TTL are exactly what they were before. A failed build is not
// cached — `inFlight` is cleared in `finally`, so the next request retries,
// which is the pre-existing behaviour (the catch returned a non-live value
// without setting `cache`).
let inFlight = null;

// Resolve the covered-buildings worksheet through the workbook's OWN metadata.
//
// xl/workbook.xml names the sheets and gives each an r:id; xl/_rels/workbook.xml.rels
// maps that r:id to the part. Measured 2026-08-19 on cbl26.xlsx the pair is
// Data_Dictionary -> worksheets/sheet1.xml and Sustainability_CBL ->
// worksheets/sheet2.xml, so name resolution and sort order disagree and the sort
// picked the dictionary.
//
// If DOB ever renames the tab, the fallback is the LARGEST worksheet part rather
// than the first: a covered-buildings list of a million lots cannot be the small
// one. Both steps are reported in the returned `sheetSource` so a future reader
// can see which rule fired instead of guessing.
function resolveCblSheetPart(zip, dirSizes) {
  const workbook = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const relTarget = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g)) {
    relTarget.set(m[1], `xl/${String(m[2]).replace(/^\.\//, "")}`);
  }
  for (const m of workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/>/g)) {
    if (/sustainab/i.test(m[1]) && /cbl/i.test(m[1])) {
      const part = relTarget.get(m[2]);
      if (part && dirSizes.has(part)) return { part, sheetSource: `named "${m[1]}" in xl/workbook.xml` };
    }
  }
  const worksheets = [...dirSizes.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!worksheets.length) return null;
  const largest = worksheets.sort((a, b) => dirSizes.get(b) - dirSizes.get(a))[0];
  return { part: largest, sheetSource: "largest worksheet part (no tab named Sustainability_CBL)" };
}

// The compressed size of every part, read straight from the central directory —
// used only to pick the largest worksheet when the tab name is missing.
function partSizes(buffer) {
  const sizes = new Map();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return sizes;
  const entries = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    const nameLen = buffer.readUInt16LE(p + 28);
    sizes.set(
      buffer.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      buffer.readUInt32LE(p + 24)
    );
    p += 46 + nameLen + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }
  return sizes;
}

// Stream one worksheet part and hand each <row> segment to `onRow` as raw XML.
//
// Measured 2026-08-19 on this machine: 1,048,014 rows in 1.3 s with RSS moving
// 150 MB -> 154 MB. The equivalent whole-part inflate is a 201 MB string, which
// is what put this endpoint over Render's 512 MB instance.
//
// `onRow` returning false stops the scan. Self-closing <row .../> elements are
// matched too so an empty row can never swallow the rest of the buffer.
const rowPattern = () => /<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g;
function streamRows(raw, onRow) {
  return new Promise((resolve, reject) => {
    const re = rowPattern();
    let tail = "", stopped = false;
    const consume = (chunk) => {
      tail += chunk;
      re.lastIndex = 0;
      let last = 0, m;
      while ((m = re.exec(tail)) !== null) {
        last = m.index + m[0].length;
        if (onRow(m[0]) === false) { stopped = true; break; }
      }
      tail = tail.slice(last);
    };
    const bytes = Readable.from([raw.payload]);
    const source = raw.method === 0 ? bytes : bytes.pipe(createInflateRaw());
    // A caller that stops early must not pay for the rest of the inflate: the
    // header read below would otherwise expand all 201 MB to look at row 1.
    const finish = () => { if (source !== bytes) bytes.destroy(); source.destroy(); resolve(); };
    bytes.on("error", reject);
    source
      .on("data", (chunk) => {
        if (stopped) return;
        consume(chunk.toString("utf8"));
        if (stopped) finish();
      })
      .on("end", () => { if (!stopped) resolve(); })
      .on("error", (e) => { if (!stopped) reject(e); });
  });
}

async function buildWorkbook() {
  try {
    const r = await fetch(URL, { headers: { "user-agent": "NYC-RE-Market-Intel/production", accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`DOB CBL HTTP ${r.status}`);
    const buffer = Buffer.from(await r.arrayBuffer());
    const zip = unzip(buffer);
    const strings = sharedStrings(zip.get("xl/sharedStrings.xml")?.toString("utf8"));
    // The worksheet is chosen by NAME from the workbook's own metadata. The old
    // line here was:
    //   const sheetName = [...zip.keys()].filter(worksheet).sort()[0];
    // which is the Data_Dictionary tab — see the note at the top of this file.
    const resolved = resolveCblSheetPart(zip, partSizes(buffer));
    if (!resolved) throw new Error("DOB CBL workbook contains no worksheet");
    // Read the HEADER row only, so the column names are resolved once per cache
    // build rather than once per lookup. parseSheet and rowsToObjects still do
    // the parsing; they are simply fed the header plus the matched rows instead
    // of a million rows at once (see sustainabilityCblByBbl).
    let headerXml = "";
    await streamRows(zip.raw(resolved.part), (row) => { headerXml = row; return false; });
    if (!headerXml) throw new Error("DOB CBL worksheet carries no rows");
    // Drop the inflated ZIP parts before the value is built, so the sheet XML and
    // the shared-string table are not all reachable at the same moment. The
    // compressed workbook itself is retained deliberately: a lookup re-opens a
    // directory view over it, which is a 24-entry scan, not an inflate.
    zip.clear();
    const value = {
      live: true, rows: [], buffer, strings, sheetPart: resolved.part, sheetSource: resolved.sheetSource, headerXml,
      source: "NYC DOB Sustainability Laws Covered Buildings List 2026", sourceUrl: URL, fetchedAt: new Date().toISOString()
    };
    cache = { expires: Date.now() + TTL, value };
    return value;
  } catch (e) {
    return { live: false, rows: [], source: "NYC DOB Sustainability Laws Covered Buildings List 2026", sourceUrl: URL, error: String(e?.message || e) };
  }
}

async function loadWorkbook() {
  if (cache && cache.expires > Date.now()) return cache.value;
  if (inFlight) return inFlight;
  inFlight = buildWorkbook().finally(() => { inFlight = null; });
  return inFlight;
}

// One answered lookup per BBL, so a dossier reopened on the same lot does not
// re-scan a million rows. Bounded and evicted oldest-first, in the same shape as
// the tile cache in server/production-lot-tiles.js — an unbounded map keyed by
// BBL is a slow leak on a long-lived instance.
const LOOKUP_CACHE_MAX = 2000;
const lookupCache = new Map();
function lookupCacheSet(key, value) {
  if (lookupCache.has(key)) lookupCache.delete(key);
  lookupCache.set(key, value);
  while (lookupCache.size > LOOKUP_CACHE_MAX) lookupCache.delete(lookupCache.keys().next().value);
}

export async function sustainabilityCblByBbl(bbl) {
  const wanted = cleanDigits(bbl);
  if (wanted.length !== 10) return { live: false, rows: [], error: "invalid bbl", sourceUrl: URL };
  const book = await loadWorkbook();
  if (!book.live) return book;
  const cacheKey = `${book.fetchedAt}|${wanted}`;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached;
  // Scan the covered-buildings worksheet as a stream and keep only the rows
  // whose BBL cell matches. The cheap `includes` is a pre-filter over the raw
  // row XML; the precise test is the parsed column-A value, so a BBL appearing
  // in some other column (an address, a GSF figure) can never be mistaken for a
  // match.
  const zip = unzip(book.buffer);
  const raw = zip.raw(book.sheetPart);
  if (!raw) { zip.clear(); throw new Error(`DOB CBL worksheet ${book.sheetPart} missing from the cached workbook`); }
  const hits = [];
  const needle = `>${wanted}<`;
  await streamRows(raw, (row) => {
    if (!row.includes(needle)) return;
    const [cells] = parseSheet(row, book.strings);
    if (cells && cleanDigits(cells[0]) === wanted) hits.push(row);
  });
  zip.clear();
  const matches = rowsToObjects(parseSheet(book.headerXml + hits.join(""), book.strings));
  const answer = {
    live: true, source: book.source, sourceUrl: book.sourceUrl, fetchedAt: book.fetchedAt,
    bbl: wanted,
    buildings: matches.map((row) => ({
      bbl: wanted,
      bin: cleanDigits(findField(row, [/^BIN$/i, /building identification/i])) || null,
      ll97Pathway: findField(row, [/LL\s*97.*path/i, /compliance.*path/i, /article\s*32[01]/i]),
      ll97Status: findField(row, [/LL\s*97/i, /greenhouse/i]),
      ll84Status: findField(row, [/LL\s*84/i, /benchmark/i]),
      ll87Status: findField(row, [/LL\s*87/i, /audit/i]),
      ll88Status: findField(row, [/LL\s*88/i, /lighting|sub.?meter/i]),
      raw: row
    }))
  };
  lookupCacheSet(cacheKey, answer);
  return answer;
}

export { URL as DOB_SUSTAINABILITY_CBL_URL };
