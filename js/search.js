/* ============================================================
   Baker 1031 — site search (Algolia), INVESTORS ONLY.

   This module is dynamically imported by js/auth.js ONLY when a
   visitor is signed in (the soft gate). Signed-out visitors never
   load it and never see a search box anywhere, including the
   homepage.

   What it does when initialized:
   - Adds a "Search" button into the logged-in portal nav
     (.account-box). The button carries the .portal-link class so
     auth.js's applyLoggedOutNav() hides it automatically on
     logout, like every other portal link.
   - Binds Cmd/Ctrl+K and "/" to open a full-screen search overlay.
   - Takes over the page-level search inputs on the Learn,
     Glossary, Markets, and Sponsors hubs (hidden for signed-out
     visitors): focusing them opens the same overlay. The
     Performance page's #perf-search is NOT touched — that page is
     hard-gated and its input filters the gated track-record table
     locally (data that is deliberately absent from Algolia).
   - Queries the "baker1031_search" index directly over Algolia's
     REST API — no SDK, no external script.

   The Search API key below is the PUBLIC search-only key
   (safe to ship in frontend code). The index contains only
   content that is already public in the page HTML; gated data
   (performance tables, track record) is never indexed.
   ============================================================ */

const APP_ID = "B5R182P2TL";
const SEARCH_KEY = "fba02b02bc51351f5dc7de439519cb37"; // public search-only key
const INDEX = "baker1031_search";

let inited = false;
let overlay, input, results, statusEl;
let hits = [];
let selected = -1;
let debounceT = 0;
let lastQueryId = 0;

const TYPE_LABEL = { Offering: "Offering", Article: "Learn", Glossary: "Glossary", Market: "Markets", Audience: "Who we serve", Calculator: "Calculator" };

export function initSearch() {
  if (inited) { showButton(); return; }
  inited = true;
  injectStyles();
  buildOverlay();
  addNavButton();
  hookPageInputs();
  document.addEventListener("keydown", onGlobalKey);
}

/* ---------- Nav button ---------- */
function addNavButton() {
  const box = document.querySelector(".account-box");
  if (!box || box.querySelector(".nav-search-btn")) return;
  const btn = document.createElement("a");
  btn.href = "#";
  btn.className = "portal-link nav-search-btn";
  btn.setAttribute("aria-label", "Search the site");
  btn.setAttribute("title", "Search");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg><span>Search</span>';
  btn.addEventListener("click", (e) => { e.preventDefault(); openOverlay(""); });
  // Icon after the Learn link (… Performance · Learn · [icon] | Welcome).
  // The label <span> is CSS-hidden on desktop and shown in the mobile
  // hamburger dropdown. Fallback: front of the box if a page has no Learn link.
  const learn = box.querySelector(".learn-link");
  if (learn) learn.after(btn);
  else box.insertBefore(btn, box.firstChild);
}
function showButton() {
  const btn = document.querySelector(".account-box .nav-search-btn");
  if (btn) btn.style.display = "";
}

/* ---------- Page-level inputs (Learn + Glossary hubs) ---------- */
function hookPageInputs() {
  document.querySelectorAll(".learn-search input, .gl-search input, .mk-search input").forEach((el) => {
    const wrap = el.closest(".learn-search, .gl-search, .mk-search");
    if (wrap) wrap.style.display = "block"; // beats the stylesheet's display:none (signed-out default)
    el.disabled = false;
    el.placeholder = "Search the site…";
    el.addEventListener("focus", () => { openOverlay(el.value); el.blur(); });
  });
}

/* ---------- Overlay ---------- */
function buildOverlay() {
  overlay = document.createElement("div");
  overlay.id = "b1031-search";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Site search");
  overlay.innerHTML = `
    <div class="bs-panel">
      <div class="bs-bar">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
        <input type="search" placeholder="Search offerings, articles, glossary…" aria-label="Search" autocomplete="off" spellcheck="false">
        <button type="button" class="bs-close" aria-label="Close search">Esc</button>
      </div>
      <div class="bs-status" aria-live="polite"></div>
      <ul class="bs-results" role="listbox"></ul>
      <div class="bs-foot"><span>&uarr;&darr; to navigate &middot; Enter to open</span><a href="https://www.algolia.com" target="_blank" rel="noopener">Search by Algolia</a></div>
    </div>`;
  document.body.appendChild(overlay);
  input = overlay.querySelector("input");
  results = overlay.querySelector(".bs-results");
  statusEl = overlay.querySelector(".bs-status");
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeOverlay(); });
  overlay.querySelector(".bs-close").addEventListener("click", closeOverlay);
  input.addEventListener("input", () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(() => query(input.value), 140);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const h = hits[selected] || hits[0];
      if (h) window.location.href = h.url;
    }
  });
}

function openOverlay(q) {
  overlay.classList.add("open");
  document.documentElement.style.overflow = "hidden";
  input.value = q || "";
  input.focus();
  query(input.value);
}
function closeOverlay() {
  overlay.classList.remove("open");
  document.documentElement.style.overflow = "";
}
function onGlobalKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); overlay.classList.contains("open") ? closeOverlay() : openOverlay(""); return; }
  if (e.key === "Escape" && overlay.classList.contains("open")) { closeOverlay(); return; }
  if (e.key === "/" && !overlay.classList.contains("open")) {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (!typing) { e.preventDefault(); openOverlay(""); }
  }
}

/* ---------- Query + render ---------- */
async function query(q) {
  q = (q || "").trim();
  if (!q) {
    hits = []; selected = -1; results.innerHTML = "";
    statusEl.textContent = "Type to search 700+ offerings, articles, glossary terms, markets, and calculators.";
    return;
  }
  const id = ++lastQueryId;
  let json;
  try {
    const r = await fetch(`https://${APP_ID}-dsn.algolia.net/1/indexes/${INDEX}/query`, {
      method: "POST",
      headers: { "X-Algolia-Application-Id": APP_ID, "X-Algolia-API-Key": SEARCH_KEY },
      body: JSON.stringify({ query: q, hitsPerPage: 10 }),
    });
    if (!r.ok) throw new Error(String(r.status));
    json = await r.json();
  } catch (err) {
    if (id !== lastQueryId) return;
    statusEl.textContent = "Search is unavailable right now — please try again in a moment.";
    results.innerHTML = ""; hits = []; selected = -1;
    return;
  }
  if (id !== lastQueryId) return; // a newer query already rendered
  hits = json.hits || [];
  selected = hits.length ? 0 : -1;
  statusEl.textContent = hits.length ? "" : `No results for “${q}”.`;
  results.innerHTML = hits.map((h, i) => {
    const title = (h._highlightResult && h._highlightResult.title && h._highlightResult.title.value) || esc(h.title);
    const snip = (h._snippetResult && h._snippetResult.body && h._snippetResult.body.value) || esc(h.snippet || "");
    return `<li role="option" data-i="${i}" class="${i === selected ? "sel" : ""}">
      <a href="${esc(h.url)}">
        <span class="bs-type bs-type-${esc(h.type)}">${TYPE_LABEL[h.type] || esc(h.type)}</span>
        <span class="bs-main"><span class="bs-title">${title}</span>${h.kicker ? `<span class="bs-kicker">${esc(h.kicker)}</span>` : ""}<span class="bs-snip">${snip}</span></span>
      </a></li>`;
  }).join("");
  results.querySelectorAll("li").forEach((li) => {
    li.addEventListener("mouseenter", () => { setSelected(Number(li.dataset.i)); });
  });
}
function move(d) {
  if (!hits.length) return;
  setSelected((selected + d + hits.length) % hits.length);
  const li = results.querySelector("li.sel");
  if (li) li.scrollIntoView({ block: "nearest" });
}
function setSelected(i) {
  selected = i;
  results.querySelectorAll("li").forEach((li) => li.classList.toggle("sel", Number(li.dataset.i) === i));
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Styles ---------- */
function injectStyles() {
  const css = `
  .nav-search-btn { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; font-weight: 600; color: inherit; }
  .nav-search-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  /* Desktop: icon only. The word "Search" appears in the mobile hamburger
     dropdown (homepage collapses at 950px, portal pages at 720px). */
  .nav-search-btn span { display: none; }
  @media (max-width: 950px) { #home-account .nav-search-btn span { display: inline; } }
  @media (max-width: 720px) { .nav-search-btn span { display: inline; } }
  #b1031-search { position: fixed; inset: 0; z-index: 400; display: none; background: rgba(9, 14, 26, 0.45); padding: 9vh 1rem 1rem; }
  #b1031-search.open { display: block; }
  #b1031-search .bs-panel { max-width: 40rem; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 64px rgba(9, 14, 26, 0.35); display: flex; flex-direction: column; max-height: 76vh; }
  #b1031-search .bs-bar { display: flex; align-items: center; gap: 0.7rem; padding: 0.9rem 1.1rem; border-bottom: 1px solid #e4e4e4; }
  #b1031-search .bs-bar svg { width: 18px; height: 18px; flex: none; fill: none; stroke: #2b3a5f; stroke-width: 2; stroke-linecap: round; }
  #b1031-search input { flex: 1; border: 0; outline: 0; font: inherit; font-size: 1.05rem; background: none; }
  #b1031-search input::-webkit-search-cancel-button { display: none; }
  #b1031-search .bs-close { flex: none; font: inherit; font-size: 0.72rem; font-weight: 600; color: #767b85; background: #f3f4f7;
    border: 1px solid #e4e4e4; border-radius: 5px; padding: 0.2rem 0.5rem; cursor: pointer; }
  #b1031-search .bs-status { padding: 0.55rem 1.15rem; font-size: 0.85rem; color: #767b85; }
  #b1031-search .bs-status:empty { display: none; }
  #b1031-search .bs-results { list-style: none; margin: 0; padding: 0.35rem; overflow-y: auto; }
  #b1031-search .bs-results li a { display: flex; gap: 0.8rem; align-items: flex-start; padding: 0.65rem 0.8rem; border-radius: 8px; text-decoration: none; color: inherit; }
  #b1031-search .bs-results li.sel a { background: #f2f4f9; }
  #b1031-search .bs-type { flex: none; margin-top: 0.15rem; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: #2b3a5f; background: #eef1f7; border-radius: 4px; padding: 0.18rem 0.42rem; min-width: 4.6rem; text-align: center; }
  #b1031-search .bs-type-Offering { color: #fff; background: #2b3a5f; }
  #b1031-search .bs-main { display: flex; flex-direction: column; gap: 0.12rem; min-width: 0; }
  #b1031-search .bs-title { font-weight: 600; font-size: 0.95rem; line-height: 1.35; }
  #b1031-search .bs-title mark, #b1031-search .bs-snip mark { background: none; color: #2b3a5f; font-weight: 700; }
  #b1031-search .bs-kicker { font-size: 0.75rem; color: #767b85; }
  #b1031-search .bs-snip { font-size: 0.82rem; color: #4a4a4a; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  #b1031-search .bs-foot { display: flex; justify-content: space-between; align-items: center; padding: 0.55rem 1.15rem;
    border-top: 1px solid #e4e4e4; font-size: 0.72rem; color: #767b85; }
  #b1031-search .bs-foot a { color: #767b85; text-decoration: none; }
  @media (max-width: 720px) {
    #b1031-search { padding: 0; }
    #b1031-search .bs-panel { max-height: 100vh; height: 100%; border-radius: 0; }
  }`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
