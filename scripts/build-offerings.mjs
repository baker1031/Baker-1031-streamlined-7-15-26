/* ============================================================
   Build step: Google Sheet "Master Listings" → static site data.

   Runs during every Netlify build (see netlify.toml):
   1. Fetches the sheet as CSV (public gviz export — no API key).
   2. Writes data/offerings.json (machine-readable data source).
   3. Generates a permanent static page per offering at
      offerings/<slug>/index.html from offering-template.html,
      with per-page <title>, meta description, canonical, Open
      Graph tags and JSON-LD for SEO / LLM discoverability.
   4. Bakes the listing cards + filter pills into
      current-offerings.html (between OFFERINGS/FILTERS markers).
   5. Regenerates sitemap.xml.

   No dependencies — plain Node 18+. Run locally:
     node scripts/build-offerings.mjs
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseCSV } from "./lib/csv.mjs";
import { esc, truncate, slugify, put } from "./lib/html.mjs";
import { optimizedPhoto, directDownload } from "./lib/images.mjs";
import { injectPartials } from "./lib/partials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHEET_ID = "1vTqb5YX8pFjZxToGd2pJ_ncPbny2PXpW5gXx-7IlyZg";
const SHEET_TAB = "Master Listings";
const DOCS_TAB = "Documents";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`;
const DOCS_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(DOCS_TAB)}`;
const SITE = "https://baker1031.com";



/* ---------------- Partial injection (footer etc.) ----------------
   partials/*.html are the single source of truth; every page keeps its
   last-baked copy between PARTIAL markers so it still previews locally. */
for (const shell of ["index.html", "current-offerings.html", "templates/offering.html", "templates/performance.html"]) {
  const p = join(ROOT, shell);
  writeFileSync(p, injectPartials(readFileSync(p, "utf8"), ROOT, shell));
}
console.log("Partials injected into page shells + templates.");

/* ---------------- Fetch & normalize ---------------- */
console.log("Fetching Master Listings…");
const res = await fetch(CSV_URL, { redirect: "follow" });
if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
const csv = await res.text();
const rows = parseCSV(csv);
const headers = rows[0].map((h) => h.trim());
const col = (name) => headers.indexOf(name);
if (col("Investment Name") === -1) throw new Error("Sheet is missing 'Investment Name' — wrong tab?");

const offerings = rows.slice(1)
  .filter((r) => (r[col("Investment Name")] || "").trim())
  .map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    o._slug = slugify(o["URL"] || o["Investment Name"]);
    return o;
  });

// Guard: a broken/empty sheet must fail the build, not blank the site
if (offerings.length < 10) {
  throw new Error(`Only ${offerings.length} offerings parsed — refusing to build (sheet problem?).`);
}
// De-dupe slugs deterministically (append the sponsor, then a counter)
// so no page silently overwrites another; log every collision.
{
  const seen = new Set();
  const dupes = [];
  for (const o of offerings) {
    if (seen.has(o._slug)) {
      const base = o._slug;
      const withSponsor = `${base}-${slugify(o["Sponsor"])}`;
      o._slug = seen.has(withSponsor) ? `${withSponsor}-2` : withSponsor;
      let n = 3;
      while (seen.has(o._slug)) o._slug = `${withSponsor}-${n++}`;
      dupes.push(`"${o["Investment Name"]}" → ${o._slug}`);
    }
    seen.add(o._slug);
  }
  if (dupes.length) console.warn(`WARNING: duplicate slugs de-duped:\n  ${dupes.join("\n  ")}`);
}
console.log(`Parsed ${offerings.length} offerings, ${headers.length} columns.`);

/* ---------------- Documents tab (per-offering document lists) ---------------- */
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const docsByName = new Map(); // normalized Investment Name -> [{label, file, gated}]
{
  const res2 = await fetch(DOCS_CSV_URL, { redirect: "follow" });
  if (!res2.ok) throw new Error(`Documents tab fetch failed: ${res2.status}`);
  const dRows = parseCSV(await res2.text());
  const dh = dRows[0].map((h) => h.trim());
  const di = (n) => dh.indexOf(n);
  if (di("Investment Name") === -1 || di("Label") === -1 || di("File") === -1) {
    throw new Error("Documents tab is missing Investment Name / Label / File columns");
  }
  for (const r of dRows.slice(1)) {
    const name = (r[di("Investment Name")] || "").trim();
    const label = (r[di("Label")] || "").trim();
    const file = (r[di("File")] || "").trim();
    if (!name || !label || !file) continue;
    const key = normName(name);
    if (!docsByName.has(key)) docsByName.set(key, []);
    docsByName.get(key).push({ label, file, gated: (r[di("Gated?")] || "").trim() });
  }
  console.log(`Documents tab: ${[...docsByName.values()].reduce((a, b) => a + b.length, 0)} documents for ${docsByName.size} offerings.`);
}


/* Find an offering's documents: exact normalized-name match first, then a
   unique token-subset match (handles small naming variants between tabs). */
function docsFor(name) {
  const key = normName(name);
  if (docsByName.has(key)) return docsByName.get(key);
  const tokens = new Set(key.split(" "));
  const candidates = [];
  for (const [k, v] of docsByName) {
    const kt = k.split(" ");
    const kset = new Set(kt);
    const subset = kt.every((t) => tokens.has(t)) || [...tokens].every((t) => kset.has(t));
    if (subset) candidates.push(v);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/* ---------------- Display rules ---------------- */
function displayDebt(o) {
  const d = (o["Debt"] || "").replace(/[\s,]/g, "");
  return (d === "$0" || d === "0") ? "All-Cash" : (o["Debt"] || "");
}
const STATUS_ORDER = ["Available", "Limited Availability", "Accepting Backup Reservations", "Coming Soon / Under Review", "Closed"];
function statusRank(s) {
  const i = STATUS_ORDER.indexOf((s || "").trim());
  return i === -1 ? 3.5 : i;
}
function statusClass(s) {
  return {
    "Available": "",
    "Limited Availability": "limited",
    "Accepting Backup Reservations": "backup",
    "Coming Soon / Under Review": "soon",
    "Closed": "closed"
  }[(s || "").trim()] ?? "soon";
}
const isClosed = (o) => (o["Status"] || "").trim() === "Closed";

/* ---------------- 1) data/offerings.json ---------------- */
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "offerings.json"), JSON.stringify({
  generated: new Date().toISOString(),
  source: "Google Sheet — Master Listings",
  count: offerings.length,
  offerings: offerings.map((o) => {
    const out = { slug: o._slug, page: `/offerings/${o._slug}/` };
    for (const h of headers) if (h) out[h] = o[h];
    return out;
  })
}));
console.log("Wrote data/offerings.json");

/* ---------------- 2) Per-offering static pages ---------------- */
const template = readFileSync(join(ROOT, "templates", "offering.html"), "utf8");

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Replace inner content of every element carrying data-field="name".
   Template markup keeps each such element's open tag on one line and the
   value inline, with no nested same-tag elements (verified for all fields
   handled here except "Available Equity", handled specially). */
function setField(html, field, value) {
  const re = new RegExp(
    `(<([a-z0-9]+)[^>]*\\bdata-field="${reEsc(field)}"[^>]*>)[\\s\\S]*?(</\\2>)`,
    "g"
  );
  return html.replace(re, (_, open, _tag, close) => `${open}${esc(value)}${close}`);
}
function setImg(html, field, src, alt) {
  const re = new RegExp(`<img([^>]*\\bdata-field="${reEsc(field)}"[^>]*)>`, "g");
  return html.replace(re, (m, attrs) => {
    let a = attrs.replace(/\bsrc="[^"]*"/, () => `src="${esc(src)}"`);
    if (alt) a = /\balt="/.test(a) ? a.replace(/\balt="[^"]*"/, () => `alt="${esc(alt)}"`) : `${a} alt="${esc(alt)}"`;
    return `<img${a}>`;
  });
}

function buildPage(o) {
  let html = template;
  const name = o["Investment Name"];
  const canonical = `${SITE}/offerings/${o._slug}/`;
  const photo = o["Photo Link Use"] || o["Property Photo Link"] || "";
  const metaDesc = truncate(o["Description"], 158) ||
    `${name} — ${o["Structure"] || "DST"} offering from ${o["Sponsor"]} presented by Baker 1031 Investments.`;

  /* ----- asset paths (page lives two levels deep) ----- */
  html = html.replace(/(href|src)="(css|js|assets|documents)\//g, `$1="/$2/`);

  /* ----- header: same account box as the portal directory. Welcome/Log Out
     start hidden; js/auth.js reveals them for signed-in investors and shows
     the login link to everyone else (the soft gate handles access). ----- */
  html = html.replace(
    /<div class="account-box">[\s\S]*?<\/div>/,
    `<style>
        .nav-sep { width: 1px; height: 1.1rem; background: var(--hairline); }
        .nav-toggle { display: none; background: none; border: none; cursor: pointer; color: var(--ink); padding: 0.4rem; }
        @media (max-width: 720px) {
          .main-header-inner { position: relative; }
          .nav-toggle { display: inline-flex; }
          .account-box { display: none; position: absolute; top: 100%; right: 1rem; background: #fff;
            border: 1px solid var(--hairline); border-radius: 8px; padding: 1rem 1.25rem;
            flex-direction: column; align-items: flex-start; gap: 0.9rem;
            box-shadow: 0 12px 32px rgba(9, 14, 26, 0.12); z-index: 90; }
          .account-box.open { display: flex; }
          .nav-sep { width: 100%; height: 1px; }
        }
      </style>
      <button class="nav-toggle" type="button" aria-label="Menu" aria-expanded="false" onclick="var b=this.nextElementSibling;var o=b.classList.toggle('open');this.setAttribute('aria-expanded',o)">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
      <div class="account-box">
        <div class="nav-home portal-link" style="display:none">
          <a class="nav-home-link" href="/">Home</a>
          <button class="nav-home-toggle" type="button" aria-label="Homepage sections" aria-expanded="false" aria-haspopup="true"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
          <div class="nav-home-menu" role="menu">
            <a role="menuitem" href="/#strategies">Strategies</a>
            <a role="menuitem" href="/#why">Difference</a>
            <a role="menuitem" href="/#full-cycle">Performance</a>
            <a role="menuitem" href="/#about">About</a>
          </div>
        </div>
        <a class="listings-link portal-link" href="/current-offerings.html" style="display:none;font-weight:600;font-size:0.9rem">Listings</a>
        <a class="performance-link portal-link" href="/performance.html" style="display:none;font-weight:600;font-size:0.9rem">Performance</a>
        <a class="learn-link portal-link" href="/learn.html" style="display:none;font-weight:600;font-size:0.9rem">Learn</a>
        <span class="nav-sep" style="display:none"></span>
        <span class="welcome" style="display:none">Welcome, <span data-field="First Name">[First Name]</span></span>
        <a class="logout" style="display:none" href="#">Log Out</a>
        <a class="logout" id="investor-login" href="#">Investor Login</a>
      </div>`
  );

  /* ----- breadcrumb / back links ----- */
  html = html.replace(/<a href="#">Current Offerings<\/a>/, `<a href="/current-offerings.html">Current Offerings</a>`);
  html = html.replace(/(<a class="back-link" href=")#(")/, `$1/current-offerings.html$2`);

  /* ----- head: title / meta / canonical / OG / JSON-LD ----- */
  const headBits = [
    `<link rel="canonical" href="${canonical}">`,
    `<meta name="description" content="${esc(metaDesc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(name)} | Baker 1031 Investments">`,
    `<meta property="og:description" content="${esc(metaDesc)}">`,
    photo ? `<meta property="og:image" content="${esc(optimizedPhoto(photo, 1200))}">` : "",
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:site_name" content="Baker 1031 Investments">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": canonical,
          "name": `${name} — ${o["Structure"] || "DST"} Offering`,
          "description": metaDesc,
          "url": canonical,
          ...(o["Last Updated"] ? { "dateModified": o["Last Updated"] } : {}),
          "isPartOf": { "@type": "WebSite", "name": "Baker 1031 Investments", "url": SITE }
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/" },
            { "@type": "ListItem", "position": 2, "name": "Current Offerings", "item": SITE + "/current-offerings.html" },
            { "@type": "ListItem", "position": 3, "name": name, "item": canonical }
          ]
        }
      ]
    })}</script>`
  ].filter(Boolean).join("\n");
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${esc(name)} | ${esc(o["Structure"] || "DST")}${o["Property Type"] ? " " + esc(o["Property Type"]) : ""} Offering | Baker 1031 Investments</title>\n${headBits}`
  );

  /* ----- Available Equity cell (contains the nested % small tag) ----- */
  html = html.replace(
    /(<span class="value" data-field="Available Equity">)[\s\S]*?(<\/span>)(?=\s*<\/div>)/,
    (_, open, close) => `${open}${esc(o["Available Equity"] || "")}${o["Available Percentage"] ? ` <small data-field="Available Percentage">${esc(o["Available Percentage"])} available</small>` : ""}${close}`
  );

  /* ----- straight sheet-column → data-field fills ----- */
  const direct = [
    "Investment Name", "Sponsor", "Total Offering", "Equity", "In-Place LTV",
    "Status", "Property Type", "Location (Use)", "Total Load", "Strategy",
    "721 Exchange Exit", "Estimated Hold Period", "Minimum Investment",
    "Average Yield", "Cap Rate Equivalent", "Tax Adjusted Yield (Use)",
    "Description", "Highlight 1", "Highlight 2", "Highlight 3", "Highlight 4", "Highlight 5",
    "Insights", "Pros", "Cons",
    "Y1", "Y2", "Y3", "Y4", "Y5", "Y6", "Y7", "Y8", "Y9", "Y10",
    "Lender", "Interest Rate", "Loan Term", "I/O Period", "Amortization", "Y1 DSCR",
    "Sponsor Description", "Full-Cycle Count", "Sponsor AAR", "Sponsor AEM",
    "Sponsor Hold", "Sponsor Success",
    "BM: Avg. Income - Deal", "BM: Avg. Income - MKT", "BM: Avg. Income - Interpret",
    "BM: Growth - Deal", "BM: Growth- MKT", "BM: Growth - Interpret",
    "BM: Peak - Deal", "BM: Peak- MKT", "BM: Peak - Interpret"
  ];
  for (const f of direct) html = setField(html, f, o[f] || "");

  /* ----- special values ----- */
  html = setField(html, "Debt", displayDebt(o));
  // Renumber the sheet's legacy footnote marker (⁹) to ¹ — it's the first
  // and only footnote on the generated pages
  html = setField(html, "Tax Adj Label", (o["Tax Adj Label"] || "").replace(/⁹/g, "¹"));

  /* ----- methodology footnotes (language recovered from the prior live site) ----- */
  html = html.replace(/&#8313; \[Tax-adjusted yield methodology footnote[\s\S]*?\]/,
    "&#185; Estimated Tax-Adjusted Yield reflects the projected impact of depreciation and amortization deductions at an assumed combined federal and state tax rate; individual tax outcomes vary &mdash; consult your CPA regarding your specific situation. Cap Rate Equivalent is a Baker 1031 Investments calculation intended to allow comparison with direct property ownership; it is not a sponsor-reported figure and does not represent a rate of return.");
  html = html.replace(/<p class="note">\[Benchmark methodology footnote[\s\S]*?<\/p>/,
    `<p class="note">Benchmarks compare this offering&rsquo;s projected figures against sector medians computed across current offerings tracked by Baker 1031 Investments as of the last-updated date shown. Benchmark data is internal, unaudited, and subject to change.</p>`);

  /* ----- soft gate: full page content stays in the HTML (crawlable), but
     js/auth.js shows this overlay to human visitors who aren't logged in.
     Hidden by default so crawlers and logged-in investors never see it. ----- */
  const gate = `
  <style>
    #offering-gate { display: none; position: fixed; inset: 0; z-index: 400;
      background: rgba(13, 20, 38, 0.55); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
      align-items: center; justify-content: center; padding: 1.5rem; }
    #offering-gate .gate-card { background: #fff; border-radius: 12px; max-width: 26.5rem; width: 100%;
      padding: 2.4rem 2.2rem 2.1rem; text-align: center; box-shadow: 0 18px 48px rgba(9, 14, 26, 0.45); }
    #offering-gate .gate-card img { height: 40px; width: auto; margin-bottom: 1.2rem; }
    #offering-gate h3 { font-size: 1.15rem; font-weight: 700; color: #2f3237; margin-bottom: 0.5rem; }
    #offering-gate p { font-size: 0.9rem; line-height: 1.55; color: #5b6069; margin-bottom: 1.4rem; }
    #offering-gate .gate-login { display: block; width: 100%; background: var(--navy); color: #fff;
      font-size: 0.92rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 0.8rem 1rem; border-radius: 6px; margin-bottom: 0.7rem; }
    #offering-gate .gate-login:hover { background: var(--navy-dark); }
    #offering-gate .gate-request { display: block; width: 100%; font-size: 0.92rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em; color: var(--navy); border: 1px solid #cfd4dd;
      padding: 0.8rem 1rem; border-radius: 6px; }
    #offering-gate .gate-request:hover { border-color: var(--navy); }
    #offering-gate .gate-note { font-size: 0.74rem; color: #8a8f99; margin: 1.1rem 0 0; }
  </style>
  <div id="offering-gate" role="dialog" aria-modal="true" aria-label="Investor access required">
    <div class="gate-card">
      <img src="https://res.cloudinary.com/opoazlei/image/upload/v1783843015/76c3b97b-a853-46f1-bf6f-19285b0754f8_l5pbup.png" alt="Baker 1031 Investments">
      <h3>Verified investors only</h3>
      <p>Full offering details, projections, and documents for ${esc(name)} are available to verified accredited investors.</p>
      <a class="gate-login" id="offering-gate-login" href="#">Investor Log In</a>
      <a class="gate-request" href="/?request-access=1">Request Investment Access</a>
      <p class="gate-note">Access is provisioned after a brief introductory call. Questions? invest@baker1031.com</p>
    </div>
  </div>`;
  html = html.replace(/<\/body>/, `${gate}\n</body>`);
  html = setField(html, "Investment Firm", o["Sponsor"] || "");
  html = setField(html, "Year Founded", o["Sponsor Founded"] || "");

  /* ----- sponsor meta line: drop HQ + external-website segments (no sheet
     columns for them; sponsor profile pages are a later phase) ----- */
  html = html.replace(/\s*&middot;\s*<span data-field="Headquarters \(City, State\)">[\s\S]*?<\/span>\s*&middot;\s*<a [^>]*data-field="Website">[\s\S]*?<\/a>/, "");
  if (!o["Sponsor Founded"]) {
    html = html.replace(/Founded <span data-field="Year Founded"><\/span>/, "");
  }

  /* ----- sponsor logo ----- */
  if (o["Sponsor Image"]) html = setImg(html, "Sponsor Image", o["Sponsor Image"], o["Sponsor"]);
  else html = html.replace(/<img([^>]*data-field="Sponsor Image"[^>]*)>/, `<img$1 style="display:none">`);

  /* ----- advantages list: no sheet columns — remove the block ----- */
  html = html.replace(/<ul class="advantages">[\s\S]*?<\/ul>\s*/, "");

  /* ----- hero photo ----- */
  if (photo) html = setImg(html, "Photo Link Use", optimizedPhoto(photo, 1600), `${name} property photo`);

  /* ----- benchmark chips: above/below class from Interpret text ----- */
  html = html.replace(
    /<span class="bm-chip[^"]*"( data-field="(BM:[^"]*Interpret)")/g,
    (m, tail, field) => {
      const val = (o[field] || "").toLowerCase();
      const dir = val.includes("above") ? " above" : val.includes("below") ? " below" : "";
      return `<span class="bm-chip${dir}"${tail}`;
    }
  );

  /* ----- documents: per-offering list from the sheet's Documents tab,
     falling back to DD Label / DD Folder Link when no rows exist ----- */
  {
    const docList = docsFor(name);
    let items;
    if (docList && docList.length) {
      items = docList.map((d) => {
        const href = directDownload(d.file);
        const isVideo = /vimeo\.com|youtube\.com|youtu\.be/.test(href);
        return `        <li><span data-field="Label">${esc(d.label)}</span><a class="download" href="${esc(href)}" target="_blank" rel="noopener" data-gated="${esc(d.gated || "No")}">${isVideo ? "Watch" : "Download"}</a></li>`;
      }).join("\n");
    } else {
      const label = o["DD Label"] || "Offering Documents Available By Request";
      const link = o["DD Folder Link"] || "";
      const anchor = link
        ? `<a class="download" href="${esc(link)}" target="_blank" rel="noopener">Open Documents</a>`
        : `<a class="download" href="mailto:invest@baker1031.com?subject=${encodeURIComponent("Document request: " + name)}">Request Documents</a>`;
      items = `        <li><span data-field="Label">${esc(label)}</span>${anchor}</li>`;
    }
    html = html.replace(
      /(<ul class="doc-list" data-field="Documents">)[\s\S]*?(<\/ul>)/,
      (_, open, close) => `${open}\n${items}\n      ${close}`
    );
  }

  /* ----- hide cells whose value came out empty (shorter holds, coming-soon
     deals, sponsors without full-cycle stats) ----- */
  html = html.replace(
    /<div class="(stat-cell|fin-cell|year-cell|sponsor-stat)">((?:<span[^>]*>[\s\S]*?<\/span>)+)<\/div>/g,
    (m, cls, inner) => {
      const valueEmpty = /<span class="(?:value|rate)"[^>]*><\/span>/.test(inner)
        // the tax-adjusted cell: hide when the yield value is empty
        || /data-field="Tax Adjusted Yield \(Use\)"><\/span>/.test(inner);
      return valueEmpty ? "" : m;
    }
  );
  // analysis highlights with no content
  html = html.replace(/<div class="analysis-item"><p [^>]*><\/p><\/div>\s*/g, "");
  // benchmarks: hide the whole section if the sheet has no benchmark data
  if (!o["BM: Avg. Income - Deal"] && !o["BM: Growth - Deal"] && !o["BM: Peak - Deal"]) {
    html = html.replace(/<section id="benchmarks">[\s\S]*?<\/section>/, "");
    html = html.replace(/<a href="#benchmarks">Benchmarks<\/a>\s*/, "");
    html = html.replace(/<option value="#benchmarks">Benchmarks<\/option>\s*/, "");
  }
  // distributions: hide if there's no yield schedule at all (e.g. OZ funds)
  if (!o["Y1"] && !o["Average Yield"]) {
    html = html.replace(/<section id="distributions">[\s\S]*?<\/section>/, "");
    html = html.replace(/<a href="#distributions">Distributions<\/a>\s*/, "");
    html = html.replace(/<option value="#distributions">Distributions<\/option>\s*/, "");
  }

  return html;
}

let pageCount = 0;
for (const o of offerings) {
  const dir = join(ROOT, "offerings", o._slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), buildPage(o));
  pageCount++;
}
console.log(`Wrote ${pageCount} offering pages under /offerings/`);

/* ---------------- 3) Listing cards + filter pills ---------------- */
let closedCardsHtml = ""; // rendered on the Performance page's "Recently Closed" tab
{
  const listingPath = join(ROOT, "current-offerings.html");
  let listing = readFileSync(listingPath, "utf8");
  // Closed offerings move off the inventory and onto the Performance page
  const open = offerings.filter((o) => !isClosed(o));
  const closed = offerings.filter(isClosed);
  // Default order: newest first — the sheet grows downward, so reverse the
  // worksheet row order (bottom of the sheet = newest = top of the page)
  const sorted = [...open].reverse();

  const makeCard = (o) => {
    const page = `/offerings/${o._slug}/`;
    const photo = o["Photo Link Use"] || o["Property Photo Link"] || "";
    const tag = slugify(o["Property Type"] || "other");
    const pctNum = parseFloat(o["Available Percentage"]) || 0;
    const sChip = statusClass(o["Status"]);
    return `      <article class="offering-card" data-tags="${esc(tag)}">
        <a class="card-photo" href="${page}">
          ${photo ? `<img src="${esc(optimizedPhoto(photo, 640))}" alt="${esc(o["Investment Name"])}" loading="lazy">` : ""}
          <span class="status-chip${sChip ? " " + sChip : ""}">${esc(o["Status"])}</span>
          <span class="type-chip">${esc(o["Property Type"] || "")}</span>
        </a>
        <div class="card-body">
          <h3><a href="${page}" style="color:inherit">${esc(o["Investment Name"])}</a></h3>
          <div class="sponsor-line">${esc(o["Sponsor"] || "")}</div>
          <div class="card-stats">
            <div class="cs"><span class="label">Min Investment</span><span class="value">${esc(o["Minimum Investment"] || "—")}</span></div>
            <div class="cs"><span class="label">Avg Yield</span><span class="value">${esc(o["Average Yield"] || "—")}</span></div>
            <div class="cs"><span class="label">LTV</span><span class="value">${esc(o["In-Place LTV"] || "—")}</span></div>
            <div class="cs"><span class="label">Strategy</span><span class="value">${esc(o["Strategy"] || "—")}</span></div>
            <div class="cs"><span class="label">Est. Hold</span><span class="value">${esc(o["Estimated Hold Period"] || "—")}</span></div>
            <div class="cs"><span class="label">Location</span><span class="value">${esc(o["Location (Use)"] || "—")}</span></div>
          </div>
          <div class="availability">
            <div class="bar"><div class="fill" style="width: ${isClosed(o) ? 0 : Math.min(100, Math.max(0, pctNum))}%"></div></div>
            <span class="cap">${isClosed(o) ? "Fully subscribed &middot; closed" : `${esc(o["Available Percentage"] || "—")} of equity still available &middot; ${esc(o["Available Equity"] || "")}`}</span>
          </div>
          <a class="view-btn" href="${page}">View Offering</a>
        </div>
      </article>`;
  };
  const cards = sorted.map(makeCard).join("\n");

  // "Recently closed" — newest Last Updated first (fall back to name order)
  const dateVal = (o) => {
    const t = Date.parse(o["Last Updated"] || "");
    return Number.isNaN(t) ? 0 : t;
  };
  const closedSorted = [...closed].sort((a, b) =>
    dateVal(b) - dateVal(a) || a["Investment Name"].localeCompare(b["Investment Name"])
  );
  closedCardsHtml = closedSorted.length
    ? closedSorted.map(makeCard).join("\n")
    : `      <p class="page-note">No recently closed offerings.</p>`;

  // Filter pills from the property types actually present
  const types = [...new Set(sorted.map((o) => (o["Property Type"] || "").trim()).filter(Boolean))].sort();
  const pills = [`      <button type="button" class="active" data-filter="all">All</button>`]
    .concat(types.map((t) => `      <button type="button" data-filter="${esc(slugify(t))}">${esc(t)}</button>`))
    .join("\n");

  const put = (src, startMark, endMark, content) => {
    const s = src.indexOf(startMark), e = src.indexOf(endMark);
    if (s === -1 || e === -1) throw new Error(`Missing ${startMark}/${endMark} markers`);
    return src.slice(0, s + startMark.length) + "\n" + content + "\n      " + src.slice(e);
  };
  listing = put(listing, "<!-- OFFERINGS:START -->", "<!-- OFFERINGS:END -->", cards);
  listing = put(listing, "<!-- FILTERS:START -->", "<!-- FILTERS:END -->", pills);
  writeFileSync(listingPath, listing);
  console.log(`Baked ${sorted.length} open cards + ${types.length} filter pills into current-offerings.html (${closed.length} closed → performance page)`);
}

/* ---------------- 4) performance.html — Sponsor Track Record ---------------- */
{
  const PERF_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent("Sponsor Trackrecord")}`;
  const resP = await fetch(PERF_CSV_URL, { redirect: "follow" });
  if (!resP.ok) throw new Error(`Sponsor Trackrecord fetch failed: ${resP.status}`);
  const pRows = parseCSV(await resP.text());
  const ph = pRows[0].map((h) => h.trim());
  const pi = (n) => ph.indexOf(n);
  for (const need of ["Sponsor", "Investment", "Hold Period", "Equity Multiple", "Annual Return"]) {
    if (pi(need) === -1) throw new Error(`Sponsor Trackrecord tab is missing '${need}'`);
  }
  const deals = pRows.slice(1)
    .filter((r) => (r[pi("Sponsor")] || "").trim() && (r[pi("Investment")] || "").trim())
    .map((r) => ({
      sponsor: r[pi("Sponsor")].trim(),
      investment: r[pi("Investment")].trim(),
      location: (r[pi("Location")] || "").trim(),
      assetClass: (r[pi("Asset Class")] || "").trim(),
      hold: (r[pi("Hold Period")] || "").trim(),
      multiple: (r[pi("Equity Multiple")] || "").trim(),
      annual: (r[pi("Annual Return")] || "").trim()
    }));
  if (deals.length < 50) throw new Error(`Only ${deals.length} track-record rows — refusing to build.`);

  // Clean malformed multiples like "2.x" / ".x" (missing digits in the sheet)
  const cleanMult = (m) => /^\d*\.?\d+x$/i.test(m) ? m : "";
  deals.sort((a, b) => a.sponsor.localeCompare(b.sponsor) || a.investment.localeCompare(b.investment));

  const rowsHtml = deals.map((d) => `          <tr>
            <td>${esc(d.sponsor)}</td>
            <td>${esc(d.investment)}</td>
            <td>${esc(d.location || "—")}</td>
            <td>${esc(d.assetClass || "—")}</td>
            <td class="num">${esc(d.hold || "—")}</td>
            <td class="num">${esc(cleanMult(d.multiple) || "—")}</td>
            <td class="num">${esc(d.annual || "—")}</td>
          </tr>`).join("\n");
  const sponsors = [...new Set(deals.map((d) => d.sponsor))].sort();
  const optionsHtml = sponsors.map((s) => `        <option value="${esc(s)}">${esc(s)}</option>`).join("\n");

  // Sponsor-level table from the "Sponsor Connection" tab (sponsors with track records)
  const SC_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent("Sponsor Connection")}`;
  const resSC = await fetch(SC_CSV_URL, { redirect: "follow" });
  if (!resSC.ok) throw new Error(`Sponsor Connection fetch failed: ${resSC.status}`);
  const scRows = parseCSV(await resSC.text());
  const sch = scRows[0].map((h) => h.trim());
  const sci = (n) => sch.indexOf(n);
  for (const need of ["Investment Firm", "Full-Cycle Deals", "Average Annual Return"]) {
    if (sci(need) === -1) throw new Error(`Sponsor Connection tab is missing '${need}'`);
  }
  const noData = (v) => {
    const t = (v || "").trim();
    if (!t || /^no data$/i.test(t) || /^not disclosed$/i.test(t)) return "";
    if (/^\d*\.?x$/i.test(t) || t === ".x") return ""; // malformed multiples like "2.x"
    return t;
  };
  const sponsorRows = scRows.slice(1)
    .filter((r) => {
      const fc = (r[sci("Full-Cycle Deals")] || "").trim();
      return (r[sci("Investment Firm")] || "").trim() && fc && fc !== "0" && !/^no data$/i.test(fc);
    })
    .sort((a, b) => a[sci("Investment Firm")].localeCompare(b[sci("Investment Firm")]))
    .map((r) => `          <tr>
            <td>${esc(r[sci("Investment Firm")])}${/^yes$/i.test((r[sci("Preferred?")] || "").trim()) ? ' <span class="pref-chip">Preferred</span>' : ""}</td>
            <td class="num">${esc(noData(r[sci("Year Founded")]) || "—")}</td>
            <td class="num">${esc(noData(r[sci("AUM")]) || "—")}</td>
            <td class="num">${esc(noData(r[sci("Full-Cycle Deals")]) || "—")}</td>
            <td class="num">${esc(noData(r[sci("Average Annual Return")]) || "—")}</td>
            <td class="num">${esc(noData(r[sci("Average Equity Multiple")]) || "—")}</td>
            <td class="num">${esc(noData(r[sci("Average Hold Period")]) || "—")}</td>
            <td class="num">${esc(noData(r[sci("Success Rate")]) || "—")}</td>
          </tr>`);
  if (sponsorRows.length < 5) throw new Error(`Only ${sponsorRows.length} sponsor rows — refusing to build.`);

  // ---- Preferred vs All summary (computed from the deal-level track record,
  //      same methodology as the homepage chart: average across completed programs) ----
  const prefSet = new Set(scRows.slice(1)
    .filter((r) => /^yes$/i.test((r[sci("Preferred?")] || "").trim()))
    .map((r) => normName(r[sci("Investment Firm")])));
  const pct = (v) => { const m = String(v).trim().match(/^(-?\d*\.?\d+)%$/); return m ? parseFloat(m[1]) : null; };
  const multVal = (v) => { const m = String(v).trim().match(/^(\d*\.?\d+)x$/i); return m ? parseFloat(m[1]) : null; };
  const numVal = (v) => { const m = String(v).trim().match(/^(\d*\.?\d+)$/); return m ? parseFloat(m[1]) : null; };
  const mean = (arr) => arr.length ? arr.reduce((a, x) => a + x, 0) / arr.length : null;
  // sponsor-level success rates + program counts for the weighted success figure
  const successBySponsor = new Map(scRows.slice(1).map((r) => [normName(r[sci("Investment Firm")]), {
    rate: pct(r[sci("Success Rate")]),
    count: numVal(r[sci("Full-Cycle Deals")])
  }]));
  function groupStats(label, groupDeals) {
    const sponsors = [...new Set(groupDeals.map((d) => normName(d.sponsor)))];
    const avgAnn = mean(groupDeals.map((d) => pct(d.annual)).filter((x) => x !== null));
    const avgMult = mean(groupDeals.map((d) => multVal(d.multiple)).filter((x) => x !== null));
    const avgHold = mean(groupDeals.map((d) => numVal(d.hold)).filter((x) => x !== null));
    let wSum = 0, wTot = 0;
    for (const s of sponsors) {
      const sc = successBySponsor.get(s);
      if (sc && sc.rate !== null && sc.count) { wSum += sc.rate * sc.count; wTot += sc.count; }
    }
    const success = wTot ? wSum / wTot : null;
    const f = (v, suffix, digits = 2) => v === null ? "—" : v.toFixed(digits) + suffix;
    return `          <tr>
            <td style="font-weight:700">${esc(label)}</td>
            <td class="num">${sponsors.length}</td>
            <td class="num">${groupDeals.length}</td>
            <td class="num">${f(avgAnn, "%")}</td>
            <td class="num">${f(avgMult, "x")}</td>
            <td class="num">${f(avgHold, " Years", 1)}</td>
            <td class="num">${f(success, "%", 1)}</td>
          </tr>`;
  }
  const prefDeals = deals.filter((d) => prefSet.has(normName(d.sponsor)));
  const summaryRows = [
    groupStats("Baker 1031 Preferred Sponsors", prefDeals),
    groupStats("All Investment Sponsors", deals)
  ].join("\n");

  /* ---- Homepage chart: tie the "Baker 1031 Preferred*" bar to the same
     live calculation (average annual return across completed preferred-
     sponsor programs). Chart scale: 0% = y310, 25% = y54 → 10.24 px/%. ---- */
  {
    const prefAnnual = mean(prefDeals.map((d) => pct(d.annual)).filter((x) => x !== null));
    if (prefAnnual === null || prefAnnual < 5 || prefAnnual > 24.5) {
      throw new Error(`Preferred-sponsor average ${prefAnnual}% outside sane chart range — refusing to build.`);
    }
    const v = prefAnnual.toFixed(1);
    const top = +(310 - prefAnnual * 10.24).toFixed(1);
    const idxPath = join(ROOT, "index.html");
    let idx = readFileSync(idxPath, "utf8");

    const barGroup = `<g class="bar-col" data-name="Baker 1031 Preferred*" data-value="${v}%" data-note="Average realized, full-cycle, net-to-investor annualized return across completed preferred-sponsor programs. Multi-year, not a 2025 calendar-year return.">
            <rect x="56" y="54" width="148" height="256" fill="transparent"/>
            <path class="bar" d="M92,310 V${(top + 4).toFixed(1)} Q92,${top} 96,${top} H164 Q168,${top} 168,${(top + 4).toFixed(1)} V310 Z" fill="#2b3a5f"/>
            <text x="130" y="${(top - 9).toFixed(1)}" font-size="14" font-weight="700" fill="#2b3a5f" text-anchor="middle">${v}%*</text>
            <text x="130" y="332" font-size="13.5" fill="#4a4a4a" text-anchor="middle">Baker 1031</text>
            <text x="130" y="349" font-size="13.5" fill="#4a4a4a" text-anchor="middle">Preferred*</text>
          </g>`;
    idx = put(idx, "<!-- CHART:PREFERRED -->", "<!-- /CHART:PREFERRED -->", "          " + barGroup, "index.html");
    idx = idx.replace(/(aria-label="Bar chart: Baker 1031 preferred sponsors )[\d.]+%/, `$1${v}%`);
    writeFileSync(idxPath, idx);
    // FAQ: live average-hold sentence from the full track record
    const holds = deals.map((d) => numVal(d.hold)).filter((x) => x !== null);
    if (holds.length > 100) {
      const avgHold = (holds.reduce((a, x) => a + x, 0) / holds.length).toFixed(1);
      // Typical range = middle 90% of programs (5th–95th percentile), so a
      // single outlier exit doesn't distort the FAQ answer
      const hSorted = [...holds].sort((a, b) => a - b);
      const p5 = hSorted[Math.round(0.05 * (hSorted.length - 1))].toFixed(1);
      const p95 = hSorted[Math.round(0.95 * (hSorted.length - 1))].toFixed(1);
      idx = readFileSync(idxPath, "utf8");
      idx = idx.replace(/(<span id="faq-hold-stat">)[\s\S]*?(<\/span>)/,
        (_, open, close) => `${open}Across the ${holds.length} completed sponsor programs in our track record, the average hold has been ${avgHold} years, with most programs running between ${p5} and ${p95} years.${close}`);
      writeFileSync(idxPath, idx);
      console.log(`FAQ hold stat: ${holds.length} programs, avg ${avgHold} yrs (typical ${p5}–${p95}).`);
    }
    console.log(`Homepage chart: Baker 1031 Preferred bar set to ${v}% (live from ${prefDeals.length} preferred programs).`);
  }

  let perf = readFileSync(join(ROOT, "templates", "performance.html"), "utf8");
  perf = perf.replace("<!-- PERF:SUMMARY_ROWS -->", summaryRows);
  perf = perf.replace("<!-- PERF:SPONSOR_ROWS -->", sponsorRows.join("\n"));
  perf = perf.replace("<!-- PERF:ROWS -->", rowsHtml);
  perf = perf.replace("<!-- PERF:SPONSORS -->", optionsHtml);
  perf = perf.replace("<!-- PERF:CLOSED_CARDS -->", closedCardsHtml);
  writeFileSync(join(ROOT, "performance.html"), perf);
  console.log(`Wrote performance.html (${sponsorRows.length} sponsors, ${deals.length} programs, closed cards included).`);
}

/* ---------------- 5) sitemap.xml ---------------- */
{
  const urls = [
    { loc: `${SITE}/`, priority: "1.0" },
    { loc: `${SITE}/learn.html`, priority: "0.6" },
    { loc: `${SITE}/glossary.html`, priority: "0.6" },
    { loc: `${SITE}/markets.html`, priority: "0.6" },
    { loc: `${SITE}/audiences.html`, priority: "0.6" },
    ...JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8")).terms.map((t) => ({ loc: `${SITE}/glossary/${t.slug}/`, priority: "0.5" })),
    ...JSON.parse(readFileSync(join(ROOT, "data", "markets.json"), "utf8")).jurisdictions.map((j) => ({ loc: `${SITE}/markets/${j.slug}/`, priority: "0.5" })),
    ...offerings.map((o) => ({
      loc: `${SITE}/offerings/${o._slug}/`,
      priority: isClosed(o) ? "0.3" : "0.7"
    }))
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><priority>${u.priority}</priority></url>`).join("\n")}\n</urlset>\n`;
  writeFileSync(join(ROOT, "sitemap.xml"), sitemap);
  console.log(`Wrote sitemap.xml (${urls.length} URLs)`);
}


/* ---------------- Glossary: generate term pages + hub index from data/glossary.json ---------------- */
{
  const gl = JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8"));
  const terms = gl.terms || [];
  if (terms.length < 10) throw new Error(`Only ${terms.length} glossary terms — refusing to build.`);
  const bySlug = new Map(terms.map((t) => [t.slug, t]));
  const CAT_ORDER = ["1031 Exchange", "DSTs", "721 / REITs", "Opportunity Zones", "Taxes", "Investing"];
  const byCat = Object.fromEntries(CAT_ORDER.map((c) => [c, []]));
  for (const t of terms) (byCat[t.category] || (byCat[t.category] = [])).push(t);

  const tpl = readFileSync(join(ROOT, "glossary", "term-template.html"), "utf8");

  // Collapsible category folder nav (shared by hub + term pages); marks the active term
  const foldersFor = (activeSlug, activeCat) => CAT_ORDER.map((c, i) => {
    const items = [...byCat[c]].sort((a, b) => a.term.localeCompare(b.term))
      .map((t) => `          <li><a${t.slug === activeSlug ? ' class="active"' : ""} href="/glossary/${t.slug}/">${esc(t.term)}</a></li>`).join("\n");
    const open = (activeCat ? c === activeCat : i === 0) ? " open" : "";
    return `        <details${open}><summary>${esc(c)}</summary><ul>\n${items}\n        </ul></details>`;
  }).join("\n");

  // ----- term pages -----
  const alpha = [...terms].sort((a, b) => a.term.toLowerCase().localeCompare(b.term.toLowerCase()));
  const nextOf = new Map(alpha.map((t, i) => [t.slug, alpha[(i + 1) % alpha.length]]));
  let count = 0;
  for (const t of terms) {
    const canonical = `${SITE}/glossary/${t.slug}/`;
    const nxt = nextOf.get(t.slug);
    const nextLink = `<a href="/glossary/${nxt.slug}/">${esc(nxt.term)} &rarr;</a>`;
    const relChips = (t.related || []).map((s) => {
      const r = bySlug.get(s); return r ? `<a href="/glossary/${r.slug}/">${esc(r.term)}</a>` : "";
    }).filter(Boolean).join("\n          ");
    const keyPts = (t.keyPoints || []).map((k) => `          <li>${esc(k)}</li>`).join("\n");
    const jsonld = JSON.stringify({
      "@context": "https://schema.org", "@type": "DefinedTerm", name: t.term, description: t.lead,
      inDefinedTermSet: { "@type": "DefinedTermSet", name: "Baker 1031 Investments Glossary", url: `${SITE}/glossary.html` },
      url: canonical
    });

    const srcAnchor = `<a href="${esc(t.source.url)}" target="_blank" rel="noopener">${esc(t.source.label)}</a>`;
    const metaLine = `By <a href="#author">Gerald F. &ldquo;Jerry&rdquo; Baker, III</a> &middot; Updated July 2026 &middot; Reviewed by Aurora Securities Compliance`;

    let html = tpl;
    // head — function replacers so `$` in data is never read as a backreference
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(t.term)} — Glossary — Baker 1031 Investments</title>`);
    html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(t.lead)}">`);
    html = html.replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}">`);
    html = html.replace(/\s*<meta name="robots"[^>]*>/g, ""); // glossary term pages are public/indexable
    html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => `<script type="application/ld+json">${jsonld}</script>`);
    // nested one level deeper (/glossary/<slug>/) → asset paths already absolute (/css, /js) — good
    // content — marker-based put() is fully immune to `$` in the data
    html = put(html, "<!-- T:CRUMB -->", "<!-- /T:CRUMB -->", esc(t.term), t.slug);
    html = put(html, "<!-- T:FOLDERS -->", "<!-- /T:FOLDERS -->", foldersFor(t.slug, t.category), t.slug);
    html = put(html, "<!-- T:CAT -->", "<!-- /T:CAT -->", esc(t.category), t.slug);
    html = put(html, "<!-- T:TERM -->", "<!-- /T:TERM -->", esc(t.term), t.slug);
    html = put(html, "<!-- T:META -->", "<!-- /T:META -->", metaLine, t.slug);
    html = put(html, "<!-- T:LEAD -->", "<!-- /T:LEAD -->", esc(t.lead), t.slug);
    html = put(html, "<!-- T:DEF -->", "<!-- /T:DEF -->", t.definition, t.slug);
    html = put(html, "<!-- T:KEYS -->", "<!-- /T:KEYS -->", keyPts, t.slug);
    html = put(html, "<!-- T:SRC -->", "<!-- /T:SRC -->", srcAnchor, t.slug);
    html = put(html, "<!-- T:REL -->", "<!-- /T:REL -->", relChips, t.slug);
    html = put(html, "<!-- T:NEXT -->", "<!-- /T:NEXT -->", nextLink, t.slug);

    const dir = join(ROOT, "glossary", t.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    count++;
  }

  // ----- hub index (fills the term list + folder nav in glossary.html) -----
  let hub = readFileSync(join(ROOT, "glossary.html"), "utf8");
  const sorted = [...terms].sort((a, b) => a.term.toLowerCase().localeCompare(b.term.toLowerCase()));
  const groups = new Map();
  for (const t of sorted) {
    let L = t.term[0].toUpperCase();
    if (/[0-9]/.test(L)) L = "#";
    if (!groups.has(L)) groups.set(L, []);
    groups.get(L).push(t);
  }
  let letters = "";
  for (const [L, items] of groups) {
    const anchor = "ltr-" + (L === "#" ? "num" : L);
    const rows = items.map((t) => `          <a class="term-row" href="/glossary/${t.slug}/"><span class="tn">${esc(t.term)}</span><span class="tc">${esc(t.category)}</span><span class="td">${esc(t.oneLine)}</span></a>`).join("\n");
    letters += `\n        <section class="letter-group" id="${anchor}">\n          <h2>${L}</h2>\n${rows}\n        </section>`;
  }
  hub = put(hub, "<!-- GL:FOLDERS -->", "<!-- /GL:FOLDERS -->", foldersFor(null, null), "glossary.html");
  hub = put(hub, "<!-- GL:TERMS -->", "<!-- /GL:TERMS -->", letters, "glossary.html");
  writeFileSync(join(ROOT, "glossary.html"), hub);
  console.log(`Glossary: ${count} term pages + hub index (${terms.length} terms).`);
}

/* ---------------- Markets: generate state/metro pages + hub from data/markets.json ---------------- */
{
  const mk = JSON.parse(readFileSync(join(ROOT, "data", "markets.json"), "utf8"));
  const items = mk.jurisdictions || [];
  if (items.length < 40) throw new Error(`Only ${items.length} market jurisdictions — refusing to build.`);
  const REGION_ORDER = ["West", "Midwest", "Southeast", "Southwest", "Northeast", "Top Metros"];
  const byRegion = Object.fromEntries(REGION_ORDER.map((r) => [r, []]));
  for (const j of items) (byRegion[j.region] || (byRegion[j.region] = [])).push(j);

  const tpl = readFileSync(join(ROOT, "markets", "state-template.html"), "utf8");

  // Collapsible region folder nav (shared by hub + pages); marks the active jurisdiction
  const foldersFor = (activeSlug) => REGION_ORDER.map((r, i) => {
    const list = byRegion[r] || [];
    const lis = list.map((j) => `          <li><a${j.slug === activeSlug ? ' class="active"' : ""} href="/markets/${j.slug}/">${esc(j.name)}</a></li>`).join("\n");
    const open = (activeSlug ? list.some((j) => j.slug === activeSlug) : i === 0) ? " open" : "";
    return `        <details${open}><summary>${esc(r)}</summary><ul>\n${lis}\n        </ul></details>`;
  }).join("\n");

  // ----- pages -----
  let count = 0;
  for (const j of items) {
    const canonical = `${SITE}/markets/${j.slug}/`;
    const kicker = j.type === "metro" ? `Markets &middot; ${esc(j.name)}` : `1031 Exchange &middot; ${esc(j.name)}`;
    const whyLis = (j.why || []).map((w) => `          <li>${esc(w)}</li>`).join("\n");
    const faqHtml = (j.faq || []).map((f) => `          <details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("\n");
    const jsonld = JSON.stringify({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: (j.faq || []).map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } }))
    });

    let html = tpl;
    // head — function replacers so `$`/`%` in data is never read as a backreference
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>1031 Exchange &amp; DST Investing in ${esc(j.name)} — Baker 1031 Investments</title>`);
    html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(j.metaDesc)}">`);
    html = html.replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}">`);
    html = html.replace(/\s*<meta name="robots"[^>]*>/g, ""); // market pages are public/indexable
    html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => `<script type="application/ld+json">${jsonld}</script>`);
    // content — marker-based put() (immune to `$` in the data)
    html = put(html, "<!-- M:CRUMB -->", "<!-- /M:CRUMB -->", esc(j.name), j.slug);
    html = put(html, "<!-- M:FOLDERS -->", "<!-- /M:FOLDERS -->", foldersFor(j.slug), j.slug);
    html = put(html, "<!-- M:KICKER -->", "<!-- /M:KICKER -->", kicker, j.slug);
    html = put(html, "<!-- M:H1 -->", "<!-- /M:H1 -->", `1031 Exchange &amp; DST Investing in ${esc(j.name)}`, j.slug);
    html = put(html, "<!-- M:META -->", "<!-- /M:META -->", "July 2026", j.slug);
    html = put(html, "<!-- M:LEAD -->", "<!-- /M:LEAD -->", esc(j.lead), j.slug);
    html = put(html, "<!-- M:CGRATE -->", "<!-- /M:CGRATE -->", esc(j.capGainsRate), j.slug);
    html = put(html, "<!-- M:CONFORMS -->", "<!-- /M:CONFORMS -->", esc(j.conforms), j.slug);
    html = put(html, "<!-- M:CLAWBACK -->", "<!-- /M:CLAWBACK -->", esc(j.clawback), j.slug);
    html = put(html, "<!-- M:TAXBODY -->", "<!-- /M:TAXBODY -->", j.taxBody, j.slug);
    html = put(html, "<!-- M:CALLOUT -->", "<!-- /M:CALLOUT -->", esc(j.callout), j.slug);
    html = put(html, "<!-- M:MARKET -->", "<!-- /M:MARKET -->", j.market, j.slug);
    html = put(html, "<!-- M:WHY -->", "<!-- /M:WHY -->", whyLis, j.slug);
    html = put(html, "<!-- M:REPLACE -->", "<!-- /M:REPLACE -->", j.replace, j.slug);
    html = put(html, "<!-- M:FAQ -->", "<!-- /M:FAQ -->", faqHtml, j.slug);

    const dir = join(ROOT, "markets", j.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    count++;
  }

  // ----- hub (fills the region grid + folder nav in markets.html) -----
  let hub = readFileSync(join(ROOT, "markets.html"), "utf8");
  let sections = "";
  for (const r of REGION_ORDER) {
    const list = byRegion[r] || [];
    if (!list.length) continue;
    const cells = list.map((j) => `          <a class="mk-state" href="/markets/${j.slug}/">${esc(j.name)}</a>`).join("\n");
    sections += `\n        <section class="region-group">\n          <h2>${esc(r)}</h2>\n          <div class="state-grid">\n${cells}\n          </div>\n        </section>`;
  }
  hub = put(hub, "<!-- MK:FOLDERS -->", "<!-- /MK:FOLDERS -->", foldersFor(null), "markets.html");
  hub = put(hub, "<!-- MK:LIST -->", "<!-- /MK:LIST -->", sections, "markets.html");
  writeFileSync(join(ROOT, "markets.html"), hub);
  console.log(`Markets: ${count} state/metro pages + hub (${items.length} jurisdictions).`);
}

/* ---------------- Publish directory (dist/) ----------------
   Only the public whitelist is served; templates, partials, docs, kindeSrc,
   scripts and functions never reach the CDN. */
{
  const dist = join(ROOT, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const COPY = [
    "index.html", "current-offerings.html", "performance.html", "employee.html",
    "learn.html", "learn", "glossary.html", "glossary", "markets.html", "markets",
    "audiences.html", "audiences",
    "offerings", "data", "css", "js", "assets", "documents",
    "sitemap.xml", "robots.txt"
  ];
  let copied = 0;
  for (const item of COPY) {
    const src = join(ROOT, item);
    if (!existsSync(src)) { console.warn(`dist: skipping missing ${item}`); continue; }
    cpSync(src, join(dist, item), { recursive: true });
    copied++;
  }
  // Templates are authoring scaffolds — never publish them, even under a whitelisted dir.
  let stripped = 0;
  // NOTE: audiences/audience-template.html is intentionally NOT stripped yet — the
  // audiences hub links to it as a live preview until real audience pages are
  // generated. It is noindex and absent from the sitemap, so it stays out of search.
  for (const rel of ["glossary/term-template.html", "markets/state-template.html", "learn/article-template.html"]) {
    const p = join(dist, rel);
    if (existsSync(p)) { rmSync(p); stripped++; }
  }
  console.log(`dist/ assembled (${copied} top-level items, ${stripped} templates stripped).`);

  /* Cache-bust local /js and /css refs. Both are served with a multi-hour/day
     cache (netlify.toml), but HTML revalidates on every load — so appending a
     content hash to the script/stylesheet URL in the HTML forces browsers to
     fetch a changed asset on the next navigation instead of waiting for the
     cache to expire. Critical for auth.js and tokens.css fixes. The hash only
     changes when the file does, so unchanged assets stay fully cached. */
  const hashDir = (rel, ext) => {
    const dir = join(dist, rel), out = {};
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(ext)) out[f] = createHash("sha1").update(readFileSync(join(dir, f))).digest("hex").slice(0, 8);
      }
    }
    return out;
  };
  const assets = [
    { attr: "src", dir: "js", hashes: hashDir("js", ".js") },
    { attr: "href", dir: "css", hashes: hashDir("css", ".css") }
  ];
  const htmlFiles = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".html")) htmlFiles.push(p);
    }
  })(dist);
  let busted = 0;
  for (const hf of htmlFiles) {
    let s = readFileSync(hf, "utf8"), changed = false;
    for (const { attr, dir, hashes } of assets) {
      for (const [f, h] of Object.entries(hashes)) {
        // Match absolute ("/css/tokens.css") and relative ("css/tokens.css") refs
        const re = new RegExp(`(${attr}=")([^"]*${dir}/${f.replace(/\./g, "\\.")})(")`, "g");
        const ns = s.replace(re, (_, a, b, c) => `${a}${b}?v=${h}${c}`);
        if (ns !== s) { s = ns; changed = true; }
      }
    }
    if (changed) { writeFileSync(hf, s); busted++; }
  }
  console.log(`Cache-busted /js + /css refs in ${busted} HTML files.`);
}

console.log("Build complete.");
