/* ============================================================
   Build step: Google Sheet "Master Listings" → static site data.

   What it does (runs during every Netlify build):
   1. Fetches the sheet as CSV (public gviz export — no API key).
   2. Writes data/offerings.json (fast client-side data source).
   3. Generates a permanent static page per offering at
      offerings/<slug>/index.html from offering-template.html,
      with per-page <title>, meta description, canonical, Open
      Graph tags and JSON-LD for SEO / LLM discoverability.
   4. Bakes the listing cards into current-offerings.html.
   5. Regenerates sitemap.xml.

   No dependencies — plain Node 18+ (fetch built in).
   Run locally:  node scripts/build-offerings.mjs
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHEET_ID = "1vTqb5YX8pFjZxToGd2pJ_ncPbny2PXpW5gXx-7IlyZg";
const SHEET_TAB = "Master Listings";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`;
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
const escAttr = esc;

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
const offerings = rows.slice(1)
  .filter((r) => (r[headers.indexOf("Investment Name")] || "").trim())
  .map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    // Slug: prefer the sheet's URL column, else derive from the name
    o._slug = slugify(o["URL"] || o["Investment Name"]);
    return o;
  });

// Guard against a broken/empty sheet nuking the site
if (offerings.length < 10) {
  throw new Error(`Only ${offerings.length} offerings parsed — refusing to build (sheet problem?).`);
}
// Guard against duplicate slugs silently overwriting pages
{
  const seen = new Map();
  for (const o of offerings) {
    if (seen.has(o._slug)) {
      let n = 2;
      while (seen.has(`${o._slug}-${n}`)) n++;
      o._slug = `${o._slug}-${n}`;
    }
    seen.set(o._slug, true);
  }
}
console.log(`Parsed ${offerings.length} offerings, ${headers.length} columns.`);

/* ---------------- Display rules ---------------- */
function displayDebt(o) {
  const d = (o["Debt"] || "").replace(/[\s,]/g, "");
  return (d === "$0" || d === "0" || d === "") ? "All-Cash" : o["Debt"];
}
function displayLTV(o) {
  const v = (o["In-Place LTV"] || "").trim();
  return v === "0.00% LTV" || v === "0%" || v === "0.00%" ? "All-Cash" : v;
}
function statusRank(s) {
  const order = ["Available", "Limited Availability", "Accepting Backup Reservations", "Coming Soon / Under Review", "Closed"];
  const i = order.indexOf((s || "").trim());
  return i === -1 ? 3.5 : i;
}
function isClosed(o) { return (o["Status"] || "").trim() === "Closed"; }

/* ---------------- 1) data/offerings.json ---------------- */
const jsonOut = offerings.map((o) => {
  const out = { slug: o._slug, page: `/offerings/${o._slug}/` };
  for (const h of headers) out[h] = o[h];
  return out;
});
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "offerings.json"), JSON.stringify({
  generated: new Date().toISOString(),
  count: jsonOut.length,
  offerings: jsonOut
}, null, 1));
console.log("Wrote data/offerings.json");

/* ---------------- 2) Per-offering static pages ---------------- */
const template = readFileSync(join(ROOT, "offering-template.html"), "utf8");

/* Replace the inner text of the FIRST element carrying data-field="Name".
   Works on the template's consistent markup: <tag ... data-field="X" ...>old</tag> */
function setField(html, field, value, { all = false } = {}) {
  const re = new RegExp(
    `(<([a-z0-9]+)([^>]*\\bdata-field="${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*)>)([\\s\\S]*?)(</\\2>)`,
    all ? "g" : ""
  );
  return html.replace(re, (_, open, _tag, _attrs, _old, close) => `${open}${esc(value)}${close}`);
}
function setImg(html, field, src, alt) {
  const re = new RegExp(`<img([^>]*\\bdata-field="${field}"[^>]*)>`);
  return html.replace(re, (m, attrs) => {
    let a = attrs.replace(/\bsrc="[^"]*"/, `src="${escAttr(src)}"`);
    if (!/\bsrc=/.test(a)) a += ` src="${escAttr(src)}"`;
    if (alt) a = /\balt="/.test(a) ? a.replace(/\balt="[^"]*"/, `alt="${escAttr(alt)}"`) : a + ` alt="${escAttr(alt)}"`;
    return `<img${a}>`;
  });
}
function setHref(html, field, href) {
  const re = new RegExp(`(<a[^>]*\\bdata-href-field="${field}"[^>]*)>`);
  return html.replace(re, (m, open) => {
    let o = open.replace(/\bhref="[^"]*"/, `href="${escAttr(href)}"`);
    if (!/\bhref=/.test(o)) o += ` href="${escAttr(href)}"`;
    return o + ">";
  });
}
/* Remove an element (and its children) by a data-field it carries — used for
   fields that don't exist in the sheet. Cheap approach: hide via style attr. */
function hideFieldBlock(html, selectorField) {
  const re = new RegExp(`(<[a-z0-9]+[^>]*\\bdata-field="${selectorField}"[^>]*>)`, "g");
  return html.replace(re, (open) => open.replace(/>$/, ' style="display:none">'));
}

function buildPage(o) {
  let html = template;
  const name = o["Investment Name"];
  const canonical = `${SITE}/offerings/${o._slug}/`;
  const photo = o["Photo Link Use"] || o["Property Photo Link"] || "";
  const listDesc = truncate(o["List Description"] || o["Description"], 158);

  /* ----- asset paths & nav (page lives two levels deep) ----- */
  html = html
    .replace(/(href|src)="(css|js|assets|documents)\//g, `$1="/$2/`)
    .replace(/href="index\.html/g, `href="/index.html`)
    .replace(/href="current-offerings\.html/g, `href="/current-offerings.html`);
  // breadcrumb + back links that were "#"
  html = html.replace(/(<a[^>]*class="[^"]*(?:breadcrumb-link|back-link)[^"]*"[^>]*href=")#(")/g, `$1/current-offerings.html$2`);

  /* ----- head: title / meta / canonical / OG / JSON-LD ----- */
  const headBits = [
    `<link rel="canonical" href="${canonical}">`,
    `<meta name="description" content="${escAttr(listDesc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escAttr(name)} | Baker 1031 Investments">`,
    `<meta property="og:description" content="${escAttr(listDesc)}">`,
    photo ? `<meta property="og:image" content="${escAttr(photo)}">` : "",
    `<meta property="og:url" content="${canonical}">`,
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": canonical,
          "name": `${name} — ${o["Structure"] || "DST"} Offering`,
          "description": listDesc,
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
  ].filter(Boolean).join("\n  ");
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(name)} | ${esc(o["Structure"] || "DST")} ${esc(o["Property Type"] || "")} Offering | Baker 1031 Investments</title>\n  ${headBits}`);

  /* ----- straight field mappings (sheet header == template data-field) ----- */
  const direct = [
    "Investment Name", "Sponsor", "Structure", "Status", "Total Offering", "Equity",
    "In-Place LTV", "Available Equity", "Last Updated", "Property Type",
    "Location (Use)", "Total Load", "Strategy", "721 Exchange Exit",
    "Estimated Hold Period", "Description", "Highlight 1", "Highlight 2",
    "Highlight 3", "Highlight 4", "Highlight 5", "Pros", "Cons", "Insights",
    "Y1", "Y2", "Y3", "Y4", "Y5", "Y6", "Y7", "Y8", "Y9", "Y10",
    "Average Yield", "Cap Rate Equivalent", "Lender", "Interest Rate",
    "Loan Term", "I/O Period", "Amortization", "Y1 DSCR",
    "Minimum Investment", "Tax Adj Label", "Tax Adjusted Yield (Use)",
    "Sponsor Description", "Sponsor AUM", "Full-Cycle Count", "Sponsor AAR",
    "Sponsor AEM", "Sponsor Hold", "Sponsor Success",
    "BM: Avg. Income - Deal", "BM: Avg. Income - MKT", "BM: Avg. Income - Interpret",
    "BM: Growth - Deal", "BM: Growth- MKT", "BM: Growth - Interpret",
    "BM: Peak - Deal", "BM: Peak- MKT", "BM: Peak - Interpret"
  ];
  for (const f of direct) {
    if (headers.includes(f)) html = setField(html, f, o[f] || "—", { all: true });
  }

  /* ----- special values ----- */
  html = setField(html, "Debt", displayDebt(o), { all: true });
  html = setField(html, "In-Place LTV", displayLTV(o), { all: true });
  // Available Equity cell gets the "X available" small tag
  if (o["Available Percentage"]) {
    html = html.replace(
      /(data-field="Available Equity"[^>]*>)([\s\S]*?)(<\/)/,
      (_, open, _v, close) => `${open}${esc(o["Available Equity"] || "—")} <small class="stat-sub">${esc(o["Available Percentage"])} available</small>${close}`
    );
  }

  /* ----- template↔sheet renames ----- */
  html = setField(html, "Investment Firm", o["Sponsor"] || "—", { all: true });
  html = setField(html, "Year Founded", o["Sponsor Founded"] || "—", { all: true });
  // Website: keep the anchor but point it at the sponsor page path if present
  if (o["Sponsor URL"]) {
    html = setHref(html, "Website", "/" + o["Sponsor URL"].replace(/^\//, ""));
    html = setField(html, "Website", o["Sponsor Button Text"] || o["Sponsor"] || "Sponsor Profile");
  } else {
    html = hideFieldBlock(html, "Website");
  }

  /* ----- fields NOT in the sheet: hide their blocks ----- */
  html = hideFieldBlock(html, "Headquarters (City, State)");
  for (let i = 1; i <= 5; i++) html = hideFieldBlock(html, `Key Strategy / Advantage ${i}`);

  /* ----- hero photo ----- */
  if (photo) html = setImg(html, "Photo Link Use", photo, `${name} property photo`);

  /* ----- benchmark chips: above/below class from Interpret text ----- */
  html = html.replace(
    /(<span[^>]*class=")([^"]*\bchip\b[^"]*)("[^>]*data-field="(BM:[^"]*Interpret)"[^>]*>)/g,
    (m, pre, cls, post, field) => {
      const val = (o[field] || "").toLowerCase();
      const dir = val.includes("above") ? "above" : val.includes("below") ? "below" : "";
      const base = cls.replace(/\b(above|below)\b/g, "").replace(/\s+/g, " ").trim();
      return `${pre}${base}${dir ? " " + dir : ""}${post}`;
    }
  );

  /* ----- documents section: single item from DD Label / DD Folder Link ----- */
  {
    const label = o["DD Label"] || "Offering Documents Available By Request";
    const link = o["DD Folder Link"] || "";
    const item = link
      ? `<li class="doc-item"><span class="doc-label" data-field="DD Label">${esc(label)}</span> <a class="doc-link" data-href-field="DD Folder Link" href="${escAttr(link)}" target="_blank" rel="noopener">Open Folder</a></li>`
      : `<li class="doc-item"><span class="doc-label" data-field="DD Label">${esc(label)}</span></li>`;
    // Replace the whole hardcoded <ul>…</ul> inside the documents section
    html = html.replace(
      /(<ul[^>]*class="[^"]*doc-list[^"]*"[^>]*>)[\s\S]*?(<\/ul>)/,
      (_, open, close) => `${open}\n            ${item}\n          ${close}`
    );
  }

  /* ----- distributions note footnote stays as-is (compliance pending) ----- */

  /* ----- closed offerings: annotate so the page persists but is honest ----- */
  if (isClosed(o)) {
    html = html.replace(/<meta name="robots"[^>]*>/, "");
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

/* ---------------- 3) Listing cards in current-offerings.html ---------------- */
const listingPath = join(ROOT, "current-offerings.html");
if (existsSync(listingPath)) {
  let listing = readFileSync(listingPath, "utf8");
  const sorted = [...offerings].sort((a, b) =>
    statusRank(a["Status"]) - statusRank(b["Status"]) ||
    a["Investment Name"].localeCompare(b["Investment Name"])
  );

  const cards = sorted.map((o) => {
    const badgeClass = {
      "Available": "badge-available",
      "Limited Availability": "badge-limited",
      "Accepting Backup Reservations": "badge-backup",
      "Coming Soon / Under Review": "badge-soon",
      "Closed": "badge-closed"
    }[(o["Status"] || "").trim()] || "badge-soon";
    const photo = o["Photo Link Use"] || o["Property Photo Link"] || "";
    const yieldLabel = o["Tax Adj Label"] && o["Tax Adjusted Yield (Use)"]
      ? `${o["Tax Adjusted Yield (Use)"]} <small>${esc(o["Tax Adj Label"])}</small>`
      : esc(o["Average Yield"] || "—");
    return `        <a class="offering-card" href="/offerings/${o._slug}/">
          <div class="offering-photo">${photo ? `<img src="${escAttr(photo)}" alt="${escAttr(o["Investment Name"])}" loading="lazy">` : ""}<span class="offering-badge ${badgeClass}">${esc(o["Status"])}</span></div>
          <div class="offering-body">
            <h3 class="offering-name">${esc(o["Investment Name"])}</h3>
            <p class="offering-meta">${esc(o["Property Type"] || "")}${o["Location (Use)"] ? " · " + esc(o["Location (Use)"]) : ""}</p>
            <p class="offering-sponsor">${esc(o["Sponsor"] || "")}${o["Structure"] ? " · " + esc(o["Structure"]) : ""}</p>
            <div class="offering-stats">
              <div><span class="offering-stat-label">Yield</span><span class="offering-stat-value">${yieldLabel}</span></div>
              <div><span class="offering-stat-label">LTV</span><span class="offering-stat-value">${esc(displayLTV(o))}</span></div>
              <div><span class="offering-stat-label">Min. Investment</span><span class="offering-stat-value">${esc(o["Minimum Investment"] || "—")}</span></div>
            </div>
          </div>
        </a>`;
  }).join("\n");

  const START = "<!-- OFFERINGS:START -->";
  const END = "<!-- OFFERINGS:END -->";
  if (listing.includes(START) && listing.includes(END)) {
    listing = listing.replace(
      new RegExp(`${START}[\\s\\S]*?${END}`),
      `${START}\n${cards}\n      ${END}`
    );
    writeFileSync(listingPath, listing);
    console.log(`Baked ${sorted.length} cards into current-offerings.html`);
  } else {
    console.log("NOTE: current-offerings.html has no OFFERINGS:START/END markers — cards not injected.");
  }
}

/* ---------------- 4) sitemap.xml ---------------- */
const staticPages = ["/", "/current-offerings.html"];
const urls = [
  ...staticPages.map((p) => ({ loc: SITE + p, priority: p === "/" ? "1.0" : "0.8" })),
  ...offerings.map((o) => ({
    loc: `${SITE}/offerings/${o._slug}/`,
    priority: isClosed(o) ? "0.3" : "0.7"
  }))
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><priority>${u.priority}</priority></url>`).join("\n")}
</urlset>
`;
writeFileSync(join(ROOT, "sitemap.xml"), sitemap);
console.log(`Wrote sitemap.xml (${urls.length} URLs)`);
console.log("Build complete.");
