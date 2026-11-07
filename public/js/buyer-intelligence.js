// Additive Owner UI for buyerDB intelligence. The checksum-pinned compiled
// application remains byte-for-byte untouched; this script observes the three
// existing Owner surfaces and inserts read-only, source-labelled facts.
(() => {
  const API = "/api/buyer-intel";
  const PANEL = "data-lucia-buyer-intel";
  const matchCache = new Map();
  const historyCache = new Map();
  let opportunitiesPromise = null;
  let observerQueued = false;

  const money = (value) => {
    if (value === null || value === undefined || value === "") return "—";
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (Math.abs(n) >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${Math.round(n).toLocaleString()}`;
  };
  const date = (value) => value ? String(value).slice(0, 10) : "—";
  const cleanBbl = (value) => {
    const digits = String(value ?? "").replace(/[^0-9]/g, "");
    return /^[1-5]\d{9}$/.test(digits) ? digits : "";
  };

  async function getJson(path) {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    const body = await response.json().catch((error) => {
      console.warn(`[buyer-intel] invalid JSON from ${path}:`, error);
      return null;
    });
    if (!response.ok) {
      const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function heading(text) {
    return [...document.querySelectorAll("h1,h2,h3,h4")]
      .find((node) => node.textContent?.trim() === text) || null;
  }

  function panel(title, subtitle) {
    const section = document.createElement("section");
    section.setAttribute(PANEL, "");
    section.className = "lucia-buyer-intel";
    const head = document.createElement("div");
    head.className = "lucia-buyer-intel__head";
    const copy = document.createElement("div");
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = subtitle;
    copy.append(h, p);
    const source = document.createElement("span");
    source.className = "lucia-buyer-intel__source";
    source.textContent = "buyerDB · live";
    head.append(copy, source);
    const body = document.createElement("div");
    body.className = "lucia-buyer-intel__body";
    body.textContent = "Loading historical buyer activity…";
    section.append(head, body);
    return { section, body };
  }

  function unavailable(body, error) {
    body.className = "lucia-buyer-intel__body lucia-buyer-intel__muted";
    body.textContent = `Buyer intelligence unavailable: ${error.message}`;
  }

  function currentBbl() {
    const url = new URL(window.location.href);
    const direct = cleanBbl(url.searchParams.get("dossierBbl") || url.searchParams.get("bbl"));
    if (direct) return direct;
    const hashQuery = String(url.hash).split("?")[1] || "";
    return cleanBbl(new URLSearchParams(hashQuery).get("bbl"));
  }

  function matchesForBbl(bbl) {
    if (!matchCache.has(bbl)) {
      const request = getJson(`${API}/matches?bbl=${encodeURIComponent(bbl)}`).catch((error) => {
        matchCache.delete(bbl);
        throw error;
      });
      matchCache.set(bbl, request);
    }
    return matchCache.get(bbl);
  }

  function historyForBuyer(entityId, { borough = "Manhattan", assetType = null } = {}) {
    const params = new URLSearchParams();
    if (borough) params.set("borough", borough);
    if (assetType) params.set("assetType", assetType);
    const key = `${entityId}:${params}`;
    if (!historyCache.has(key)) {
      const request = getJson(`${API}/buyers/${encodeURIComponent(entityId)}/history?${params}`).catch((error) => {
        historyCache.delete(key);
        throw error;
      });
      historyCache.set(key, request);
    }
    return historyCache.get(key);
  }

  function buyerHistoryView(data, expectedDeals) {
    const wrap = document.createElement("div");
    wrap.className = "lucia-buyer-intel__history";
    const summary = document.createElement("p");
    summary.className = "lucia-buyer-intel__criteria";
    const total = Number(data.summary?.transactionCount || 0);
    const addressed = Number(data.summary?.addressedTransactions || 0);
    const priced = Number(data.summary?.pricedTransactions || 0);
    summary.textContent = `${total} matching buyer transaction${total === 1 ? "" : "s"} · ${addressed} property address${addressed === 1 ? "" : "es"} · ${priced} recorded price${priced === 1 ? "" : "s"}.`;
    wrap.appendChild(summary);
    if (total !== Number(expectedDeals || 0)) {
      const mismatch = document.createElement("p");
      mismatch.className = "lucia-buyer-intel__warning";
      mismatch.textContent = `Evidence count (${total}) does not match the aggregate count (${expectedDeals}). The records are shown without adjustment.`;
      wrap.appendChild(mismatch);
    }
    if (!data.transactions?.length) {
      const empty = document.createElement("p");
      empty.className = "lucia-buyer-intel__muted";
      empty.textContent = "No buyer-role transactions match these exact filters.";
      wrap.appendChild(empty);
      return wrap;
    }
    const tableWrap = document.createElement("div");
    tableWrap.className = "lucia-buyer-intel__table-wrap";
    const table = document.createElement("table");
    table.className = "lucia-buyer-intel__table lucia-buyer-intel__history-table";
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["Date", "Property address", "Borough", "Asset", "Price", "Source"]) {
      const th = document.createElement("th"); th.textContent = label; header.appendChild(th);
    }
    thead.appendChild(header);
    const tbody = document.createElement("tbody");
    for (const transaction of data.transactions) {
      const tr = document.createElement("tr");
      const values = [
        date(transaction.saleDate),
        transaction.address || "Address unavailable in source",
        transaction.borough || "—",
        transaction.assetType || "—",
        money(transaction.salePrice)
      ];
      values.forEach((value, index) => {
        const td = document.createElement("td");
        td.textContent = value;
        if (index === 1 && !transaction.address) td.className = "lucia-buyer-intel__warning";
        tr.appendChild(td);
      });
      const source = document.createElement("td");
      if (/^https?:\/\//i.test(String(transaction.sourceUrl || ""))) {
        const link = document.createElement("a");
        link.href = transaction.sourceUrl;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "Open source";
        source.appendChild(link);
      } else source.textContent = "Not recorded";
      tr.appendChild(source);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
    return wrap;
  }

  function buyerRowsTable(buyers, { compact = false, historyCriteria = { borough: "Manhattan" } } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "lucia-buyer-intel__table-wrap";
    const table = document.createElement("table");
    table.className = "lucia-buyer-intel__table";
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    const labels = compact
      ? ["Historical buyer", "Deals", "Volume", "Latest", "Contact", "Evidence"]
      : ["Historical buyer", "Deals", "Volume", "Latest", "Observed range", "Markets", "Contact", "Evidence"];
    for (const label of labels) {
      const th = document.createElement("th"); th.textContent = label; headerRow.appendChild(th);
    }
    head.appendChild(headerRow);
    const tbody = document.createElement("tbody");
    for (const buyer of buyers) {
      const tr = document.createElement("tr");
      const detailRow = document.createElement("tr");
      detailRow.hidden = true;
      detailRow.className = "lucia-buyer-intel__detail-row";
      const detailCell = document.createElement("td");
      detailCell.colSpan = labels.length;
      detailRow.appendChild(detailCell);
      const values = compact
        ? [buyer.name, String(buyer.dealCount), money(buyer.volume), date(buyer.lastDeal), buyer.hasContact ? "Available" : "Gap"]
        : [buyer.name, String(buyer.dealCount), money(buyer.volume), date(buyer.lastDeal), `${money(buyer.minPrice)}–${money(buyer.maxPrice)}`, [...buyer.assetTypes, ...buyer.boroughs].join(" · ") || "—", buyer.hasContact ? "Available" : "Gap"];
      values.forEach((value, index) => {
        const td = document.createElement("td");
        td.textContent = value;
        if (index === 0 && buyer.isSpvSuspect) td.title = "buyerDB flags this entity as a possible single-purpose vehicle";
        if (index === values.length - 1) td.className = buyer.hasContact ? "lucia-buyer-intel__ok" : "lucia-buyer-intel__gap";
        tr.appendChild(td);
      });
      const evidenceCell = document.createElement("td");
      const evidenceButton = document.createElement("button");
      evidenceButton.type = "button";
      evidenceButton.className = "lucia-buyer-intel__evidence-button";
      evidenceButton.textContent = "View addresses";
      evidenceButton.setAttribute("aria-expanded", "false");
      let loaded = false;
      evidenceButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const opening = detailRow.hidden;
        detailRow.hidden = !opening;
        evidenceButton.setAttribute("aria-expanded", String(opening));
        evidenceButton.textContent = opening ? "Hide addresses" : "View addresses";
        if (!opening || loaded) return;
        detailCell.className = "lucia-buyer-intel__muted";
        detailCell.textContent = "Loading address-linked transactions…";
        try {
          const history = await historyForBuyer(buyer.entityId, historyCriteria);
          detailCell.className = "";
          detailCell.replaceChildren(buyerHistoryView(history, buyer.dealCount));
          loaded = true;
        } catch (error) {
          detailCell.className = "lucia-buyer-intel__warning";
          detailCell.textContent = `Address history unavailable: ${error.message}`;
        }
      });
      evidenceCell.appendChild(evidenceButton);
      tr.appendChild(evidenceCell);
      tbody.append(tr, detailRow);
    }
    table.append(head, tbody); wrap.appendChild(table); return wrap;
  }

  async function enhanceDossier() {
    const anchorHeading = heading("Investor match");
    const bbl = currentBbl();
    if (!anchorHeading || !bbl || document.querySelector(`[${PANEL}="dossier"]`)) return;
    const created = panel("Historical buyer activity", "recorded transactions · separate from your manual buy boxes and Airtable relationships");
    created.section.setAttribute(PANEL, "dossier");
    const anchor = anchorHeading.closest("section") || anchorHeading.parentElement?.parentElement || anchorHeading.parentElement;
    anchor?.insertAdjacentElement("afterend", created.section);
    try {
      const data = await matchesForBbl(bbl);
      created.body.replaceChildren();
      const criteria = document.createElement("p");
      criteria.className = "lucia-buyer-intel__criteria";
      criteria.textContent = `Exact filter: ${data.target?.borough || "borough unavailable"}${data.target?.assetType ? ` · ${data.target.assetType}` : " · asset type not inferred"}. Ranked by distinct recorded purchases; each buyer can be expanded to its supporting property addresses.`;
      created.body.appendChild(criteria);
      if (data.buyers?.length) created.body.appendChild(buyerRowsTable(data.buyers, {
        compact: true,
        historyCriteria: { borough: data.target?.borough || null, assetType: data.target?.assetType || null }
      }));
      else {
        const empty = document.createElement("p"); empty.className = "lucia-buyer-intel__muted"; empty.textContent = "No historical buyers matched these exact filters."; created.body.appendChild(empty);
      }
    } catch (error) {
      if (error.status === 401 || error.status === 403) created.section.remove();
      else { console.warn("[buyer-intel] dossier enhancement failed:", error); unavailable(created.body, error); }
    }
  }

  async function enhanceInvestors() {
    const title = heading("Investor buy boxes");
    if (!title || document.querySelector(`[${PANEL}="investors"]`)) return;
    const created = panel("Most active Manhattan buyers", "buyerDB address-linked transaction history · repeat buyers (2+) · read-only and never saved into your manual pool");
    created.section.setAttribute(PANEL, "investors");
    const container = title.closest(".max-w-3xl") || title.parentElement?.parentElement?.parentElement;
    const intro = [...(container?.querySelectorAll("p") || [])].find((node) => node.textContent?.startsWith("Define each investor's criteria"));
    if (intro) intro.insertAdjacentElement("afterend", created.section);
    else container?.appendChild(created.section);
    try {
      const data = await getJson(`${API}/buyers?borough=Manhattan&minDeals=2&limit=200&rankBy=count`);
      created.body.replaceChildren();
      const criteria = document.createElement("p");
      criteria.className = "lucia-buyer-intel__criteria";
      criteria.textContent = `Manhattan only · ${data.buyers?.length || 0} repeat buyers · ranked by distinct purchases, then recorded volume. Expand any buyer for its full matching property-address history.`;
      created.body.appendChild(criteria);
      if (data.buyers?.length) created.body.appendChild(buyerRowsTable(data.buyers, { historyCriteria: { borough: "Manhattan", assetType: null } }));
      else {
        const empty = document.createElement("p");
        empty.className = "lucia-buyer-intel__muted";
        empty.textContent = "No repeat Manhattan buyer activity is available.";
        created.body.appendChild(empty);
      }
    } catch (error) {
      if (error.status === 401 || error.status === 403) created.section.remove();
      else { console.warn("[buyer-intel] investors enhancement failed:", error); unavailable(created.body, error); }
    }
  }

  async function opportunities() {
    if (!opportunitiesPromise) {
      opportunitiesPromise = getJson("/api/opportunities").then((body) => Array.isArray(body) ? body : (body?.opportunities || []));
    }
    return opportunitiesPromise;
  }

  async function enrichPipelineCard(card, bbl) {
    if (card.querySelector(`[${PANEL}]`)) return;
    const badge = document.createElement("div");
    badge.setAttribute(PANEL, "pipeline-card");
    badge.className = "lucia-buyer-intel__badge lucia-buyer-intel__muted";
    badge.textContent = "Buyer history…";
    const actionRow = card.lastElementChild;
    if (actionRow) actionRow.insertAdjacentElement("beforebegin", badge);
    else card.appendChild(badge);
    try {
      const data = await matchesForBbl(bbl);
      const top = data.buyers?.[0];
      if (!top) { badge.textContent = "No historical buyer match"; return; }
      badge.classList.remove("lucia-buyer-intel__muted");
      badge.textContent = `${top.name} · ${top.dealCount} deal${top.dealCount === 1 ? "" : "s"}${top.hasContact ? " · contact available" : " · contact gap"}`;
      badge.title = `buyerDB historical activity; ${data.target?.borough || "borough unavailable"}${data.target?.assetType ? `; ${data.target.assetType}` : "; asset type not inferred"}`;
      const evidence = document.createElement("div");
      evidence.setAttribute(PANEL, "pipeline-address");
      evidence.className = "lucia-buyer-intel__pipeline-address lucia-buyer-intel__muted";
      evidence.textContent = "Loading latest matching property address…";
      badge.insertAdjacentElement("afterend", evidence);
      try {
        const history = await historyForBuyer(top.entityId, {
          borough: data.target?.borough || null,
          assetType: data.target?.assetType || null
        });
        const latest = history.transactions?.[0];
        evidence.classList.remove("lucia-buyer-intel__muted");
        evidence.textContent = latest
          ? `Latest matched purchase · ${latest.address || "address unavailable in source"} · ${date(latest.saleDate)} · ${money(latest.salePrice)}`
          : "No address-linked purchase matches these exact filters.";
        if (latest?.sourceUrl && /^https?:\/\//i.test(latest.sourceUrl)) evidence.title = `Source: ${latest.sourceUrl}`;
      } catch (error) {
        console.warn(`[buyer-intel] pipeline address history failed for ${bbl}:`, error);
        evidence.textContent = "Address-linked history unavailable.";
      }
    } catch (error) {
      if (error.status === 401 || error.status === 403) badge.remove();
      else { console.warn(`[buyer-intel] pipeline enrichment failed for ${bbl}:`, error); badge.textContent = "Buyer history unavailable"; }
    }
  }

  async function enhancePipeline() {
    if (!heading("Pipeline / CRM")) return;
    const cards = [...document.querySelectorAll('[data-testid^="pcard-"]')].filter((card) => !card.querySelector(`[${PANEL}]`));
    if (!cards.length) return;
    let rows;
    try { rows = await opportunities(); }
    catch (error) { console.warn("[buyer-intel] opportunity mapping unavailable:", error); return; }
    const byId = new Map(rows.map((row) => [String(row?.id ?? ""), cleanBbl(row?.bbl)]).filter(([, bbl]) => bbl));
    const jobs = [];
    for (const card of cards) {
      const id = String(card.getAttribute("data-testid") || "").slice("pcard-".length);
      const bbl = byId.get(id);
      if (bbl) jobs.push(() => enrichPipelineCard(card, bbl));
    }
    for (let i = 0; i < jobs.length; i += 3) await Promise.all(jobs.slice(i, i + 3).map((job) => job()));
  }

  async function enhance() {
    await Promise.all([enhanceDossier(), enhanceInvestors(), enhancePipeline()]);
  }

  function queueEnhance() {
    if (observerQueued) return;
    observerQueued = true;
    requestAnimationFrame(() => {
      observerQueued = false;
      enhance().catch((error) => console.warn("[buyer-intel] UI enhancement failed:", error));
    });
  }

  const observer = new MutationObserver(queueEnhance);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", queueEnhance);
  window.addEventListener("popstate", queueEnhance);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", queueEnhance, { once: true });
  else queueEnhance();
})();
