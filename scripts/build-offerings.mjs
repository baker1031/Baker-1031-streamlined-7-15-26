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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHEET_ID = "1vTqb5YX8pFjZxToGd2pJ_ncPbny2PXpW5gXx-7IlyZg";
const SHEET_TAB = "Master Listings";
const DOCS_TAB = "Documents";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`;
const DOCS_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(DOCS_TAB)}`;
const SITE = "https://baker1031.com";

/* ---------------- CSV parsing (quoted fields, embedded commas/newlines) ---------------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------------- Helpers ---------------- */
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

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
// De-dupe slugs so no page silently overwrites another
{
  const seen = new Set();
  for (const o of offerings) {
    if (seen.has(o._slug)) {
      let n = 2;
      while (seen.has(`${o._slug}-${n}`)) n++;
      o._slug = `${o._slug}-${n}`;
    }
    seen.add(o._slug);
  }
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
/* Google Drive file links → direct-download links.
   https://drive.google.com/file/d/<ID>/view?...  →  https://drive.google.com/uc?export=download&id=<ID>
   Non-Drive-file URLs (folders, external sites) pass through unchanged. */
function directDownload(url) {
  const m = String(url || "").match(/drive\.google\.com\/file\/d\/([\w-]+)/) ||
            String(url || "").match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
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
}, null, 1));
console.log("Wrote data/offerings.json");

/* ---------------- 2) Per-offering static pages ---------------- */
const template = readFileSync(join(ROOT, "offering-template.html"), "utf8");

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
    `<div class="account-box">
        <a class="listings-link" href="/current-offerings.html" style="display:none;font-weight:600;font-size:0.9rem">Listings</a>
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
    photo ? `<meta property="og:image" content="${esc(photo)}">` : "",
    `<meta property="og:url" content="${canonical}">`,
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": canonical,
          "name": `${name} — ${o["Structure"] || "DST"} Offering`,
          "description": metaDesc,
          "url": canonical,
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
  // Tax Adj Label: drop the ⁹ footnote marker until the methodology
  // footnote clears compliance review (bracket placeholders removed below)
  html = setField(html, "Tax Adj Label", (o["Tax Adj Label"] || "").replace(/⁹|⁹/g, "").trim());

  /* ----- compliance-pending footnote placeholders: remove for now ----- */
  html = html.replace(/\s*&#8313; \[Tax-adjusted yield methodology footnote[\s\S]*?\]/, "");
  html = html.replace(/\s*<p class="note">\[Benchmark methodology footnote[\s\S]*?<\/p>/, "");

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
  if (photo) html = setImg(html, "Photo Link Use", photo, `${name} property photo`);

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
{
  const listingPath = join(ROOT, "current-offerings.html");
  let listing = readFileSync(listingPath, "utf8");
  const sorted = [...offerings].sort((a, b) =>
    statusRank(a["Status"]) - statusRank(b["Status"]) ||
    a["Investment Name"].localeCompare(b["Investment Name"])
  );

  const cards = sorted.map((o) => {
    const page = `/offerings/${o._slug}/`;
    const photo = o["Photo Link Use"] || o["Property Photo Link"] || "";
    const tag = slugify(o["Property Type"] || "other");
    const pctNum = parseFloat(o["Available Percentage"]) || 0;
    const sChip = statusClass(o["Status"]);
    return `      <article class="offering-card" data-tags="${esc(tag)}">
        <a class="card-photo" href="${page}">
          ${photo ? `<img src="${esc(photo)}" alt="${esc(o["Investment Name"])}" loading="lazy">` : ""}
          <span class="status-chip${sChip ? " " + sChip : ""}">${esc(o["Status"])}</span>
          <span class="type-chip">${esc(o["Property Type"] || "")}</span>
        </a>
        <div class="card-body">
          <h3>${esc(o["Investment Name"])}</h3>
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
  }).join("\n");

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
  console.log(`Baked ${sorted.length} cards + ${types.length} filter pills into current-offerings.html`);
}

/* ---------------- 4) sitemap.xml ---------------- */
{
  const urls = [
    { loc: `${SITE}/`, priority: "1.0" },
    { loc: `${SITE}/current-offerings.html`, priority: "0.8" },
    ...offerings.map((o) => ({
      loc: `${SITE}/offerings/${o._slug}/`,
      priority: isClosed(o) ? "0.3" : "0.7"
    }))
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><priority>${u.priority}</priority></url>`).join("\n")}\n</urlset>\n`;
  writeFileSync(join(ROOT, "sitemap.xml"), sitemap);
  console.log(`Wrote sitemap.xml (${urls.length} URLs)`);
}

console.log("Build complete.");
