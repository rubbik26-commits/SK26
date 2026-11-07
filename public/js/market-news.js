// Additive UI for market headlines on the Territory Mastery surface. The
// checksum-pinned compiled application remains byte-for-byte untouched;
// this script observes the page and inserts one read-only, source-labelled
// headlines panel under the page title. Data: GET /api/news (PincusCo RSS
// + Google News RSS, pulled live server-side). A feed that cannot answer
// contributes nothing and is named in the panel footer; amounts shown are
// the amounts printed in the headlines, not verified deal data.
(() => {
  const API = "/api/news";
  const PANEL = "data-lucia-market-news";
  let request = null;
  let observerQueued = false;

  async function getJson(path) {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function titleHeading() {
    return [...document.querySelectorAll("h1,h2,h3")]
      .find((node) => node.textContent?.trim().startsWith("Know Your Market")) || null;
  }

  const money = (v) => {
    if (v === null || v === undefined) return "";
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2).replace(/\.?0+$/, "")}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
    return `$${v}`;
  };
  const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

  function panel() {
    const section = document.createElement("section");
    section.setAttribute(PANEL, "");
    section.className = "lucia-market-news";
    const head = document.createElement("div");
    head.className = "lucia-market-news__head";
    const copy = document.createElement("div");
    const h = document.createElement("h2");
    h.textContent = "Market headlines";
    const p = document.createElement("p");
    p.textContent = "NYC commercial real estate coverage, pulled live";
    copy.append(h, p);
    const source = document.createElement("span");
    source.className = "lucia-market-news__source";
    source.textContent = "RSS · live";
    head.append(copy, source);
    const body = document.createElement("div");
    body.className = "lucia-market-news__body";
    body.textContent = "Loading headlines…";
    section.append(head, body);
    return { section, body };
  }

  function render(body, data) {
    body.replaceChildren();
    const list = document.createElement("div");
    for (const item of data.items || []) {
      const row = document.createElement("div");
      row.className = "lucia-market-news__row";
      const meta = document.createElement("span");
      meta.className = "lucia-market-news__meta";
      meta.textContent = `${day(item.published)} · ${item.source || ""}`;
      const link = document.createElement("a");
      link.href = item.link;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = item.title;
      row.append(meta, link);
      if (item.amount) {
        const amt = document.createElement("b");
        amt.className = "lucia-market-news__amount";
        amt.textContent = money(item.amount);
        row.appendChild(amt);
      }
      list.appendChild(row);
    }
    body.appendChild(list);
    const src = document.createElement("p");
    src.className = "lucia-market-news__criteria";
    const states = Object.entries(data.sources || {}).map(([k, v]) => `${k}: ${v}`).join(" · ");
    src.textContent = `Feeds — ${states}. Amounts are as printed in the headlines, not verified deal data.`;
    body.appendChild(src);
  }

  async function enhance() {
    const anchor = titleHeading();
    if (!anchor || document.querySelector(`[${PANEL}]`)) return;
    const created = panel();
    const host = anchor.closest("section") || anchor.parentElement?.parentElement || anchor.parentElement;
    if (!host) return;
    host.insertAdjacentElement("afterend", created.section);
    try {
      if (!request) request = getJson(API);
      const data = await request;
      render(created.body, data);
    } catch (error) {
      request = null;
      created.body.className = "lucia-market-news__body lucia-market-news__muted";
      created.body.textContent = `Market headlines unavailable: ${error.message}`;
    }
  }

  function queueEnhance() {
    if (observerQueued) return;
    observerQueued = true;
    requestAnimationFrame(() => {
      observerQueued = false;
      enhance().catch((error) => console.warn("[market-news] UI enhancement failed:", error));
    });
  }

  const observer = new MutationObserver(queueEnhance);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", queueEnhance);
  window.addEventListener("popstate", queueEnhance);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", queueEnhance, { once: true });
  else queueEnhance();
})();
