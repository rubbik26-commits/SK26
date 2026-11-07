// Client auth state — one source of truth for the signed-in user, shared by
// the rail card and every gated page. Emits "authchange" on the window.
let current = null;
let loaded = false;

export async function me({ fresh = false } = {}) {
  if (loaded && !fresh) return current;
  try {
    const r = await fetch("/api/auth/me");
    current = await r.json();
  } catch {
    current = { signedIn: false };
  }
  loaded = true;
  return current;
}
export const user = () => current ?? { signedIn: false };
export const isSignedIn = () => !!current?.signedIn;
export const isOwner = () => ["owner", "admin"].includes(current?.role);

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.message || `${r.status}`), { code: json.error, status: r.status });
  return json;
}

export async function login(email, password) {
  current = await post("/api/auth/login", { email, password });
  loaded = true;
  window.dispatchEvent(new CustomEvent("authchange"));
  return current;
}
export async function signup(email, password, display_name) {
  current = await post("/api/auth/signup", { email, password, display_name });
  loaded = true;
  window.dispatchEvent(new CustomEvent("authchange"));
  return current;
}
export async function magicLink(email) {
  return post("/api/auth/magic", { email });
}
export async function logout() {
  await post("/api/auth/logout");
  current = { signedIn: false };
  window.dispatchEvent(new CustomEvent("authchange"));
}
export async function deleteAccount() {
  const out = await post("/api/account-delete");
  current = { signedIn: false };
  window.dispatchEvent(new CustomEvent("authchange"));
  return out;
}

// First sign-in on this browser: push the local desk up to the account, then
// keep localStorage as a cache only (audit item 45).
export async function importLocalDesk() {
  try {
    const raw = localStorage.getItem("nyc-intel-desk-v1");
    if (!raw) return;
    const d = JSON.parse(raw);
    if (localStorage.getItem("nyc-intel-desk-imported")) return;
    await post("/api/desk-import", d);
    localStorage.setItem("nyc-intel-desk-imported", "1");
  } catch { /* import is additive — never blocks sign-in */ }
}
