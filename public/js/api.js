// Thin fetch layer with a session-scoped cache so repeat navigation is instant.
const cache = new Map();

export async function api(path, { fresh = false } = {}) {
  if (!fresh && cache.has(path)) return cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  const json = await res.json();
  cache.set(path, json);
  return json;
}
export function invalidate(prefix) {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}
export async function apiSend(path, method, body) {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// Local desk (watchlist / pipeline / canvass) — persisted in this browser.
const DESK_KEY = "nyc-intel-desk-v1";
export function desk() {
  try { return JSON.parse(localStorage.getItem(DESK_KEY)) ?? { watchlist: [], pipeline: [], canvass: [], name: "" }; }
  catch { return { watchlist: [], pipeline: [], canvass: [], name: "" }; }
}
export function saveDesk(d) { localStorage.setItem(DESK_KEY, JSON.stringify(d)); }
export function deskName() { return desk().name || ""; }
