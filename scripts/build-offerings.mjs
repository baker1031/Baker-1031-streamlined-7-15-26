/* ============================================================
   Build step: Airtable "Baker 1031 — Investments" → static site data.

   Runs during every Netlify build (see netlify.toml):
   1. Fetches the Airtable base via REST (AIRTABLE_TOKEN env var;
      see scripts/lib/airtable.mjs — AIRTABLE_SNAPSHOT for offline dev).
   2. Writes data/offerings.json (machine-readable data source).
   3. Generates a permanent static page per offering at
      offerings/<slug>/index.html from offering-template.html,
      with per-page <title>, meta description, canonical, Open
      Graph tags and JSON-LD for SEO / LLM discoverability.
   4. Bakes the listing cards + the filter/sort bar into
      current-offerings.html (between OFFERINGS/FILTERS markers).
      Default order: status (Available → Confirm Availability →
      Limited → Backup → Coming Soon), A–Z within each group.
   5. Regenerates sitemap.xml. Rejected listings are excluded from
      the directory + sitemap and listed on performance.html's
      "Rejected" tab (pages built noindex, like a research archive).

   No dependencies — plain Node 18+. Run locally:
     AIRTABLE_TOKEN=... node scripts/build-offerings.mjs
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { esc, truncate, slugify, put, brandTitle, metaTrim } from "./lib/html.mjs";
import { optimizedPhoto, directDownload, normalizeLogo, BRAND_LOGO, BRAND_LOGO_ABS, LOGO_W, LOGO_H } from "./lib/images.mjs";
import { injectPartials } from "./lib/partials.mjs";
import { loadAirtableData, statusRank as atStatusRank, statusClass as atStatusClass, STATUS_ORDER } from "./lib/airtable.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://baker1031.com";

/* ---------------- Shared SEO / structured-data helpers ---------------- */
const LOGO_URL = BRAND_LOGO;
const OG_IMAGE = `${SITE}/assets/og-card.png`;
// GoHighLevel website tracking (analytics/attribution ONLY — the real form→CRM
// data flow is the submission-created write + the booking workflow, NOT this
// loader). Injected before </head> on every dist page in the cache-bust pass
// below. The access form submits via fetch and has onsubmit prevented, so this
// script never sees a native form submit — no double-counting of leads.
const GHL_TRACKING = `<!-- GoHighLevel website tracking --><script src="https://link.msgsndr.com/js/external-tracking.js" data-tracking-id="tk_7ab70c544749430ba9bc3086c9f8053d"></script>`;
// Social-card coverage (audit): every generated page gets OG/Twitter tags.
function ensureOg(html, title, desc, url) {
  if (html.includes('property="og:image"')) return html;
  const block = `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(truncate(desc || "", 200))}"><meta property="og:type" content="website"><meta property="og:url" content="${url}"><meta property="og:image" content="${OG_IMAGE}"><meta name="twitter:card" content="summary_large_image">
</head>`;
  return html.replace("</head>", block);
}
// Canonical entity nodes reused by @id across the whole graph (dedupes for LLMs/Google).
const ORG_REF = { "@id": `${SITE}/#org` };
const WEBSITE_REF = { "@id": `${SITE}/#website` };
const PERSON_REF = { "@id": `${SITE}/#jerry` };
const PUBLISHER = { "@type": "Organization", "@id": `${SITE}/#org`, name: "Baker 1031 Investments", logo: { "@type": "ImageObject", url: BRAND_LOGO_ABS } };
const AUTHOR = { "@type": "Person", "@id": `${SITE}/#jerry`, name: 'Gerald F. "Jerry" Baker, III', jobTitle: "Founder & Principal", worksFor: ORG_REF };

const MONTHS = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };
// "June 2026" -> "2026-06-01"; falls back to a sane default.
function isoDate(updated) {
  const m = String(updated || "").match(/([A-Za-z]+)\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${MONTHS[m[1].toLowerCase()]}-01`;
  return "2026-06-01";
}
// BreadcrumbList JSON-LD from an ordered [name, url] trail (url null = current page).
function breadcrumbLd(trail) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map(([name, url], i) => ({ "@type": "ListItem", position: i + 1, name, ...(url ? { item: url } : {}) })),
  };
}
function graphLd(nodes) {
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": nodes.filter(Boolean) })}</script>`;
}

/* ---------------- Internal-linking dictionary (glossary/markets/calculators) ----------------
   Auto-links the first mention of a glossary term / state / calculator in article
   body prose. Longest-surface-first so "Delaware Statutory Trust" beats "Delaware". */
function buildLinkDict() {
  const entries = [];
  const push = (surface, url, key, priority) => { if (surface && surface.length >= 3) entries.push({ surface, url, key, priority }); };
  try {
    const gloss = JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8")).terms || [];
    for (const t of gloss) {
      const url = `${SITE}/glossary/${t.slug}/`;
      const base = t.term.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      if (/ vs\.? /i.test(base)) continue; // "DST vs. TIC" never appears verbatim
      push(base, url, `g:${t.slug}`, 1);
      const paren = (t.term.match(/\(([^)]+)\)/) || [])[1];
      if (paren && /^[A-Za-z][A-Za-z0-9 &/-]*$/.test(paren) && !/ vs\.? /i.test(paren)) push(paren.trim(), url, `g:${t.slug}`, 1);
    }
    const ALIAS = { DST: "delaware-statutory-trust", QI: "qualified-intermediary", QOF: "qualified-opportunity-fund", TIC: "tenants-in-common-tic", NNN: "triple-net-lease-nnn", "OP units": "op-units", "1031 exchange": "1031-exchange" };
    const gslugs = new Set(gloss.map((t) => t.slug));
    for (const [surface, slug] of Object.entries(ALIAS)) if (gslugs.has(slug)) push(surface, `${SITE}/glossary/${slug}/`, `g:${slug}`, 1);
  } catch {}
  try {
    const cals = JSON.parse(readFileSync(join(ROOT, "data", "calculators.json"), "utf8")).calculators || [];
    for (const c of cals) push(`${c.name}`, `${SITE}/calculators/${c.slug}/`, `c:${c.slug}`, 2);
  } catch {}
  try {
    const mk = JSON.parse(readFileSync(join(ROOT, "data", "markets.json"), "utf8")).jurisdictions || [];
    for (const j of mk) push(j.name, `${SITE}/markets/${j.slug}/`, `m:${j.slug}`, 3);
  } catch {}
  // longest surface first; tie-break by priority (glossary < calc < market)
  entries.sort((a, b) => b.surface.length - a.surface.length || a.priority - b.priority);
  const bySurface = new Map();
  for (const e of entries) { const k = e.surface.toLowerCase(); if (!bySurface.has(k)) bySurface.set(k, e); }
  const alts = entries.map((e) => e.surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = alts ? new RegExp(`(?<![\\w-])(${alts})(?:'s|’s|es|s)?(?![\\w-])`, "gi") : null;
  return { re, bySurface };
}

/* ---------------- Partial injection (footer etc.) ----------------
   partials/*.html are the single source of truth; every page keeps its
   last-baked copy between PARTIAL markers so it still previews locally. */
const PT_PAGES = existsSync(join(ROOT, "property-types")) ? readdirSync(join(ROOT, "property-types")).filter((d) => existsSync(join(ROOT, "property-types", d, "index.html"))).map((d) => `property-types/${d}/index.html`) : [];
for (const shell of [...PT_PAGES, "index.html", "current-offerings.html", "learn.html", "glossary.html", "markets.html", "audiences.html", "calculators.html", "sponsors.html", "templates/offering.html", "templates/performance.html", "learn/article-template.html", "glossary/term-template.html", "markets/state-template.html", "audiences/audience-template.html", "calculators/calculator-template.html", "sponsors/sponsor-template.html", "property-types.html", "terms.html", "disclosures.html", "reg-bi.html", "ccpa.html", "accessibility.html", "commitment-to-privacy.html", "privacy-policy.html", "scheduled.html", "call-confirmed.html", "book.html", "schedule.html", "process.html", "404.html"]) {
  const p = join(ROOT, shell);
  writeFileSync(p, injectPartials(readFileSync(p, "utf8"), ROOT, shell));
}
console.log("Partials injected into page shells + templates.");

/* ---------------- Fetch & normalize (Airtable) ---------------- */
console.log("Fetching Airtable base…");
const at = await loadAirtableData();
const offerings = at.offerings;
const atSponsors = at.sponsors;
const atDeals = at.deals;

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
{
  const qc = offerings.filter((o) => o._qc);
  if (qc.length) console.warn(`QC Check flags on ${qc.length} listings:\n  ${qc.map((o) => `${o["Investment Name"]}: ${o._qc}`).join("\n  ")}`);
}
console.log(`Parsed ${offerings.length} offerings from Airtable.`);

/* ---------------- Documents (per-offering document lists) ---------------- */
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const docsByName = new Map(); // normalized Investment Name -> [{label, file, gated}]
{
  for (const d of at.docs) {
    const key = normName(d.name);
    if (!docsByName.has(key)) docsByName.set(key, []);
    docsByName.get(key).push({ label: d.label, file: d.file, gated: d.gated });
  }
  console.log(`Documents: ${at.docs.length} documents for ${docsByName.size} offerings.`);
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
const statusRank = (s) => atStatusRank((s || "").trim());
const statusClass = (s) => atStatusClass((s || "").trim());
const isClosed = (o) => o._statusRaw === "Closed";
const isRejected = (o) => o._statusRaw === "Rejected";

/* ---------------- 1) data/offerings.json ---------------- */
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "offerings.json"), JSON.stringify({
  generated: new Date().toISOString(),
  source: "Airtable — Baker 1031 — Investments / Identity & Offering",
  count: offerings.length,
  offerings: offerings.map((o) => {
    const out = { slug: o._slug, page: `/offerings/${o._slug}/` };
    for (const [k, v] of Object.entries(o)) if (!k.startsWith("_") && v !== "") out[k] = v;
    out["Status (internal)"] = o._statusRaw;
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
function setImg(html, field, src, alt, dims) {
  const re = new RegExp(`<img([^>]*\\bdata-field="${reEsc(field)}"[^>]*)>`, "g");
  return html.replace(re, (m, attrs) => {
    let a = attrs.replace(/\bsrc="[^"]*"/, () => `src="${esc(src)}"`);
    if (alt) a = /\balt="/.test(a) ? a.replace(/\balt="[^"]*"/, () => `alt="${esc(alt)}"`) : `${a} alt="${esc(alt)}"`;
    // Explicit intrinsic size stops the image from collapsing the layout as it
    // loads (crawl: 161 images with no size attributes). The CSS box uses
    // object-fit: cover, so a ratio mismatch crops rather than distorts.
    if (dims) a = a.replace(/\s+(width|height)="[^"]*"/g, "") + ` width="${dims[0]}" height="${dims[1]}"`;
    return `<img${a}>`;
  });
}

function buildPage(o) {
  let html = template;
  const name = o["Investment Name"];
  const canonical = `${SITE}/offerings/${o._slug}/`;
  const photo = o["Photo Link Use"] || o["Property Photo Link"] || "";
  /* The sheet Description is a full PPM paragraph. metaTrim cuts it at a
     sentence (or clause) boundary inside 155 chars instead of hard-cutting
     mid-word at 158, which is what the Jul-2026 crawl flagged on ~40 pages. */
  const metaDesc = metaTrim(o["Description"], 155) ||
    metaTrim(`${name} — ${o["Structure"] || "DST"} offering from ${o["Sponsor"]} presented by Baker 1031 Investments.`, 155);

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
        <a class="listings-link portal-link" href="/current-offerings" style="display:none;font-weight:600;font-size:0.9rem">Listings</a>
        <a class="performance-link portal-link" href="/performance" style="display:none;font-weight:600;font-size:0.9rem">Performance</a>
        <a class="learn-link portal-link" href="/learn" style="display:none;font-weight:600;font-size:0.9rem">Learn</a>
        <span class="nav-sep" style="display:none"></span>
        <span class="welcome" style="display:none">Welcome, <span data-field="First Name">[First Name]</span></span>
        <a class="logout" style="display:none" href="#">Log Out</a>
        <a class="logout" id="investor-login" href="#">Investor Login</a>
      </div>`
  );

  /* ----- breadcrumb / back links ----- */
  html = html.replace(/<a href="#">Current Offerings<\/a>/, `<a href="/current-offerings">Current Offerings</a>`);
  html = html.replace(/(<a class="back-link" href=")#(")/, `$1/current-offerings$2`);

  /* ----- head: title / meta / canonical / OG / JSON-LD ----- */
  const headBits = [
    `<link rel="canonical" href="${canonical}">`,
    // Rejected deals keep a reference page (linked from the Performance
    // "Rejected" tab) but stay out of search results.
    isRejected(o) ? `<meta name="robots" content="noindex">` : "",
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
            { "@type": "ListItem", "position": 2, "name": "Current Offerings", "item": SITE + "/current-offerings" },
            { "@type": "ListItem", "position": 3, "name": name, "item": canonical }
          ]
        }
      ]
    })}</script>`
  ].filter(Boolean).join("\n");
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${esc(brandTitle(name))}</title>\n${headBits}`
  );

  /* ----- unique section H2s -----
     The Jul-2026 crawl flagged duplicate <h2>s on 284 pages (92% of the
     site): every offering shipped "Overview"/"Analysis", every sponsor
     "Overview"/"Key strategies & advantages", and so on. Interpolating the
     entity name makes each page's headings descriptive for readers, search
     engines, and AI answer extraction. The exact-string match only hits the
     <h2>; the tab/anchor links with the same words are untouched. */
  {
    const n = esc(name);
    const sponsorName = esc(o["Investment Firm"] || o["Sponsor"] || "the Sponsor");
    for (const [from, to] of [
      ["<h2>Overview</h2>", `<h2>${n} Overview</h2>`],
      ["<h2>Analysis</h2>", `<h2>Analysis of ${n}</h2>`],
      ["<h2>Projected Distributions</h2>", `<h2>${n} Projected Distributions</h2>`],
      ["<h2>Financing</h2>", `<h2>${n} Financing</h2>`],
      ["<h2>The Sponsor</h2>", `<h2>About ${sponsorName}</h2>`],
      ["<h2>Documents</h2>", `<h2>${n} Documents</h2>`],
      ["<h2>Complete Offering Data</h2>", `<h2>${n} &mdash; Complete Offering Data</h2>`],
    ]) html = html.replace(from, to);
  }

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
    "Offering Type (Reg D)", "Loan Type", "Connected REIT", "MSA Tier",
    "Y1 Payout Ratio", "Initial Reserves",
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
    `<p class="note">Benchmarks are calculated by Baker 1031 Investments: each metric is compared against the average across current offerings of the same property type tracked by Baker 1031 as of the last-updated date shown; a figure within &plusmn;10% of that average reads &ldquo;Meets Average.&rdquo; Benchmark data is internal, unaudited, and subject to change. Review each offering&rsquo;s PPM for complete information.</p>`);

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
      <img width="400" height="75" src="${LOGO_URL}" alt="Baker 1031 Investments">
      <h3>Verified investors only</h3>
      <p>Full offering details, projections, and documents for ${esc(name)} are available to verified accredited investors.</p>
      <a class="gate-login" id="offering-gate-login" href="#">Investor Log In</a>
      <a class="gate-request" href="/?request-access=1">Request Investment Access</a>
      <p class="gate-note">Access is provisioned after a brief introductory call. Questions? invest@baker1031.com</p>
    </div>
  </div>`;
  html = html.replace(/<\/body>/, `${gate}\n</body>`);
  html = setField(html, "Investment Firm", o["Investment Firm"] || o["Sponsor"] || "");
  html = setField(html, "Year Founded", o["Sponsor Founded"] || "");

  /* ----- sponsor meta line: HQ + website now come from the linked Sponsor
     Connection record; fill when present, strip the segment when blank ----- */
  if (o["Headquarters (City, State)"] || o["Website"]) {
    html = setField(html, "Headquarters (City, State)", o["Headquarters (City, State)"] || "");
    const site = o["Website"] || "";
    const href = site ? (site.match(/^https?:/i) ? site : `https://${site}`) : "";
    const domain = site.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (site) {
      html = html.replace(/<a ([^>]*)data-field="Website"[^>]*>[\s\S]*?<\/a>/, () =>
        `<a href="${esc(href)}" target="_blank" rel="noopener" data-field="Website">${esc(domain)}</a>`);
    } else {
      html = html.replace(/\s*&middot;\s*<a [^>]*data-field="Website">[\s\S]*?<\/a>/, "");
    }
    if (!o["Headquarters (City, State)"]) {
      html = html.replace(/\s*&middot;\s*<span data-field="Headquarters \(City, State\)">[\s\S]*?<\/span>/, "");
    }
  } else {
    html = html.replace(/\s*&middot;\s*<span data-field="Headquarters \(City, State\)">[\s\S]*?<\/span>\s*&middot;\s*<a [^>]*data-field="Website">[\s\S]*?<\/a>/, "");
  }
  if (!o["Sponsor Founded"]) {
    html = html.replace(/Founded <span data-field="Year Founded"><\/span>/, "");
  }

  /* ----- sponsor logo (proxied through Cloudinary so pages never call
     logo.dev directly with the public token — audit item) ----- */
  if (o["Sponsor Image"]) html = setImg(html, "Sponsor Image", optimizedPhoto(normalizeLogo(o["Sponsor Image"]), 240), o["Sponsor"], [240, 240]);
  else html = html.replace(/<img([^>]*data-field="Sponsor Image"[^>]*)>/, `<img$1 style="display:none">`);

  /* ----- advantages list: key strategies from the linked Sponsor Connection
     record; remove the block when the sponsor has none ----- */
  if (o._advantages && o._advantages.length) {
    html = html.replace(/<ul class="advantages">[\s\S]*?<\/ul>/, () =>
      `<ul class="advantages">\n${o._advantages.map((a) => `        <li>${esc(a)}</li>`).join("\n")}\n      </ul>`);
  } else {
    html = html.replace(/<ul class="advantages">[\s\S]*?<\/ul>\s*/, "");
  }

  /* ----- hero photo ----- */
  if (photo) html = setImg(html, "Photo Link Use", optimizedPhoto(photo, 1600), `${name} property photo`, [1600, 900]);

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

  /* ----- financing: all-cash offerings get a simple note instead of a grid
     of "N/A (no debt)" cells ----- */
  if (o._debtN === 0) {
    html = html.replace(/<div class="fin-grid">[\s\S]*?<\/div>\s*(?=<\/section>)/,
      `<p class="fin-note">This is an all-cash offering &mdash; the property is owned free and clear, with no in-place financing. There is no lender, loan balance, or scheduled debt service at the trust level.</p>\n      `);
  }

  /* ----- Complete Offering Data: every tracked field in one reference table
     (excludes the narrative fields — Description, Highlights, Insights,
     Pros, Cons — which have their own sections above) ----- */
  {
    const yieldSchedule = ["Y1", "Y2", "Y3", "Y4", "Y5", "Y6", "Y7", "Y8", "Y9", "Y10"]
      .map((k, i) => o[k] ? `Y${i + 1} ${o[k]}` : null).filter(Boolean).join(" · ");
    const bmVal = (deal, mkt, interp) => (o[deal] || o[mkt])
      ? `${o[deal] || "—"} vs ${o[mkt] || "—"} market${o[interp] ? ` — ${o[interp]}` : ""}` : "";
    const groups = [
      ["Offering & Structure", [
        ["Investment Name", o["Investment Name"]],
        ["Sponsor", o["Sponsor"]],
        ["Structure", o["Structure"]],
        ["Offering Type", o["Offering Type (Reg D)"]],
        ["Status", o["Status"]],
        ["Last Updated", o["Last Updated"]],
      ]],
      ["Size & Availability", [
        ["Total Offering", o["Total Offering"]],
        ["Equity", o["Equity"]],
        ["Debt", displayDebt(o)],
        ["Available Equity", o["Available Equity"] ? `${o["Available Equity"]}${o["Available Percentage"] ? ` (${o["Available Percentage"]} of equity)` : ""}` : ""],
        ["Minimum Investment", o["Minimum Investment"]],
        ["Total Load", o["Total Load"]],
        ["Initial Reserves", o["Initial Reserves"]],
      ]],
      ["Property", [
        ["Property Type", o["Property Type"]],
        ["Strategy", o["Strategy"]],
        ["Location", o["Location (Use)"]],
        ["Property Address", o["Property Address"] || ""],
        ["Market Tier", o["MSA Tier"]],
      ]],
      ["Income & Projections", [
        ["Average Yield", o["Average Yield"]],
        ["Projected Yields (Y1–Y10)", yieldSchedule],
        ["Tax-Adjusted Yield", o["Tax Adjusted Yield (Use)"]],
        ["Cap Rate Equivalent", o["Cap Rate Equivalent"]],
        ["Year 1 NOI", o["Year 1 NOI"]],
        ["Y1 Payout Ratio", o["Y1 Payout Ratio"]],
      ]],
      ["Financing", [
        ["In-Place LTV", o["In-Place LTV"]],
        ["Lender", o["Lender"]],
        ["Loan Type", o["Loan Type"]],
        ["Interest Rate", o["Interest Rate"]],
        ["Loan Term", o["Loan Term"]],
        ["I/O Period", o["I/O Period"]],
        ["Amortization", o["Amortization"]],
        ["Y1 DSCR", o["Y1 DSCR"]],
      ]],
      ["Exit", [
        ["Estimated Hold Period", o["Estimated Hold Period"]],
        ["721 Exchange Exit", o["721 Exchange Exit"]],
        ["Connected REIT", o["Connected REIT"]],
      ]],
      ["Benchmarks (vs sector median)", [
        ["Avg. Income", bmVal("BM: Avg. Income - Deal", "BM: Avg. Income - MKT", "BM: Avg. Income - Interpret")],
        ["Growth", bmVal("BM: Growth - Deal", "BM: Growth- MKT", "BM: Growth - Interpret")],
        ["Peak", bmVal("BM: Peak - Deal", "BM: Peak- MKT", "BM: Peak - Interpret")],
      ]],
    ];
    const dataHtml = groups.map(([g, rows]) => {
      const rs = rows.filter(([, v]) => v && String(v).trim());
      if (!rs.length) return "";
      return `        <div class="dg-group">${esc(g)}</div>\n` +
        rs.map(([l, v]) => `        <div class="dg-row"><span class="dg-label">${esc(l)}</span><span class="dg-value">${esc(v)}</span></div>`).join("\n");
    }).filter(Boolean).join("\n");
    html = html.replace(/<!-- ALLDATA:START -->[\s\S]*?<!-- ALLDATA:END -->/,
      () => `<!-- ALLDATA:START -->\n${dataHtml}\n        <!-- ALLDATA:END -->`);
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

/* ---------------- 3) Listing cards + filter/sort bar ---------------- */
let closedCardsHtml = "";   // rendered on the Performance page's "Recently Closed" tab
let rejectedCardsHtml = ""; // rendered on the Performance page's "Rejected" tab
{
  const listingPath = join(ROOT, "current-offerings.html");
  let listing = readFileSync(listingPath, "utf8");
  // Closed + Rejected offerings move off the inventory and onto the
  // Performance page (their own tabs).
  const open = offerings.filter((o) => !isClosed(o) && !isRejected(o));
  const closed = offerings.filter(isClosed);
  const rejected = offerings.filter(isRejected);
  /* Default order (Jerry, 2026-07-31): status groups — Available →
     Confirm Availability → Limited → Backup → Coming Soon — A–Z inside
     each group. */
  const sorted = [...open].sort((a, b) =>
    a._rank - b._rank || a["Investment Name"].localeCompare(b["Investment Name"]));

  const chipText = (s) => (s || "");
  const makeCard = (o) => {
    const page = `/offerings/${o._slug}/`;
    const photo = o["Photo Link Use"] || o["Property Photo Link"] || "";
    const tag = slugify(o["Property Type"] || "other");
    const pctNum = o._availN != null ? o._availN : (parseFloat(o["Available Percentage"]) || 0);
    const sChip = statusClass(o["Status"]);
    const ltvRaw = (o["In-Place LTV"] || "").trim().replace(/\s*LTV\s*$/i, "");
    const ltvDisplay = !ltvRaw ? "—" : (/^0(\.0+)?\s*%$/.test(ltvRaw) ? "All-Cash" : ltvRaw);
    const states = (o["Location (Use)"] || "").split(/[,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).join(" ");
    /* data-* attributes drive the client-side filter/sort bar */
    const attrs = [
      `data-tags="${esc(tag)}"`,
      `data-status="${esc(slugify(o["Status"] || ""))}"`,
      `data-strategy="${esc(slugify(o["Strategy"] || ""))}"`,
      `data-sponsor="${esc(slugify(o["Sponsor"] || ""))}"`,
      `data-states="${esc(states)}"`,
      `data-regd="${esc(slugify(o["Offering Type (Reg D)"] || ""))}"`,
      `data-exit="${esc(slugify(o["721 Exchange Exit"] || ""))}"`,
      `data-min="${o._minN ?? ""}"`,
      `data-yield="${o._yieldN != null ? (o._yieldN * 100).toFixed(2) : ""}"`,
      `data-ltv="${o._ltvN != null ? (o._ltvN * 100).toFixed(2) : ""}"`,
      `data-avail="${o._availN != null ? o._availN.toFixed(1) : ""}"`,
      `data-created="${Date.parse(o._created) || 0}"`,
      `data-name="${esc((o["Investment Name"] || "").toLowerCase())}"`,
      `data-rank="${o._rank}"`,
      `data-preferred="${o._sponsorRec && o._sponsorRec.preferred ? 1 : 0}"`,
    ].join(" ");
    const capText = isRejected(o)
      ? "Rejected in Baker underwriting review"
      : isClosed(o)
        ? "Fully subscribed &middot; closed"
        : `${esc(o["Available Percentage"] || "—")} of equity still available${o["Available Equity"] ? ` &middot; ${esc(o["Available Equity"])}` : ""}`;
    return `      <article class="offering-card" ${attrs}>
        <a class="card-photo" href="${page}">
          ${photo ? `<img src="${esc(optimizedPhoto(photo, 640))}" alt="${esc(o["Investment Name"])}" width="640" height="360" loading="lazy" onerror="this.style.display='none'">` : ""}
          <div class="chip-row">
            <span class="status-chip${sChip ? " " + sChip : ""}">${esc(chipText(o["Status"]))}</span>
            <span class="type-chip">${esc(o["Property Type"] || "")}</span>
          </div>
        </a>
        <div class="card-body">
          <h3><a href="${page}" style="color:inherit">${esc(o["Investment Name"])}</a></h3>
          <div class="sponsor-line">${esc(o["Sponsor"] || "")}</div>
          <div class="card-stats">
            <div class="cs"><span class="label">Minimum</span><span class="value">${esc(o["Minimum Investment"] || "—")}</span></div>
            <div class="cs"><span class="label">Avg Yield</span><span class="value">${esc(o["Average Yield"] || "—")}</span></div>
            <div class="cs"><span class="label">LTV</span><span class="value">${esc(ltvDisplay)}</span></div>
            <div class="cs"><span class="label">Strategy</span><span class="value">${esc(o["Strategy"] || "—")}</span></div>
            <div class="cs"><span class="label">Est. Hold</span><span class="value">${esc(o["Estimated Hold Period"] || "—")}</span></div>
            <div class="cs"><span class="label">Location</span><span class="value">${esc(o["Location (Use)"] || "—")}</span></div>
          </div>
          <div class="availability">
            <div class="bar"><div class="fill" style="width: ${(isClosed(o) || isRejected(o)) ? 0 : Math.min(100, Math.max(0, pctNum))}%"></div></div>
            <span class="cap">${capText}</span>
          </div>
          <a class="view-btn" href="${page}">View Offering</a>
        </div>
      </article>`;
  };
  const cards = sorted.map(makeCard).join("\n");

  // "Recently closed" / "Rejected" — newest Last Updated first
  const dateVal = (o) => {
    const t = Date.parse(o["Last Updated"] || "");
    return Number.isNaN(t) ? 0 : t;
  };
  const byRecency = (a, b) => dateVal(b) - dateVal(a) || a["Investment Name"].localeCompare(b["Investment Name"]);
  closedCardsHtml = closed.length
    ? [...closed].sort(byRecency).map(makeCard).join("\n")
    : `      <p class="page-note">No recently closed offerings.</p>`;
  rejectedCardsHtml = rejected.length
    ? [...rejected].sort(byRecency).map(makeCard).join("\n")
    : `      <p class="page-note">No rejected offerings at the moment. Offerings land here when our underwriting review turns one down.</p>`;

  /* ----- filter dropdowns, built from the values actually present ----- */
  const STATE_NAMES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "Washington, DC" };
  const uniq = (fn) => [...new Set(sorted.map(fn).map((v) => (v || "").trim()).filter(Boolean))].sort();
  // Single-choice dropdown (numeric ranges)
  const sel = (key, label, opts) => {
    if (!opts.length) return "";
    return `        <label class="fctl"><span>${esc(label)}</span>
          <select class="fsel" data-key="${key}" aria-label="Filter by ${esc(label)}">
            <option value="">All</option>
${opts.map(([val, text]) => `            <option value="${esc(val)}">${esc(text)}</option>`).join("\n")}
          </select>
        </label>`;
  };
  // Multi-choice checkbox dropdown
  const msel = (key, label, opts) => {
    if (!opts.length) return "";
    return `        <div class="fctl">
          <span>${esc(label)}</span>
          <details class="fmulti" data-key="${key}">
            <summary><span class="msel-val">All</span></summary>
            <div class="fm-panel" role="group" aria-label="Filter by ${esc(label)}">
${opts.map(([val, text]) => `              <label><input type="checkbox" value="${esc(val)}"> ${esc(text)}</label>`).join("\n")}
            </div>
          </details>
        </div>`;
  };
  const types = uniq((o) => o["Property Type"]);
  const statuses = [...new Set(sorted.map((o) => o["Status"]))]
    .sort((a, b) => statusRank(a) - statusRank(b));
  const strategies = uniq((o) => o["Strategy"]).sort((a, b) =>
    ["Core", "Core-Plus", "Value-Add", "Opportunistic"].indexOf(a) - ["Core", "Core-Plus", "Value-Add", "Opportunistic"].indexOf(b));
  const sponsorNames = uniq((o) => o["Sponsor"]);
  const states = [...new Set(sorted.flatMap((o) => (o["Location (Use)"] || "").split(/[,;]+/).map((s) => s.trim()).filter(Boolean)))]
    .map((code) => [code.toLowerCase(), STATE_NAMES[code.toUpperCase()] || code])
    .sort((a, b) => a[1].localeCompare(b[1]));
  const exits = uniq((o) => o["721 Exchange Exit"]).sort((a, b) =>
    ["None", "Optional", "Mandatory", "Unclear"].indexOf(a) - ["None", "Optional", "Mandatory", "Unclear"].indexOf(b));

  const filtersHtml = [
    msel("type", "Property Type", types.map((t) => [slugify(t), t])),
    msel("status", "Availability", statuses.map((s) => [slugify(s), s])),
    msel("strategy", "Strategy", strategies.map((s) => [slugify(s), s])),
    msel("sponsor", "Sponsor", sponsorNames.map((s) => [slugify(s), s])),
    msel("state", "State", states),
    msel("exit", "721 Exchange Exit", exits.map((e) => [slugify(e), e])),
    sel("min", "Minimum Investment", [["0-50000", "Up to $50K"], ["0-100000", "Up to $100K"], ["0-250000", "Up to $250K"], ["250000-", "$250K and up"]]),
    sel("yield", "Avg Yield", [["4", "4%+"], ["5", "5%+"], ["6", "6%+"], ["7", "7%+"]]),
    sel("ltv", "Leverage", [["allcash", "All-Cash (no debt)"], ["lt50", "Under 50% LTV"], ["gte50", "50%+ LTV"]]),
    `        <div class="fctl">
          <span>Sponsors</span>
          <label class="pref-box"><input type="checkbox" id="pref-only"> Preferred only</label>
          <a class="pref-link" href="/performance">Preferred sponsor performance &rarr;</a>
        </div>`,
  ].filter(Boolean).join("\n");

  /* ----- status legend, generated from the statuses actually in the data
     so it can never drift out of sync with Airtable ----- */
  const LEGEND_DEFS = {
    "Available": "Open for new investment — equity remains and reservations are being accepted.",
    "Confirm Availability": "Remaining equity is moving quickly or being re-verified — contact us to confirm current availability before reserving.",
    "Limited Availability": "Nearly fully subscribed — only a limited amount of equity remains.",
    "Accepting Backup Reservations": "Fully reserved — we can place a backup reservation in case an allocation frees up.",
    "Under Review": "In Baker 1031's underwriting review or pre-launch — not yet open for reservations.",
    "Closed": "Fully subscribed or completed — no longer available (see the Recently Closed tab).",
    "Rejected": "Did not pass Baker 1031's underwriting review (see the Rejected tab). Not a prediction of performance.",
  };
  const legendStatuses = [...new Set(offerings.map((o) => o["Status"]))]
    .filter((s) => LEGEND_DEFS[s])
    .sort((a, b) => statusRank(a) - statusRank(b));
  const legendHtml = legendStatuses.map((s) => {
    const cls = statusClass(s);
    return `        <div class="legend-row"><span class="status-chip${cls ? " " + cls : ""}">${esc(s)}</span><p>${esc(LEGEND_DEFS[s])}</p></div>`;
  }).join("\n");

  const put3 = (src, startMark, endMark, content) => {
    const s = src.indexOf(startMark), e = src.indexOf(endMark);
    if (s === -1 || e === -1) throw new Error(`Missing ${startMark}/${endMark} markers`);
    return src.slice(0, s + startMark.length) + "\n" + content + "\n      " + src.slice(e);
  };
  listing = put3(listing, "<!-- OFFERINGS:START -->", "<!-- OFFERINGS:END -->", cards);
  listing = put3(listing, "<!-- FILTERS:START -->", "<!-- FILTERS:END -->", filtersHtml);
  listing = put3(listing, "<!-- LEGEND:START -->", "<!-- LEGEND:END -->", legendHtml);
  // Closed + Rejected live as tabs on this page too (per Jerry 2026-07-31);
  // the Performance page keeps its copies.
  listing = put3(listing, "<!-- CLOSED:START -->", "<!-- CLOSED:END -->", closedCardsHtml);
  listing = put3(listing, "<!-- REJECTED:START -->", "<!-- REJECTED:END -->", rejectedCardsHtml);
  writeFileSync(listingPath, listing);
  console.log(`Baked ${sorted.length} open + ${closed.length} closed + ${rejected.length} rejected cards + filter bar into current-offerings.html`);
}

/* ---------------- 4) performance.html — Sponsor Track Record ---------------- */
{
  const deals = [...atDeals].sort((a, b) => a.sponsor.localeCompare(b.sponsor) || a.investment.localeCompare(b.investment));

  // Sponsor name → profile-page link (covers override-added sponsors too)
  const slugByName = new Map(atSponsors.map((s) => [normName(s.name), s.slug]));
  try {
    const sup = JSON.parse(readFileSync(join(ROOT, "data", "sponsor-overrides.json"), "utf8"));
    for (const a of sup.additions || []) {
      if (a.name && !slugByName.has(normName(a.name))) slugByName.set(normName(a.name), slugify(a.name));
    }
  } catch {}
  const spLink = (name) => {
    const slug = slugByName.get(normName(name));
    return slug ? `<a href="/sponsors/${slug}/">${esc(name)}</a>` : esc(name);
  };

  const rowsHtml = deals.map((d) => `          <tr>
            <td>${spLink(d.sponsor)}</td>
            <td>${esc(d.investment)}</td>
            <td>${esc(d.location || "—")}</td>
            <td>${esc(d.assetClass || "—")}</td>
            <td class="num">${esc(d.hold || "—")}</td>
            <td class="num">${esc(d.multiple || "—")}</td>
            <td class="num">${esc(d.annual || "—")}</td>
          </tr>`).join("\n");
  const sponsorNames = [...new Set(deals.map((d) => d.sponsor))].sort();
  const optionsHtml = sponsorNames.map((s) => `        <option value="${esc(s)}">${esc(s)}</option>`).join("\n");

  // Sponsor-level table: EVERY sponsor in Airtable (per Jerry 2026-07-31),
  // with a note on rows that have no reported performance data.
  const NO_DATA_NOTE = "Sponsor firm either has not reported performance data or has not completed a full-cycle investment.";
  const sponsorRows = [...atSponsors]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const hasData = s.deals.length > 0 || (parseFloat(s.fullCycle) || 0) > 0 || s.avgAnnual || s.avgMultiple;
      const nameCell = `<td>${spLink(s.name)}${s.preferred ? ' <span class="pref-chip">Preferred</span>' : ""}</td>`;
      // No-data sponsors: one note spanning the metric columns (no extra row height)
      const metricCells = hasData
        ? `            <td class="num">${esc(s.founded || "—")}</td>
            <td class="num">${esc(s.aum || "—")}</td>
            <td class="num">${esc(s.fullCycle || (s.deals.length ? String(s.deals.length) : "") || "—")}</td>
            <td class="num">${esc(s.avgAnnual || "—")}</td>
            <td class="num">${esc(s.avgMultiple || "—")}</td>
            <td class="num">${esc(s.avgHold || "—")}</td>
            <td class="num">${esc(s.success || "—")}</td>`
        : `            <td class="sp-nodata-cell" colspan="7">${NO_DATA_NOTE}</td>`;
      return `          <tr>
            ${nameCell}
${metricCells}
          </tr>`;
    });
  if (sponsorRows.length < 5) throw new Error(`Only ${sponsorRows.length} sponsor rows — refusing to build.`);

  // ---- Preferred vs All summary (computed from the deal-level track record,
  //      same methodology as the homepage chart: average across completed
  //      programs; success = share of programs returning ≥ 1.00x equity) ----
  const prefSet = new Set(atSponsors.filter((s) => s.preferred).map((s) => normName(s.name)));
  const pct = (v) => { const m = String(v).trim().match(/^(-?\d*\.?\d+)%$/); return m ? parseFloat(m[1]) : null; };
  const mean = (arr) => arr.length ? arr.reduce((a, x) => a + x, 0) / arr.length : null;
  function groupStats(label, groupDeals) {
    const gSponsors = [...new Set(groupDeals.map((d) => normName(d.sponsor)))];
    const avgAnn = mean(groupDeals.map((d) => d._annN).filter((x) => x != null).map((x) => x * 100));
    const avgMult = mean(groupDeals.map((d) => d._multN).filter((x) => x != null));
    const avgHold = mean(groupDeals.map((d) => d._holdN).filter((x) => x != null));
    const ms = groupDeals.map((d) => d._multN).filter((x) => x != null);
    const success = ms.length ? (ms.filter((x) => x >= 1).length / ms.length) * 100 : null;
    const f = (v, suffix, digits = 2) => v === null ? "—" : v.toFixed(digits) + suffix;
    return `          <tr>
            <td style="font-weight:700">${esc(label)}</td>
            <td class="num">${gSponsors.length}</td>
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
    const prefAnnual = mean(prefDeals.map((d) => d._annN).filter((x) => x != null).map((x) => x * 100));
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
    const holds = deals.map((d) => d._holdN).filter((x) => x != null);
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
  // Closed + Rejected offerings live on the Listings page tabs only (per
  // Jerry 2026-07-31) — the Performance page no longer carries those cards.
  writeFileSync(join(ROOT, "performance.html"), perf);
  console.log(`Wrote performance.html (${sponsorRows.length} sponsors incl. no-data rows, ${deals.length} programs).`);
}

/* ---------------- 4b) Sponsor directory: profile pages + hub + deal-by-deal track records ---------------- */
{
  const cleanMult = (m) => /^\d*\.?\d+x$/i.test((m || "").trim()) ? (m || "").trim() : "";
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  // Deal-by-deal track record grouped by normalized sponsor name (fallback
  // matching for override-added sponsors without linked records)
  const dealsBy = new Map();
  for (const d of atDeals) {
    const k = normName(d.sponsor);
    if (!dealsBy.has(k)) dealsBy.set(k, []);
    dealsBy.get(k).push(d);
  }

  // Sponsor records straight from the Sponsor Connection table (adapter has
  // already normalized formats, linked deals, and lowercased slugs).
  const sponsors = atSponsors.map((s) => ({
    name: s.name,
    slug: s.slug,
    preferred: s.preferred,
    founded: s.founded,
    aum: s.aum,
    description: s.description,
    advantages: s.advantages,
    website: s.website,
    domain: s.domain,
    hq: s.hq,
    logo: normalizeLogo(s.logo),
    fullCycle: s.fullCycle,
    avgAnnual: s.avgAnnual,
    avgMultiple: s.avgMultiple,
    avgHold: s.avgHold,
    success: s.success,
    deals: s.deals,
  }));
  if (sponsors.length < 20) throw new Error(`Only ${sponsors.length} sponsors — refusing to build.`);

  /* Build-side supplement (data/sponsor-overrides.json): fills only BLANK
     fields (sheet wins once populated) and adds sponsors that have
     track-record deals but no Sponsor Connection row (e.g. Blue Door). */
  {
    const supPath = join(ROOT, "data", "sponsor-overrides.json");
    if (existsSync(supPath)) {
      const sup = JSON.parse(readFileSync(supPath, "utf8"));
      const byNorm = new Map(sponsors.map((s) => [normName(s.name), s]));
      for (const [k, patch] of Object.entries(sup.fills || {})) {
        const s = byNorm.get(k);
        if (!s) continue;
        for (const [f, v] of Object.entries(patch)) if (v && !s[f]) s[f] = v; // blank-only
      }
      let added = 0;
      for (const a of sup.additions || []) {
        const nn = normName(a.name || "");
        if (!nn || byNorm.get(nn)) continue; // sheet row wins if present
        const website = a.website || "";
        const s = {
          name: a.name, slug: slugify(a.name), preferred: !!a.preferred,
          founded: a.founded || "", aum: a.aum || "", description: a.description || "",
          advantages: a.advantages || [], website,
          domain: website.replace(/^https?:\/\//i, "").replace(/\/.*$/, ""),
          hq: a.hq || "", logo: a.logo || "",
          fullCycle: a.fullCycle || "", avgAnnual: "", avgMultiple: "", avgHold: "", success: "",
          deals: dealsBy.get(nn) || []
        };
        sponsors.push(s); byNorm.set(nn, s); added++;
      }
      if (added) console.log(`Sponsors: +${added} from sponsor-overrides.json`);
    }
  }

  // de-dupe slugs (keep first)
  { const seen = new Set(); for (const s of sponsors) { let sl = s.slug, n = 2; while (seen.has(sl)) sl = `${s.slug}-${n++}`; s.slug = sl; seen.add(sl); } }

  const withTrack = sponsors.filter((s) => s.deals.length);
  const alpha = [...sponsors].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const prefList = alpha.filter((s) => s.preferred);

  // Shared left-nav: Preferred group + All (A–Z), marking the active sponsor
  const navFor = (activeSlug) => {
    const li = (s) => `          <li><a${s.slug === activeSlug ? ' class="active"' : ""} href="/sponsors/${s.slug}/">${esc(s.name)}</a></li>`;
    const pref = prefList.length
      ? `        <details open><summary>Preferred sponsors</summary><ul>\n${prefList.map(li).join("\n")}\n        </ul></details>`
      : "";
    const azOpen = prefList.some((s) => s.slug === activeSlug) ? "" : " open";
    const az = `        <details${azOpen}><summary>All sponsors (A&ndash;Z)</summary><ul>\n${alpha.map(li).join("\n")}\n        </ul></details>`;
    return [pref, az].filter(Boolean).join("\n");
  };

  const tpl = readFileSync(join(ROOT, "sponsors", "sponsor-template.html"), "utf8");
  let count = 0;
  for (const s of sponsors) {
    const canonical = `${SITE}/sponsors/${s.slug}/`;
    const metaDesc = metaTrim(`${s.name} — DST sponsor profile: ${s.aum ? s.aum + " AUM, " : ""}${s.fullCycle ? s.fullCycle + " full-cycle deals, " : ""}strategy, and full-cycle track record tracked by Baker 1031.`, 155);

    // meta line
    const metaBits = [];
    if (s.hq) metaBits.push(esc(s.hq));
    if (s.founded) metaBits.push(`Founded ${esc(s.founded)}`);
    if (s.domain) metaBits.push(`<a href="${esc(s.website.match(/^https?:/i) ? s.website : "https://" + s.website)}" target="_blank" rel="noopener">${esc(s.domain)}</a>`);
    metaBits.push("Reviewed July 2026");
    const metaLine = metaBits.join(" &middot; ");

    // facts grid (only tiles with data)
    const facts = [
      ["Assets Under Mgmt", s.aum], ["Full-Cycle Deals", s.fullCycle],
      ["Avg Annual Return", s.avgAnnual], ["Avg Equity Multiple", s.avgMultiple],
      ["Avg Hold", s.avgHold], ["Full-Cycle Success", s.success],
      ["Year Founded", s.founded], ["Headquarters", s.hq],
    ].filter(([, v]) => v)
      .map(([l, v]) => `          <div class="sp-fact"><div class="l">${l}</div><div class="v">${esc(v)}</div></div>`).join("\n");

    // overview + lead
    const desc = s.description || `${s.name} is a real-estate sponsor tracked by Baker 1031 Investments.`;
    const lead = truncate(desc, 220);
    const overview = `        <p>${esc(desc)}</p>`;

    // advantages
    const advHtml = (s.advantages.length ? s.advantages : ["Details on this sponsor's strategy are being compiled from the Baker 1031 dataset."])
      .map((a) => `          <li>${esc(a)}</li>`).join("\n");

    // track record: summary + deal-by-deal table (for sponsors with matched deals)
    let trackHtml;
    if (s.deals.length) {
      const dd = [...s.deals].sort((a, b) => a.investment.localeCompare(b.investment));
      const aAnn = mean(dd.map((d) => d._annN).filter((x) => x != null).map((x) => x * 100));
      const aMul = mean(dd.map((d) => d._multN).filter((x) => x != null));
      const aHold = mean(dd.map((d) => d._holdN).filter((x) => x != null));
      const bits = [`${dd.length} full-cycle program${dd.length === 1 ? "" : "s"} in the Baker 1031 dataset`];
      if (aAnn !== null) bits.push(`averaging ${aAnn.toFixed(2)}% annual return`);
      if (aMul !== null) bits.push(`a ${aMul.toFixed(2)}x average equity multiple`);
      if (aHold !== null) bits.push(`a ${aHold.toFixed(1)}-year average hold`);
      const summary = `${s.name} has ${bits[0]}${bits.length > 1 ? ", " + bits.slice(1).join(", ").replace(/, ([^,]*)$/, ", and $1") : ""}.`;
      const rows = dd.map((d) => `            <tr>
              <td class="inv">${esc(d.investment)}</td>
              <td>${esc(d.location || "—")}</td>
              <td>${esc(d.assetClass || "—")}</td>
              <td class="num">${esc(d.hold || "—")}</td>
              <td class="num">${esc(cleanMult(d.multiple) || "—")}</td>
              <td class="num">${esc(d.annual || "—")}</td>
            </tr>`).join("\n");
      trackHtml = `        <p>${esc(summary)}</p>
        <div class="sp-deals-wrap">
          <table class="sp-deals">
            <caption>Deal-by-deal full-cycle track record</caption>
            <thead><tr><th scope="col">Investment</th><th scope="col">Location</th><th scope="col">Asset Class</th><th scope="col" class="num">Hold</th><th scope="col" class="num">Equity Multiple</th><th scope="col" class="num">Annual Return</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>
        <p class="sp-deals-note">Figures are sponsor-reported and not independently verified; they may reflect selection and survivorship bias, and past performance does not guarantee future results. &ldquo;Preferred&rdquo; is Baker&rsquo;s internal designation, not a rating or endorsement.</p>`;
    } else {
      trackHtml = `        <p>Baker 1031 does not yet have full-cycle, deal-by-deal results for ${esc(s.name)} in its dataset. Aggregate figures above, where shown, are sponsor-reported and not independently verified. Past performance does not guarantee future results.</p>`;
    }

    const chipHtml = s.preferred ? `<span class="sp-chip">Preferred</span>` : "";
    /* GSC Security 2026-07-29: nominative-use disclaimer, rendered above the fold on
       every sponsor profile. Required alongside the schema change below to clear the
       "Deceptive pages" manual action. */
    const disclaimerHtml = `\n<p class="sp-disclaimer" style="margin:1rem 0 0;padding:.75rem 1rem;border-left:3px solid #c9d2e4;background:#f5f7fb;font-size:.8125rem;line-height:1.5;color:#4a5568">Baker 1031 Investments is an independent broker-dealer representative and is <strong>not affiliated with, endorsed by, or sponsored by ${esc(s.name)}</strong>. This page is Baker 1031&rsquo;s own research profile of the sponsor. ${esc(s.name)} and its logo are trademarks of their respective owner, used here for identification only.</p>`;
    const logoHtml = s.logo
      ? `<img class="sp-logo" src="${esc(optimizedPhoto(s.logo, 240))}" alt="${esc(s.name)} logo" width="240" height="240" onerror="this.style.display='none'">`
      : "";

    /* GSC Security 2026-07-29 ("Deceptive pages"): this graph previously emitted a
       standalone Organization node carrying the SPONSOR's own name, url and logo on a
       baker1031.com URL - markup that asserts the page IS that company. With the
       sponsor's trademark logo and no disclaimer, that reads as third-party
       impersonation under Google's Social Engineering policy. The sponsor is now the
       SUBJECT of our profile page (about); the only Organization we assert is ours. */
    const jsonld = graphLd([
      {
        "@type": ["ProfilePage", "WebPage"], url: canonical,
        about: { "@type": "Organization", name: s.name },
        name: `${s.name} — DST Sponsor Profile`, description: metaDesc,
        isPartOf: WEBSITE_REF, author: AUTHOR, publisher: PUBLISHER, dateModified: "2026-07-01", inLanguage: "en-US",
        isAccessibleForFree: false,
        hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".learn-article" },
      },
      breadcrumbLd([["Home", `${SITE}/`], ["Sponsors", `${SITE}/sponsors`], [s.name, null]]),
    ]);

    let html = tpl;
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(brandTitle(`${s.name} — DST Sponsor Profile`))}</title>`);
    html = ensureOg(html, `${s.name} — DST Sponsor Profile`, metaDesc, canonical);
    html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(metaDesc)}">`);
    html = html.replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}">`);
    html = html.replace(/\s*<meta name="robots"[^>]*>/g, ""); // gated but crawlable (paywall markup)
    html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => jsonld);
    /* Unique section H2s (see the offering builder for why). */
    for (const [from, to] of [
      ["<h2>Overview</h2>", `<h2>${esc(s.name)} Overview</h2>`],
      ["<h2>Key strategies &amp; advantages</h2>", `<h2>${esc(s.name)} Strategies &amp; Advantages</h2>`],
      ["<h2>Track record</h2>", `<h2>${esc(s.name)} Track Record</h2>`],
      ["<h2>Current offerings from this sponsor</h2>", `<h2>Current ${esc(s.name)} Offerings</h2>`],
    ]) html = html.replace(from, to);
    html = put(html, "<!-- SP:CRUMB -->", "<!-- /SP:CRUMB -->", esc(s.name), s.slug);
    html = put(html, "<!-- SP:NAV -->", "<!-- /SP:NAV -->", navFor(s.slug), s.slug);
    html = put(html, "<!-- SP:LOGO -->", "<!-- /SP:LOGO -->", logoHtml, s.slug);
    html = put(html, "<!-- SP:CHIP -->", "<!-- /SP:CHIP -->", chipHtml, s.slug);
    html = put(html, "<!-- SP:NAME -->", "<!-- /SP:NAME -->", esc(s.name), s.slug);
    html = put(html, "<!-- SP:META -->", "<!-- /SP:META -->", metaLine, s.slug);
    html = put(html, "<!-- SP:LEAD -->", "<!-- /SP:LEAD -->", esc(lead) + disclaimerHtml, s.slug);
    html = put(html, "<!-- SP:FACTS -->", "<!-- /SP:FACTS -->", facts, s.slug);
    html = put(html, "<!-- SP:OVERVIEW -->", "<!-- /SP:OVERVIEW -->", overview, s.slug);
    html = put(html, "<!-- SP:ADV -->", "<!-- /SP:ADV -->", advHtml, s.slug);
    html = put(html, "<!-- SP:TRACK -->", "<!-- /SP:TRACK -->", trackHtml, s.slug);

    const dir = join(ROOT, "sponsors", s.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    count++;
  }

  // ----- hub: nav + cards (Preferred first, then A–Z) -----
  const cardOrder = [...prefList, ...alpha.filter((s) => !s.preferred)];
  const cards = cardOrder.map((s) => {
    /* Hub cards go through Cloudinary too, so the directory page never calls
       logo.dev directly with the public token (same rule as the profiles),
       and carry explicit dimensions so 85 logos don't shift the grid. */
    const logo = s.logo
      ? `<img src="${esc(optimizedPhoto(s.logo, 260))}" alt="${esc(s.name)} logo" width="260" height="260" loading="lazy" onerror="this.style.display='none'">`
      : `<span></span>`;
    const chip = s.preferred ? `<span class="chip">Preferred</span>` : `<span class="chip" style="visibility:hidden">.</span>`;
    const oneLine = s.aum
      ? `${esc(s.aum)} AUM${s.fullCycle ? ` &middot; ${esc(s.fullCycle)} full-cycle deals` : ""}${s.deals.length ? ` &middot; deal-by-deal track record` : ""}`
      : esc(truncate(s.description || `${s.name} — sponsor profile.`, 110));
    return `          <a class="sp-card" href="/sponsors/${s.slug}/"><div class="top">${logo}${chip}</div><h3>${esc(s.name)}</h3><p>${oneLine}</p><span class="go">View profile &rarr;</span></a>`;
  }).join("\n");
  let hub = readFileSync(join(ROOT, "sponsors.html"), "utf8");
  hub = put(hub, "<!-- SP:NAV -->", "<!-- /SP:NAV -->", navFor(null), "sponsors.html");
  hub = put(hub, "<!-- SP:CARDS -->", "<!-- /SP:CARDS -->", cards, "sponsors.html");
  writeFileSync(join(ROOT, "sponsors.html"), hub);

  // data file for sitemap + llms.txt
  writeFileSync(join(ROOT, "data", "sponsors.json"),
    JSON.stringify({ sponsors: sponsors.map((s) => ({ slug: s.slug, name: s.name, preferred: s.preferred, deals: s.deals.length })) }, null, 2));
  console.log(`Sponsors: ${count} profile pages (${withTrack.length} with deal-by-deal track records) + hub.`);
}

/* ---------------- 5) sitemap.xml ---------------- */
{
  const ADATES = JSON.parse(readFileSync(join(ROOT, "data", "article-dates.json"), "utf8"));
  const urls = [
    { loc: `${SITE}/`, priority: "1.0" },
    { loc: `${SITE}/learn`, priority: "0.6" },
    { loc: `${SITE}/performance`, priority: "0.6" },
    { loc: `${SITE}/current-offerings`, priority: "0.6" },
    { loc: `${SITE}/glossary`, priority: "0.6" },
    { loc: `${SITE}/markets`, priority: "0.6" },
    { loc: `${SITE}/audiences`, priority: "0.6" },
    { loc: `${SITE}/calculators`, priority: "0.6" },
    { loc: `${SITE}/sponsors`, priority: "0.6" },
    { loc: `${SITE}/property-types`, priority: "0.6" },
    ...["data-centers","government-leased","healthcare","hospitality","industrial","land","life-sciences","marina","multifamily","net-lease","office","oil-gas-royalties","self-storage","senior-living","small-bay-industrial","student-housing"].map((s) => ({ loc: `${SITE}/property-types/${s}/`, priority: "0.5" })),
    /* A sitemap should only list final 200 URLs. These 8 were listed with .html,
       which netlify.toml force-301s to the extensionless form the pages already
       self-canonicalize to (build-aux-pages.mjs). */
    { loc: `${SITE}/process`, priority: "0.5" },
    { loc: `${SITE}/terms`, priority: "0.3" },
    { loc: `${SITE}/disclosures`, priority: "0.3" },
    { loc: `${SITE}/reg-bi`, priority: "0.3" },
    { loc: `${SITE}/ccpa`, priority: "0.3" },
    { loc: `${SITE}/accessibility`, priority: "0.3" },
    { loc: `${SITE}/commitment-to-privacy`, priority: "0.3" },
    { loc: `${SITE}/privacy-policy`, priority: "0.3" },
    ...JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8")).terms.map((t) => ({ loc: `${SITE}/glossary/${t.slug}/`, priority: "0.5" })),
    ...JSON.parse(readFileSync(join(ROOT, "data", "markets.json"), "utf8")).jurisdictions.map((j) => ({ loc: `${SITE}/markets/${j.slug}/`, priority: "0.5" })),
    ...JSON.parse(readFileSync(join(ROOT, "data", "audiences.json"), "utf8")).audiences.map((a) => ({ loc: `${SITE}/audiences/${a.slug}/`, priority: "0.6" })),
    ...JSON.parse(readFileSync(join(ROOT, "data", "calculators.json"), "utf8")).calculators.map((c) => ({ loc: `${SITE}/calculators/${c.slug}/`, priority: "0.6" })),
    ...JSON.parse(readFileSync(join(ROOT, "data", "sponsors.json"), "utf8")).sponsors.map((s) => ({ loc: `${SITE}/sponsors/${s.slug}/`, priority: s.deals ? "0.6" : "0.5" })),
    ...JSON.parse(readFileSync(join(ROOT, "data", "learn-articles.json"), "utf8")).map((a) => ({ loc: `${SITE}/learn/${a.slug}/`, priority: "0.6", lastmod: (ADATES[a.slug] || {}).modified })),
    // Rejected offerings are noindex reference pages — keep them out of the sitemap
    ...offerings.filter((o) => !isRejected(o)).map((o) => ({
      loc: `${SITE}/offerings/${o._slug}/`,
      priority: isClosed(o) ? "0.3" : "0.7"
    }))
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}<priority>${u.priority}</priority></url>`).join("\n")}\n</urlset>\n`;
  writeFileSync(join(ROOT, "sitemap.xml"), sitemap);
  console.log(`Wrote sitemap.xml (${urls.length} URLs)`);
}

/* ---------------- llms.txt (curated index for AI / LLM crawlers) ----------------
   The llmstxt.org convention: a markdown map of the site's most useful pages so
   LLMs can find authoritative content quickly. Generated from the live data. */
{
  const arts = JSON.parse(readFileSync(join(ROOT, "data", "learn-articles.json"), "utf8"));
  const gloss = JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8")).terms || [];
  const cals = JSON.parse(readFileSync(join(ROOT, "data", "calculators.json"), "utf8")).calculators || [];
  const mkts = JSON.parse(readFileSync(join(ROOT, "data", "markets.json"), "utf8")).jurisdictions || [];
  const auds = JSON.parse(readFileSync(join(ROOT, "data", "audiences.json"), "utf8")).audiences || [];
  const byPillarName = {};
  for (const a of arts) (byPillarName[a.pillarName] || (byPillarName[a.pillarName] = [])).push(a);
  const line = (title, url, note) => `- [${title}](${SITE}${url})${note ? `: ${note}` : ""}`;

  let t = `# Baker 1031 Investments\n\n`;
  t += `> Founder-led real-estate securities firm helping accredited investors defer capital-gains tax through 1031 exchanges into institutional Delaware Statutory Trust (DST) properties, 721 UPREIT exchanges, Opportunity Zone funds, and mineral royalties. All educational content below is written by Gerald F. "Jerry" Baker, III and reviewed for compliance.\n\n`;
  t += `Securities are offered through Aurora Securities, Inc. (member FINRA/SIPC — BrokerCheck CRD #46147). This is educational information, not an offer, recommendation, or tax/legal advice; consult your own CPA and attorney.\n\n`;
  t += `Contact: Baker 1031 Investments, 650 California Street, San Francisco, CA 94108 · +1 (415) 579-1660 · invest@baker1031.com\n\n`;
  t += `## Key pages\n\n`;
  t += [
    line("Home", "/", "firm overview and strategies"),
    line("Learn (research library)", "/learn", `${arts.length} in-depth articles and guides`),
    line("Glossary", "/glossary", `${gloss.length} plain-English 1031/DST/REIT/OZ terms`),
    line("Calculators", "/calculators", `${cals.length} free interactive tax/yield tools`),
    line("Markets by state", "/markets", `${mkts.length} state and metro 1031/DST tax guides`),
    line("Who we help", "/audiences", "guidance by investor situation"),
    line("Current offerings", "/current-offerings", "DST and 1031-eligible offerings (accredited investors)"),
    line("Performance", "/performance", "aggregated full-cycle sponsor track record"),
    line("Sponsors", "/sponsors", "DST sponsor directory"),
    line("Property types", "/property-types", "16 sector guides for 1031/DST investors"),
    line("How we work", "/process.html", "the Baker 1031 process step by step"),
    line("Disclosures", "/disclosures.html"),
  ].join("\n") + "\n\n";
  for (const [pillar, list] of Object.entries(byPillarName)) {
    t += `## ${pillar.replace(/&amp;/g, "&")}\n\n`;
    t += list.slice(0, 40).map((a) => line(a.title, `/learn/${a.slug}/`)).join("\n") + "\n\n";
  }
  const spons = JSON.parse(readFileSync(join(ROOT, "data", "sponsors.json"), "utf8")).sponsors || [];
  if (spons.length) {
    const withDeals = spons.filter((s) => s.deals);
    t += `## DST sponsors\n\n`;
    t += withDeals.map((s) => line(s.name, `/sponsors/${s.slug}/`, "full-cycle deal-by-deal track record")).join("\n");
    t += (withDeals.length ? "\n" : "") + spons.filter((s) => !s.deals).map((s) => line(s.name, `/sponsors/${s.slug}/`)).join("\n") + "\n\n";
  }
  t += `## Calculators\n\n` + cals.map((c) => line(c.name, `/calculators/${c.slug}/`)).join("\n") + "\n\n";
  t += `## Glossary terms\n\n` + gloss.map((g) => line(g.term, `/glossary/${g.slug}/`)).join("\n") + "\n";
  writeFileSync(join(ROOT, "llms.txt"), t);
  console.log(`Wrote llms.txt (${t.split("\n").length} lines).`);

  /* llms-full.txt — same map with one-line summaries per page, for AI agents
     that want more context than the bare link list. */
  let tf = t.split("## ")[0]; // reuse the header/preamble
  tf += `## Learn library (with summaries)\n\n`;
  for (const [pillar, list] of Object.entries(byPillarName)) {
    tf += `### ${pillar.replace(/&amp;/g, "&")}\n\n`;
    tf += list.map((a) => line(a.title, `/learn/${a.slug}/`, a.metaDesc)).join("\n") + "\n\n";
  }
  tf += `## Glossary (with definitions)\n\n` + gloss.map((g) => line(g.term, `/glossary/${g.slug}/`, g.lead)).join("\n") + "\n\n";
  tf += `## Markets by state\n\n` + mkts.map((j) => line(j.name, `/markets/${j.slug}/`, j.metaDesc)).join("\n") + "\n\n";
  tf += `## Calculators\n\n` + cals.map((c) => line(c.name, `/calculators/${c.slug}/`, c.metaDesc)).join("\n") + "\n";
  writeFileSync(join(ROOT, "llms-full.txt"), tf);
  console.log(`Wrote llms-full.txt (${tf.split("\n").length} lines).`);
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
    const jsonld = graphLd([
      {
        "@type": "DefinedTerm", name: t.term, description: t.lead,
        inDefinedTermSet: { "@type": "DefinedTermSet", "@id": `${SITE}/glossary#set`, name: "Baker 1031 Investments Glossary", url: `${SITE}/glossary` },
        url: canonical, ...(t.source && t.source.url ? { sameAs: t.source.url } : {}),
      },
      { "@type": "WebPage", url: canonical, name: `${t.term} — Glossary`, isPartOf: WEBSITE_REF, author: AUTHOR, publisher: PUBLISHER, dateModified: "2026-07-01", inLanguage: "en-US", isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".learn-article" } },
      breadcrumbLd([["Home", `${SITE}/`], ["Learn", `${SITE}/learn`], ["Glossary", `${SITE}/glossary`], [t.term, null]]),
    ]);

    const srcAnchor = `<a href="${esc(t.source.url)}" target="_blank" rel="noopener">${esc(t.source.label)}</a>`;
    const metaLine = `By <a href="#author">Gerald F. &ldquo;Jerry&rdquo; Baker, III</a> &middot; Updated July 2026 &middot; Reviewed by Aurora Securities Compliance`;

    let html = tpl;
    // head — function replacers so `$` in data is never read as a backreference
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(brandTitle(`${t.term} — Glossary`))}</title>`);
    // t.lead doubles as the visible Definition paragraph, so long entries carry
    // a purpose-written metaDesc instead of being truncated on the page.
    html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(metaTrim(t.metaDesc || t.lead, 155))}">`);
    html = html.replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}">`);
    html = html.replace(/\s*<meta name="robots"[^>]*>/g, ""); // glossary term pages are public/indexable
    html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => jsonld);
    /* Unique section H2s (see the offering builder for why). */
    for (const [from, to] of [
      ["<h2>Definition</h2>", `<h2>What Is ${esc(t.term)}?</h2>`],
      ["<h2>Key points</h2>", `<h2>Key Points About ${esc(t.term)}</h2>`],
      ["<h2>Related terms</h2>", `<h2>Terms Related to ${esc(t.term)}</h2>`],
    ]) html = html.replace(from, to);
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
    html = ensureOg(html, `${t.term} — Glossary`, t.lead, canonical);

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
    const placeName = j.name.replace(/&amp;/g, "&");
    const place = j.type === "metro"
      ? { "@type": "City", name: placeName, ...(j.stateOf ? { containedInPlace: { "@type": "AdministrativeArea", name: j.stateOf } } : {}) }
      : { "@type": "AdministrativeArea", name: placeName, containedInPlace: { "@type": "Country", name: "United States" } };
    const jsonld = graphLd([
      { "@type": "WebPage", url: canonical, name: `1031 Exchange & DST Investing in ${placeName}`, description: j.metaDesc, isPartOf: WEBSITE_REF, author: AUTHOR, publisher: PUBLISHER, about: place, dateModified: "2026-07-01", inLanguage: "en-US", isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".learn-article" } },
      (j.faq || []).length ? { "@type": "FAQPage", mainEntity: j.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) } : null,
      breadcrumbLd([["Home", `${SITE}/`], ["Learn", `${SITE}/learn`], ["Markets", `${SITE}/markets`], [placeName, null]]),
    ]);

    let html = tpl;
    // head — function replacers so `$`/`%` in data is never read as a backreference
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(brandTitle(`1031 Exchange & DST Investing in ${j.name}`))}</title>`);
    html = ensureOg(html, `1031 Exchange & DST Investing in ${j.name}`, j.metaDesc, canonical);
    html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(metaTrim(j.metaDesc, 155))}">`);
    html = html.replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}">`);
    html = html.replace(/\s*<meta name="robots"[^>]*>/g, ""); // market pages are public/indexable
    html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => jsonld);
    /* Unique section H2s (see the offering builder for why). */
    for (const [from, to] of [
      ["<h2>State tax treatment of a 1031 exchange</h2>", `<h2>${esc(j.name)} Tax Treatment of a 1031 Exchange</h2>`],
      ["<h2>Market snapshot</h2>", `<h2>${esc(j.name)} Market Snapshot</h2>`],
      ["<h2>Why 1031 &amp; DST investors look here</h2>", `<h2>Why 1031 &amp; DST Investors Look at ${esc(j.name)}</h2>`],
      ["<h2>Replacement-property options</h2>", `<h2>Replacement-Property Options for ${esc(j.name)} Investors</h2>`],
      ["<h2>Frequently asked questions</h2>", `<h2>${esc(j.name)} 1031 Exchange FAQ</h2>`],
    ]) html = html.replace(from, to);
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

/* ---------------- Audiences: generate landing pages + hub from data/audiences.json ---------------- */
{
  const ad = JSON.parse(readFileSync(join(ROOT, "data", "audiences.json"), "utf8"));
  const items = ad.audiences || [];
  if (items.length < 3) throw new Error(`Only ${items.length} audiences — refusing to build.`);
  const tpl = readFileSync(join(ROOT, "audiences", "audience-template.html"), "utf8");

  // Left-nav folder (shared by hub + pages); marks the active audience.
  const foldersFor = (activeSlug) => {
    const lis = items.map((a) => `          <li><a${a.slug === activeSlug ? ' class="active"' : ""} href="/audiences/${a.slug}/">${esc(a.name)}</a></li>`).join("\n");
    return `        <details open><summary>Who We Help</summary><ul>\n${lis}\n        </ul></details>`;
  };

  // ----- landing pages -----
  let count = 0;
  for (const a of items) {
    const canonical = `${SITE}/audiences/${a.slug}/`;
    const painsLis = (a.pains || []).map((p) => `          <li>${p}</li>`).join("\n");
    const helpLis = (a.helpPoints || []).map((p) => `          <li>${p}</li>`).join("\n");
    const faqHtml = (a.faq || []).map((f) => `          <details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("\n");
    const jsonld = graphLd([
      { "@type": "WebPage", url: canonical, name: a.title || a.name, description: a.metaDesc, isPartOf: WEBSITE_REF, author: AUTHOR, publisher: PUBLISHER, audience: { "@type": "Audience", audienceType: a.name }, dateModified: "2026-07-01", inLanguage: "en-US", isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".learn-article" } },
      (a.faq || []).length ? { "@type": "FAQPage", mainEntity: a.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) } : null,
      breadcrumbLd([["Home", `${SITE}/`], ["Who We Help", `${SITE}/audiences`], [a.name, null]]),
    ]);

    let html = tpl;
    // head — function replacers so any `$` in copy is never read as a backreference
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(brandTitle(a.title))}</title>`);
    html = ensureOg(html, a.title, a.metaDesc, canonical);
    html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(metaTrim(a.metaDesc, 155))}">`);
    html = html.replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}">`);
    html = html.replace(/\s*<meta name="robots"[^>]*>/g, ""); // audience pages are public/indexable
    html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => jsonld);
    /* Unique section H2s (see the offering builder for why). */
    for (const [from, to] of [
      ["<h2>Is this you?</h2>", `<h2>Is This You? Signs a 1031 Exchange Fits ${esc(a.name)}</h2>`],
      ["<h2>How Baker 1031 helps</h2>", `<h2>How Baker 1031 Helps ${esc(a.name)}</h2>`],
      ["<h2>Why work with Baker 1031</h2>", `<h2>Why ${esc(a.name)} Work With Baker 1031</h2>`],
      ["<h2>Frequently asked questions</h2>", `<h2>${esc(a.name)}: 1031 Exchange FAQ</h2>`],
    ]) html = html.replace(from, to);
    // content — marker-based put()
    html = put(html, "<!-- A:CRUMB -->", "<!-- /A:CRUMB -->", esc(a.name), a.slug);
    html = put(html, "<!-- A:FOLDERS -->", "<!-- /A:FOLDERS -->", foldersFor(a.slug), a.slug);
    html = put(html, "<!-- A:KICKER -->", "<!-- /A:KICKER -->", esc(a.kicker), a.slug);
    html = put(html, "<!-- A:H1 -->", "<!-- /A:H1 -->", esc(a.headline), a.slug);
    html = put(html, "<!-- A:META -->", "<!-- /A:META -->", "July 2026", a.slug);
    html = put(html, "<!-- A:LEAD -->", "<!-- /A:LEAD -->", esc(a.lead), a.slug);
    html = put(html, "<!-- A:PAINS -->", "<!-- /A:PAINS -->", painsLis, a.slug);
    html = put(html, "<!-- A:HELPINTRO -->", "<!-- /A:HELPINTRO -->", a.helpIntro, a.slug);
    html = put(html, "<!-- A:HELPPOINTS -->", "<!-- /A:HELPPOINTS -->", helpLis, a.slug);
    html = put(html, "<!-- A:CALLOUT -->", "<!-- /A:CALLOUT -->", esc(a.callout), a.slug);
    html = put(html, "<!-- A:FAQ -->", "<!-- /A:FAQ -->", faqHtml, a.slug);

    const dir = join(ROOT, "audiences", a.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    count++;
  }

  // ----- hub (fills the sidebar folder + card grid in audiences.html) -----
  let hub = readFileSync(join(ROOT, "audiences.html"), "utf8");
  const cards = items.map((a) => `          <a href="/audiences/${a.slug}/"><span class="tag">${esc(a.kicker)}</span><h3>${esc(a.name)}</h3><p>${esc(a.card || a.lead)}</p><span class="go">Learn more &rarr;</span></a>`).join("\n");
  hub = put(hub, "<!-- AUD:FOLDERS -->", "<!-- /AUD:FOLDERS -->", foldersFor(null), "audiences.html");
  hub = put(hub, "<!-- AUD:LIST -->", "<!-- /AUD:LIST -->", cards, "audiences.html");
  writeFileSync(join(ROOT, "audiences.html"), hub);
  console.log(`Audiences: ${count} landing pages + hub (${items.length} audiences).`);
}

/* ---------------- Calculators: generate calculator pages + hub from data/calculators.json ---------------- */
{
  const cd = JSON.parse(readFileSync(join(ROOT, "data", "calculators.json"), "utf8"));
  const items = cd.calculators || [];
  if (items.length < 3) throw new Error(`Only ${items.length} calculators — refusing to build.`);
  const tpl = readFileSync(join(ROOT, "calculators", "calculator-template.html"), "utf8");

  const foldersFor = (activeSlug) => {
    const lis = items.map((c) => `          <li><a${c.slug === activeSlug ? ' class="active"' : ""} href="/calculators/${c.slug}/">${esc(c.name)}</a></li>`).join("\n");
    return `        <details open><summary>Calculators</summary><ul>\n${lis}\n        </ul></details>`;
  };

  const fieldHtml = (f) => {
    const id = `c-${f.id}`;
    if (f.type === "checkbox") {
      return `            <div class="calc-field check"><input type="checkbox" id="${id}"${f.default ? " checked" : ""}><label for="${id}">${esc(f.label)}</label></div>`;
    }
    if (f.type === "date") {
      return `            <div class="calc-field"><label for="${id}">${esc(f.label)}</label><input type="date" id="${id}" value="${esc(String(f.default || ""))}"></div>`;
    }
    if (f.type === "select") {
      const opts = (f.options || []).map((o) => `<option value="${esc(String(o.value))}"${String(o.value) === String(f.default) ? " selected" : ""}>${esc(o.label)}</option>`).join("");
      return `            <div class="calc-field"><label for="${id}">${esc(f.label)}</label><select id="${id}">${opts}</select></div>`;
    }
    return `            <div class="calc-field"><label for="${id}">${esc(f.label)}</label><input type="number" id="${id}" inputmode="decimal"${f.step ? ` step="${f.step}"` : ""} value="${f.default}"></div>`;
  };

  // ----- calculator pages -----
  let count = 0;
  for (const c of items) {
    const canonical = `${SITE}/calculators/${c.slug}/`;
    const fields = (c.fields || []).map(fieldHtml).join("\n");
    const ids = JSON.stringify((c.fields || []).map((f) => f.id));
    const notesLis = (c.notes || []).map((n) => `          <li>${n}</li>`).join("\n");
    const faqHtml = (c.faq || []).map((f) => `          <details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("\n");
    const jsonld = graphLd([
      { "@type": "WebApplication", name: c.name, description: c.metaDesc || c.lead, url: canonical, applicationCategory: "FinanceApplication", operatingSystem: "Any", isPartOf: WEBSITE_REF, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, publisher: PUBLISHER, isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".learn-article" } },
      (c.faq || []).length ? { "@type": "FAQPage", mainEntity: c.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) } : null,
      breadcrumbLd([["Home", `${SITE}/`], ["Learn", `${SITE}/learn`], ["Calculators", `${SITE}/calculators`], [c.name, null]]),
    ]);
    const script =
`  <script>
    (function () {
      var $ = function (id) { return document.getElementById(id); };
      var go = $("c-go");
      if (!go) return;
      function money(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
      var FIELDS = ${ids};
      function readVal(k) { var el = $("c-" + k); if (!el) return null; if (el.type === "checkbox") return el.checked; if (el.type === "number") return +el.value || 0; return el.value; }
      function compute(v) {${c.compute}
      }
      function render() {
        var v = {}; FIELDS.forEach(function (k) { v[k] = readVal(k); });
        var rows = compute(v) || [];
        var html = rows.map(function (r) { var cc = r.total ? " total" : ""; return '<div class="row' + cc + '"><span>' + r.label + '</span><span class="v">' + r.display + '</span></div>'; }).join("");
        var note = ${JSON.stringify(c.note || "")}; if (note) html += '<p class="calc-note">' + note + '</p>';
        var res = $("c-result"); res.innerHTML = html; res.classList.add("show");
      }
      go.addEventListener("click", render);
      render();
    })();
  </script>`;

    let html = tpl;
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(brandTitle(c.title))}</title>`);
    html = ensureOg(html, c.title, c.metaDesc, canonical);
    html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(metaTrim(c.metaDesc, 155))}">`);
    html = html.replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}">`);
    html = html.replace(/\s*<meta name="robots"[^>]*>/g, ""); // calculator pages are public/indexable
    html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => jsonld);
    html = put(html, "<!-- C:CRUMB -->", "<!-- /C:CRUMB -->", esc(c.name), c.slug);
    html = put(html, "<!-- C:FOLDERS -->", "<!-- /C:FOLDERS -->", foldersFor(c.slug), c.slug);
    html = put(html, "<!-- C:KICKER -->", "<!-- /C:KICKER -->", esc(c.kicker), c.slug);
    html = put(html, "<!-- C:H1 -->", "<!-- /C:H1 -->", esc(c.name), c.slug);
    html = put(html, "<!-- C:META -->", "<!-- /C:META -->", "July 2026", c.slug);
    html = put(html, "<!-- C:LEAD -->", "<!-- /C:LEAD -->", esc(c.lead), c.slug);
    html = put(html, "<!-- C:FIELDS -->", "<!-- /C:FIELDS -->", fields, c.slug);
    html = put(html, "<!-- C:HOWTO -->", "<!-- /C:HOWTO -->", c.howto, c.slug);
    html = put(html, "<!-- C:CALLOUT -->", "<!-- /C:CALLOUT -->", esc(c.callout || ""), c.slug);
    html = put(html, "<!-- C:NOTES -->", "<!-- /C:NOTES -->", notesLis, c.slug);
    html = put(html, "<!-- C:FAQ -->", "<!-- /C:FAQ -->", faqHtml, c.slug);
    html = put(html, "<!-- C:SCRIPT -->", "<!-- /C:SCRIPT -->", script, c.slug);

    const dir = join(ROOT, "calculators", c.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    count++;
  }

  // ----- hub -----
  let hub = readFileSync(join(ROOT, "calculators.html"), "utf8");
  const cards = items.map((c) => `          <a href="/calculators/${c.slug}/"><span class="tag">${esc(c.kicker)}</span><h3>${esc(c.name)}</h3><p>${esc(c.card || c.lead)}</p><span class="go">Open calculator &rarr;</span></a>`).join("\n");
  hub = put(hub, "<!-- CALC:FOLDERS -->", "<!-- /CALC:FOLDERS -->", foldersFor(null), "calculators.html");
  hub = put(hub, "<!-- CALC:LIST -->", "<!-- /CALC:LIST -->", cards, "calculators.html");
  writeFileSync(join(ROOT, "calculators.html"), hub);
  console.log(`Calculators: ${count} calculator pages + hub (${items.length} calculators).`);
}

/* ---------------- Learn articles: generate article pages + hub from data/learn-articles.json ---------------- */
{
  const articles = JSON.parse(readFileSync(join(ROOT, "data", "learn-articles.json"), "utf8"));
  if (articles.length < 50) throw new Error(`Only ${articles.length} learn articles — refusing to build.`);
  const tpl = readFileSync(join(ROOT, "learn", "article-template.html"), "utf8");

  const PILLARS = [
    ["1031-basics", "1031 Exchange Basics", "Rules, deadlines, boot, and the mechanics of a successful exchange."],
    ["dst-essentials", "DST Essentials", "How Delaware Statutory Trusts work, what to look for, and how to compare offerings."],
    ["721-reits", "721 Exchanges &amp; REITs", "UPREIT transactions, operating partnership units, and when a 721 exit makes sense."],
    ["opportunity-zones", "Opportunity Zones", "QOF timelines, basis step-ups, and how OZ investing compares to a 1031."],
    ["mineral-royalties", "Mineral &amp; Royalty Interests", "Direct-title mineral and royalty interests as 1031-eligible real property."],
    ["taxes-planning", "Taxes &amp; Planning", "Depreciation, estate planning, state considerations, and working with your CPA."],
    ["firm", "Firm, Fees &amp; Methodology", "How we work, how we&rsquo;re paid, our performance-data methodology, and who we serve."],
  ];
  const byPillar = {};
  for (const [k] of PILLARS) byPillar[k] = [];
  for (const a of articles) (byPillar[a.pillar] || (byPillar[a.pillar] = [])).push(a);
  // articles.json is already sorted by title; each pillar list stays alphabetical.

  /* Sidebar (audit): only the CURRENT pillar renders its full article list.
     Other pillars collapse to a "start here" + hub link — this removes ~50KB
     of repeated nav per page and stops template links flattening internal
     PageRank across all 525 articles. Full discovery lives on /learn. */
  const foldersFor = (activePillar, activeSlug) =>
    PILLARS.filter(([k]) => (byPillar[k] || []).length)
      .map(([k, label]) => {
        const open = k === activePillar ? " open" : "";
        if (k !== activePillar) {
          const first = byPillar[k][0];
          const n = byPillar[k].length;
          return `        <details><summary>${label}</summary><ul>\n          <li><a href="/learn/${first.slug}/">Start here: ${esc(first.title)}</a></li>\n          <li><a href="/learn">Browse all ${n} articles &rarr;</a></li>\n        </ul></details>`;
        }
        const lis = byPillar[k]
          .map((a) => `          <li><a${a.slug === activeSlug ? ' class="active"' : ""} href="/learn/${a.slug}/">${esc(a.title)}</a></li>`)
          .join("\n");
        return `        <details${open}><summary>${label}</summary><ul>\n${lis}\n        </ul></details>`;
      })
      .join("\n");

  const LINK = buildLinkDict();
  // Honest per-article dates: ledger maintained by scripts/update-article-dates.mjs (never auto-bumped).
  const DATES = JSON.parse(readFileSync(join(ROOT, "data", "article-dates.json"), "utf8"));
  const SOURCES = existsSync(join(ROOT, "data", "article-sources.json"))
    ? JSON.parse(readFileSync(join(ROOT, "data", "article-sources.json"), "utf8")) : {};
  // Consolidation (audit): overlapping clusters point readers + crawlers at one canonical pillar.
  const CANONICAL_PILLAR = {
    "delaware-statutory-trusts": "dst-guide",
    "delaware-statutory-trust-faq": "dst-guide",
    "dst-pros-and-cons": "dst-guide",
    "what-is-a-delaware-statutory-trust-dst-complete-guide": "dst-guide",
    "45-day-identification-period": "1031-exchange-timeline",
    "the-45-day-trap": "1031-exchange-timeline",
    "how-to-identify-dsts-within-the-45-day-window": "1031-exchange-timeline",
    "1031-exchange-debt-replacement-mortgage-boot": "1031-exchange-boot",
    "boot-debt-replacement-full-deferral": "1031-exchange-boot",
    "dst-risk-factors-in-the-ppm-explained": "dst-risks-what-every-1031-investor-should-know",
  };
  const SERIES = {};
  for (const [child, pillar] of Object.entries(CANONICAL_PILLAR)) (SERIES[pillar] || (SERIES[pillar] = [])).push(child);
  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const fmtDate = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return d === 1 ? `${MONTH_NAMES[m-1]} ${y}` : `${MONTH_NAMES[m-1]} ${d}, ${y}`; };
  const mkLinkify = (currentUrl) => {
    if (!LINK.re) return (s) => esc(s);
    const used = new Set(); let count = 0; const CAP = 12;
    return (raw) => {
      LINK.re.lastIndex = 0;
      let out = "", last = 0, m;
      while ((m = LINK.re.exec(raw))) {
        const whole = m[0];
        const entry = LINK.bySurface.get(m[1].toLowerCase());
        out += esc(raw.slice(last, m.index));
        last = m.index + whole.length;
        if (!entry || entry.url === currentUrl || used.has(entry.key) || count >= CAP) { out += esc(whole); continue; }
        used.add(entry.key); count++;
        out += `<a href="${entry.url.replace(SITE, "")}">${esc(whole)}</a>`;
      }
      out += esc(raw.slice(last));
      return out;
    };
  };

  const listHtml = (node, lk) => {
    const f = lk || esc;
    const tag = node.t === "ol" ? "ol" : "ul";
    const lis = node.items
      .map((it) => {
        // bold a lead-in term when the item is "Term — description" or "Term. Description"
        let m = /^(.{2,45}?)\s+[—–]\s+(.+)$/.exec(it);
        if (m) return `          <li><strong>${esc(m[1])}</strong> &mdash; ${f(m[2])}</li>`;
        m = /^([A-Z][\w'’&/ -]{1,38}?)\.\s+(.+)$/.exec(it);
        if (m && m[1].split(/\s+/).length <= 4) return `          <li><strong>${esc(m[1])}</strong>. ${f(m[2])}</li>`;
        return `          <li>${f(it)}</li>`;
      })
      .join("\n");
    return `        <${tag}>\n${lis}\n        </${tag}>`;
  };
  const statHtml = (node) => {
    const tiles = node.items
      .map((it) => {
        // value = a leading or trailing number/$ token; the rest is the label
        let m = /^([$~]?[\d][\d.,]*\s*(?:%|x|yr|bps?|K|M|B|\+)*\+?)\s+(.+)$/.exec(it) || null;
        let v, l;
        if (m) { v = m[1]; l = m[2]; }
        else { m = /^(.+?)\s+([$~]?[\d][\d.,]*\s*(?:%|x|yr|bps?|K|M|B|\+)*\+?)$/.exec(it); if (m) { v = m[2]; l = m[1]; } }
        if (v) return `          <div class="stat"><span class="stat-v">${esc(v)}</span><span class="stat-l">${esc(l)}</span></div>`;
        return `          <div class="stat"><span class="stat-l">${esc(it)}</span></div>`;
      })
      .join("\n");
    return `        <div class="learn-stats">\n${tiles}\n        </div>`;
  };
  const contactHtml = (node) => {
    const items = node.items;
    const lis = [];
    for (let i = 0; i < items.length; i++) {
      const cur = items[i], nxt = items[i + 1];
      if (/^(Email|Phone|Fax|Address|Hours|Web)$/i.test(cur) && nxt && !/^(Email|Phone|Fax|Address|Hours|Web)$/i.test(nxt)) {
        lis.push(`          <li><strong>${esc(cur)}</strong> ${esc(nxt)}</li>`);
        i++;
      } else lis.push(`          <li>${esc(cur)}</li>`);
    }
    return `        <ul class="learn-contact">\n${lis.join("\n")}\n        </ul>`;
  };
  const blockHtml = (p, lk) => {
    if (typeof p === "string") return `        <p>${(lk || esc)(p)}</p>`;
    if (p.t === "stats") return statHtml(p);
    if (p.t === "contact") return contactHtml(p);
    return listHtml(p, lk);
  };
  const pillarLabel = Object.fromEntries(PILLARS.map(([k, label]) => [k, label]));

  let count = 0;
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const canonical = `${SITE}/learn/${a.slug}/`;
    const lk = mkLinkify(canonical); // per-article: first-occurrence links, capped

    // ----- article inner -----
    const parts = [];
    parts.push(`        <div class="kicker">${esc(a.kicker)}</div>`);
    parts.push(`        <h1>${esc(a.title)}</h1>`);
    const ad = DATES[a.slug] || { published: isoDate(a.updated), modified: isoDate(a.updated) };
    parts.push(`        <div class="meta">By <a href="/learn/jerry-baker-bio/" rel="author">Gerald F. &ldquo;Jerry&rdquo; Baker, III</a> &middot; Updated ${fmtDate(ad.modified)} &middot; ${a.readMin} min read</div>`);
    if (CANONICAL_PILLAR[a.slug]) {
      const pil = articles.find((x) => x.slug === CANONICAL_PILLAR[a.slug]);
      if (pil) parts.push(`        <p class="pillar-callout">This article is part of a series &mdash; start with the definitive guide: <a href="/learn/${pil.slug}/"><strong>${esc(pil.title)}</strong></a>.</p>`);
    }
    for (const p of a.lead) parts.push(blockHtml(p, lk));
    if (a.takeaways && a.takeaways.length) {
      parts.push(`        <div class="takeaways"><strong>Key takeaways</strong><ul>${a.takeaways.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`);
    }
    for (const s of a.sections) {
      const hasBlocks = s.paras.length > 0;
      if (s.heading && hasBlocks) {
        parts.push(`        <h2>${esc(s.heading)}</h2>`);
        for (const p of s.paras) parts.push(blockHtml(p, lk));
      } else if (s.heading) {
        parts.push(`        <p>${esc(s.heading)}</p>`); // heading with no body — demote to paragraph
      } else {
        for (const p of s.paras) parts.push(blockHtml(p, lk));
      }
    }
    const faq = (a.faq || []).filter((f) => f.a && f.a.length);
    if (faq.length) {
      parts.push(`        <h2 class="faq-h">Frequently asked questions</h2>`);
      for (const f of faq) {
        parts.push(`        <details class="faq"><summary>${esc(f.q)}</summary>${f.a.map((p) => `<p>${lk(p)}</p>`).join("")}</details>`);
      }
    }
    const srcs = SOURCES[a.slug];
    if (Array.isArray(srcs) && srcs.length) {
      parts.push(`        <h2>Sources &amp; further reading</h2>`);
      parts.push(`        <ul class="learn-sources">${srcs.map((s0) => `<li><a href="${s0.url}" target="_blank" rel="noopener">${esc(s0.title)}</a>${s0.note ? ` &mdash; ${esc(s0.note)}` : ""}</li>`).join("")}</ul>`);
    }
    if (SERIES[a.slug]) {
      const kids = SERIES[a.slug].map((k) => articles.find((x) => x.slug === k)).filter(Boolean);
      if (kids.length) parts.push(`        <div class="learn-related"><h2>Deep dives in this series</h2><ul>${kids.map((s2) => `<li><a href="/learn/${s2.slug}/">${esc(s2.title)}</a></li>`).join("")}</ul></div>`);
    }
    // ----- related in-pillar block -----
    const sibs = byPillar[a.pillar] || [];
    const j = sibs.findIndex((s) => s.slug === a.slug);
    const rel = [];
    for (let d = 1; rel.length < 4 && d < sibs.length; d++) {
      const s = sibs[(j + d) % sibs.length];
      if (s.slug !== a.slug && !rel.includes(s)) rel.push(s);
    }
    if (rel.length) {
      parts.push(`        <div class="learn-related"><h2>Related in ${pillarLabel[a.pillar]}</h2><ul>${rel.map((s) => `<li><a href="/learn/${s.slug}/">${esc(s.title)}</a></li>`).join("")}</ul></div>`);
    }
    const prev = i > 0 ? articles[i - 1] : null;
    const next = i < articles.length - 1 ? articles[i + 1] : null;
    const footNav =
      `        <div class="article-footer-nav">` +
      (prev ? `<a href="/learn/${prev.slug}/">&larr; ${esc(prev.title)}</a>` : `<span></span>`) +
      (next ? `<a href="/learn/${next.slug}/">${esc(next.title)} &rarr;</a>` : `<span></span>`) +
      `</div>`;
    parts.push(footNav);
    const articleInner = "\n" + parts.join("\n") + "\n        ";

    // ----- head fields: Article + FAQPage + BreadcrumbList in one @graph -----
    const dateM = isoDate(a.updated);
    const nodes = [
      {
        "@type": ["Article", "BlogPosting"],
        headline: a.title,
        description: a.metaDesc,
        datePublished: ad.published,
        dateModified: ad.modified,
        author: AUTHOR,
        publisher: PUBLISHER,
        image: OG_IMAGE,
        url: canonical,
        mainEntityOfPage: canonical,
        inLanguage: "en-US",
        articleSection: (a.pillarName || pillarLabel[a.pillar] || "").replace(/&amp;/g, "&"),
        wordCount: a.words || undefined,
        timeRequired: `PT${a.readMin || 5}M`,
        isPartOf: WEBSITE_REF,
        // Login-gated for humans but crawlable: tell Google this is gated content
        // (registered-investor access) so serving it to bots is not cloaking.
        isAccessibleForFree: false,
        hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".learn-article" },
      },
      faq.length
        ? { "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a.join(" ") } })) }
        : null,
      breadcrumbLd([["Home", `${SITE}/`], ["Learn", `${SITE}/learn`], [a.title, null]]),
      a.slug === "jerry-baker-bio" ? {
        "@type": "ProfilePage",
        mainEntity: {
          "@type": "Person",
          "@id": `${SITE}/#jerry`,
          name: 'Gerald F. "Jerry" Baker, III',
          alternateName: ["Jerry Baker", "Baker Investments"],
          jobTitle: "Founder & Managing Principal",
          worksFor: { "@type": "Organization", "@id": `${SITE}/#org`, name: "Baker 1031 Investments, LLC", alternateName: "Baker Investments", url: `${SITE}/`, telephone: "+1-415-579-1660", address: { "@type": "PostalAddress", streetAddress: "650 California Street, 7th Floor", addressLocality: "San Francisco", addressRegion: "CA", postalCode: "94108", addressCountry: "US" } },
          url: `${SITE}/learn/jerry-baker-bio/`,
          knowsAbout: ["Delaware Statutory Trusts", "1031 Exchange", "721 UPREIT Exchange", "Real Estate Investment"],
          identifier: { "@type": "PropertyValue", propertyID: "FINRA CRD", value: "7537416" },
        },
      } : null,
    ];
    const headBlock = `<meta name="description" content="${esc(metaTrim(a.metaDesc, 155))}"><link rel="canonical" href="${canonical}"><meta property="og:title" content="${esc(a.title)}"><meta property="og:description" content="${esc(a.metaDesc)}"><meta property="og:type" content="article"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${OG_IMAGE}"><meta name="twitter:card" content="summary_large_image">${graphLd(nodes)}`;

    let html = tpl;
    html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(brandTitle(a.seoTitle || a.title))}</title>`);
    html = html.replace(/\s*<meta name="robots"[^>]*>/g, ""); // articles are public/indexable
    html = put(html, "<!-- L:HEAD -->", "<!-- /L:HEAD -->", headBlock, a.slug);
    html = put(html, "<!-- L:CRUMB -->", "<!-- /L:CRUMB -->", esc(a.title), a.slug);
    html = put(html, "<!-- L:FOLDERS -->", "<!-- /L:FOLDERS -->", foldersFor(a.pillar, a.slug), a.slug);
    html = put(html, "<!-- L:ARTICLE -->", "<!-- /L:ARTICLE -->", articleInner, a.slug);

    const dir = join(ROOT, "learn", a.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    count++;
  }
  console.log(`Learn articles: ${count} pages generated.`);

  // ----- hub: fill learn.html pillar cards (if markered) -----
  if (existsSync(join(ROOT, "learn.html"))) {
    let hub = readFileSync(join(ROOT, "learn.html"), "utf8");
    if (hub.includes("<!-- LEARN:PILLARS -->")) {
      const pillarCards = PILLARS.filter(([k]) => (byPillar[k] || []).length)
        .map(([k, label, desc]) => {
          const list = byPillar[k];
          const n = list.length;
          return `      <a class="pillar" href="/learn/${list[0].slug}/">\n        <h3>${label}</h3><p>${desc}</p><span class="pillar-cta">Browse ${n} article${n === 1 ? "" : "s"} &rarr;</span>\n      </a>`;
        });
      // Resource hubs round out the grid (7 pillars + these 5 → even 3-wide 3×4 matrix).
      const extraCards = [
        ["/glossary", "Glossary", "Plain-English definitions of every 1031, DST, 721, Opportunity Zone, REIT, and tax term.", "Browse the glossary"],
        ["/calculators", "Calculators", "Estimate the tax you could defer, your replacement-property targets, deadlines, yield, and more.", "Open the calculators"],
        ["/sponsors", "Sponsors", "Profiles of the DST, 721, and Opportunity Zone sponsors we track — assets under management, full-cycle track records, and current offerings.", "Browse the sponsor directory"],
        ["/markets", "Markets by State", "1031 and DST considerations state by state — capital-gains rates, state conformity, clawback rules, and nonresident withholding.", "Explore your state"],
        ["/audiences", "Who We Help", "Guidance tailored to your situation — from tired landlords and trustees to advisors, CPAs, and first-time exchangers.", "Find your path"],
      ].map(([href, label, desc, cta]) => `      <a class="pillar" href="${href}">\n        <h3>${label}</h3><p>${desc}</p><span class="pillar-cta">${cta} &rarr;</span>\n      </a>`);
      const cards = pillarCards.concat(extraCards).join("\n");
      hub = put(hub, "<!-- LEARN:PILLARS -->", "<!-- /LEARN:PILLARS -->", cards, "learn.html");
      writeFileSync(join(ROOT, "learn.html"), hub);
    }
  }
}

/* ---------------- Hub structured data (audit): CollectionPage + ItemList ----------------
   Fills the <!-- HUB:LD --> markers in the section hubs. Idempotent via put(). */
{
  const arts = JSON.parse(readFileSync(join(ROOT, "data", "learn-articles.json"), "utf8"));
  const gloss = JSON.parse(readFileSync(join(ROOT, "data", "glossary.json"), "utf8")).terms || [];
  const mkts = JSON.parse(readFileSync(join(ROOT, "data", "markets.json"), "utf8")).jurisdictions || [];
  const auds = JSON.parse(readFileSync(join(ROOT, "data", "audiences.json"), "utf8")).audiences || [];
  const cals = JSON.parse(readFileSync(join(ROOT, "data", "calculators.json"), "utf8")).calculators || [];
  const spons = JSON.parse(readFileSync(join(ROOT, "data", "sponsors.json"), "utf8")).sponsors || [];
  const itemList = (items, max = 12) => ({
    "@type": "ItemList",
    numberOfItems: items.length,
    itemListElement: items.slice(0, max).map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, url: it.url })),
  });
  const collection = (url, name, about, items) => graphLd([
    { "@type": "CollectionPage", "@id": url, url, name, isPartOf: WEBSITE_REF, publisher: PUBLISHER, about, mainEntity: itemList(items) },
    breadcrumbLd([["Home", `${SITE}/`], [name, null]]),
  ]);
  const fill = (file, ld) => {
    const p = join(ROOT, file);
    if (!existsSync(p)) return;
    let h = readFileSync(p, "utf8");
    if (!h.includes("<!-- HUB:LD -->")) return;
    h = put(h, "<!-- HUB:LD -->", "<!-- /HUB:LD -->", ld, file);
    writeFileSync(p, h);
  };
  fill("learn.html", collection(`${SITE}/learn`, "Learn — 1031 Exchange & DST Research Library", ["1031 Exchange", "Delaware Statutory Trust"],
    arts.map((a) => ({ name: a.title, url: `${SITE}/learn/${a.slug}/` }))));
  fill("markets.html", collection(`${SITE}/markets`, "1031 Exchange & DST Investing by State", ["1031 Exchange", "State Capital Gains Tax"],
    mkts.map((j) => ({ name: j.name, url: `${SITE}/markets/${j.slug}/` }))));
  fill("audiences.html", collection(`${SITE}/audiences`, "Who We Help — 1031 & DST Guidance by Investor Situation", ["1031 Exchange"],
    auds.map((a) => ({ name: a.title, url: `${SITE}/audiences/${a.slug}/` }))));
  fill("calculators.html", collection(`${SITE}/calculators`, "1031 Exchange & DST Calculators", ["1031 Exchange", "Capital Gains Tax"],
    cals.map((c) => ({ name: c.name, url: `${SITE}/calculators/${c.slug}/` }))));
  fill("sponsors.html", collection(`${SITE}/sponsors`, "DST Sponsor Directory", ["Delaware Statutory Trust"],
    spons.map((sp) => ({ name: sp.name, url: `${SITE}/sponsors/${sp.slug}/` }))));
  fill("glossary.html", graphLd([
    { "@type": "DefinedTermSet", "@id": `${SITE}/glossary#set`, name: "1031 Exchange, DST & Real Estate Securities Glossary", url: `${SITE}/glossary`, publisher: PUBLISHER,
      hasDefinedTerm: gloss.map((g) => ({ "@type": "DefinedTerm", name: g.term, url: `${SITE}/glossary/${g.slug}/` })) },
    breadcrumbLd([["Home", `${SITE}/`], ["Glossary", null]]),
  ]));
  console.log("Hub structured data injected.");
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
    "calculators.html", "calculators",
    "sponsors.html", "sponsors",
    "property-types.html", "property-types",
    "process.html", "404.html",
    "terms.html", "disclosures.html", "reg-bi.html", "ccpa.html", "accessibility.html", "commitment-to-privacy.html",
    "privacy-policy.html", "scheduled.html", "call-confirmed.html", "book.html", "schedule.html",
    "offerings", "data", "css", "js", "assets", "video", "documents",
    "sitemap.xml", "robots.txt", "llms.txt", "llms-full.txt"
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
  for (const rel of ["glossary/term-template.html", "markets/state-template.html", "learn/article-template.html", "audiences/audience-template.html", "calculators/calculator-template.html", "sponsors/sponsor-template.html"]) {
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
  // The investor-only search module (js/search.js) is loaded via dynamic
  // import from auth.js, so the HTML-level busting below can't reach it and
  // /js/* is cached immutable. Stamp search.js's content hash into auth.js's
  // import URL (SEARCHJS_V marker) BEFORE hashing js/, so a changed search.js
  // gets a fresh URL and auth.js's own ?v= reflects the stamped content.
  {
    const authPath = join(dist, "js", "auth.js");
    const searchPath = join(dist, "js", "search.js");
    if (existsSync(authPath) && existsSync(searchPath)) {
      const h = createHash("sha1").update(readFileSync(searchPath)).digest("hex").slice(0, 8);
      const s = readFileSync(authPath, "utf8");
      if (s.includes("SEARCHJS_V")) writeFileSync(authPath, s.split("SEARCHJS_V").join(h));
    }
  }
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
    // GoHighLevel website tracking — one per page, before </head> (idempotent).
    if (!s.includes("external-tracking.js") && s.includes("</head>")) {
      s = s.replace("</head>", `${GHL_TRACKING}\n</head>`);
      changed = true;
    }
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

/* ---------------- Legacy URL redirects (dist/_redirects) ----------------
   The old site served flat /<slug>.html URLs; the new structure nests them
   under /learn/, /markets/, /glossary/, /offerings/. Emit a 301 for every old
   URL whose new destination actually exists, so inbound links and search-engine
   equity carry over. Unmapped slugs fall back to the nearest section hub. */
{
  const dist = join(ROOT, "dist");
  const exists = (p) => existsSync(join(dist, p.replace(/^\//, ""), "index.html")) || existsSync(join(dist, p.replace(/^\//, "")));
  const manifest = JSON.parse(readFileSync(join(ROOT, "legacy-content", "index.json"), "utf8")).manifest;
  const learn = new Set(JSON.parse(readFileSync(join(ROOT, "data", "learn-articles.json"), "utf8")).map((a) => a.slug));
  const lines = [];
  const seen = new Set();
  let mapped = 0, fallback = 0;
  const add = (fromRaw, to) => {
    /* _redirects is whitespace-delimited: a literal space in the source path
       silently corrupts the rule. Percent-encode before emitting. */
    const from = fromRaw.replace(/ /g, "%20");
    if (!seen.has(from)) { seen.add(from); lines.push(`${from}  ${to}  301`); }
    /* GSC 2026-07-29: Google also has the EXTENSIONLESS variants of the old flat URLs
       indexed (/1031-exchange-boot as well as /1031-exchange-boot.html) - 479 of them
       were 404ing. Emit both forms, never shadowing a page that exists in dist/. */
    const bare = from.replace(/\.html$/, "");
    if (bare !== from && bare !== "" && !seen.has(bare) && !exists(bare)) {
      seen.add(bare); lines.push(`${bare}  ${to}  301`);
    }
  };

  const OVERRIDE = {
    "/investments.html": "/current-offerings",
    "/ppm-review-checklist.html": "/calculators",
    "/who-we-serve.html": "/audiences",
    "/data-center.html": "/performance",
    "/contact.html": "/#request-access",
    "/request-access.html": "/#request-access",
    "/sitemap.html": "/",
    "/ask-llm.html": "/",
    // Form CRS lives as a PDF; the other legal pages — including the Privacy
    // Policy, which now carries the SMS / mobile opt-in disclosures — are real
    // HTML pages that serve directly. Only the renamed suitability URL and the
    // Form CRS PDF need redirects.
    "/form-crs.html": "/documents/form-crs.pdf",
    "/dst-suitability-and-finra-reg-bi.html": "/reg-bi.html",
  };
  // Map the old calculator URLs to the 10 new calculators (or the hub).
  const CALC_MAP = {
    "1031-exchange-boot-calculator": "boot",
    "1031-exchange-calculator-estimate-deferred-tax": "capital-gains",
    "1031-exchange-capital-gains-tax-calculator": "capital-gains",
    "capital-gains-tax-calculator": "capital-gains",
    "capital-gains-tax-calculator-property-sales": "capital-gains",
    "1031-exchange-deadline-calculator-45-180": "deadline",
    "45-180-day-deadline-calculator": "deadline",
    "1031-replacement-property-value-calculator": "replacement-debt",
    "debt-replacement-ltv-calculator": "replacement-debt",
    "ltv-calculator-1031-debt-matching": "replacement-debt",
    "cap-rate-cash-on-cash-calculator": "cap-rate",
    "depreciation-recapture-calculator": "depreciation-recapture",
    "passive-income-calculator": "cash-on-cash",
    "royalties-vs-dst-income-calculator": "tax-adjusted-yield",
    "sell-vs-1031-exchange-calculator": "after-tax-proceeds",
  };

  for (const p of manifest) {
    let raw;
    try { raw = readFileSync(join(ROOT, "legacy-content", p.file), "utf8"); } catch { continue; }
    const m = raw.match(/^url:\s*(\S+)/m);
    if (!m) continue;
    const from = m[1].replace(/^https?:\/\/baker1031\.com/i, "");
    if (!/\.html$/.test(from) || from === "/index.html") continue;
    if (existsSync(join(dist, from.replace(/^\//, "")))) continue; // old URL is a real page now (e.g. /sponsors) — never redirect it
    if (OVERRIDE[from]) { add(from, OVERRIDE[from]); mapped++; continue; }

    const candidates = [];
    if (learn.has(p.slug)) candidates.push(`/learn/${p.slug}/`);
    if (p.category === "state") candidates.push(`/markets/${p.slug.replace(/^1031-exchange-/, "")}/`);
    if (p.category === "glossary" && p.slug !== "glossary") candidates.push(`/glossary/${p.slug.replace(/^glossary-/, "")}/`);
    if (p.category === "offering") candidates.push(`/offerings/${p.slug}/`);
    if (p.category === "calculator" && CALC_MAP[p.slug]) candidates.push(`/calculators/${CALC_MAP[p.slug]}/`);
    if (p.category === "sponsor") candidates.push(`/sponsors/${p.slug.replace(/^sponsor-/, "")}/`); // upgrades to direct once profiles are built
    if (/^property-type-/.test(p.slug)) candidates.push(`/property-types/${p.slug.replace(/^property-type-/, "")}/`);

    const dest = candidates.find((c) => exists(c));
    if (dest && dest !== from) { add(from, dest); mapped++; }
    else if (!dest) {
      // fallback to the nearest hub so the old URL never 404s
      const hub =
        p.category === "state" ? "/markets" :
        p.category === "glossary" ? "/glossary" :
        p.category === "offering" ? "/current-offerings" :
        p.category === "calculator" ? "/calculators" :
        p.category === "sponsor" ? "/sponsors" :
        ["article", "guide", "strategy", "detail"].includes(p.category) ? "/learn" : null;
      if (hub && from !== hub) { add(from, hub); fallback++; }
    }
  }
  // A few known section-index redirects
  for (const [from, to] of [["/insights.html", "/learn"], ["/guides.html", "/learn"], ["/investments.html", "/current-offerings"]]) add(from, to);

  /* ---- Directory-era URLs from the pre-July-2026 site (SEO audit 2026-07-17).
     Google still has these indexed (site: sampling) — several were ranking.
     Exact rules first; slug-preserving splats as fallback (first match wins). ---- */
  const LEGACY_DIR = [
    ["/about/jerry-baker/", "/learn/jerry-baker-bio/"],
    ["/about/jerry-baker", "/learn/jerry-baker-bio/"],
    ["/about/", "/learn/about/"],
    ["/about", "/learn/about/"],
    ["/contact/", "/#request-access"],
    ["/contact", "/#request-access"],
    ["/disclosures/", "/disclosures.html"],
    ["/disclosures", "/disclosures.html"],
    ["/investor-portal", "/current-offerings"],
    ["/investor-portal/", "/current-offerings"],
    ["/request-dst-listings", "/current-offerings"],
    ["/request-dst-listings/", "/current-offerings"],
    ["/1031-exchanges", "/learn/1031-exchange-guide/"],
    ["/1031-exchanges/", "/learn/1031-exchange-guide/"],
    ["/sitemap/", "/learn"],
    ["/sitemap", "/learn"],
    ["/home", "/"],
    ["/insights/", "/learn"],
    ["/insights", "/learn"],
    ["/properties/", "/current-offerings"],
    ["/properties", "/current-offerings"],
    ["/strategies/", "/learn"],
    ["/strategies", "/learn"],
    // old property-type names that differ from the new slugs (Netlify matches case-insensitively)
    ["/property-types/medical", "/property-types/healthcare/"],
    ["/property-types/medical/", "/property-types/healthcare/"],
    ["/property-types/retail", "/property-types/net-lease/"],
    ["/property-types/retail/", "/property-types/net-lease/"],
    ["/property-types/government", "/property-types/government-leased/"],
    ["/property-types/government/", "/property-types/government-leased/"],
    ["/property-types/oil-gas", "/property-types/oil-gas-royalties/"],
    ["/property-types/oil-gas/", "/property-types/oil-gas-royalties/"],
  ];
  // Netlify redirect matching is case-SENSITIVE; the old site used TitleCase
  // section names (/property-types/Medical). Emit capitalized variants too.
  const PT_LEGACY = {
    medical: "healthcare", retail: "net-lease", government: "government-leased", "oil-gas": "oil-gas-royalties",
    "data-centers": "data-centers", "government-leased": "government-leased", healthcare: "healthcare",
    hospitality: "hospitality", industrial: "industrial", land: "land", "life-sciences": "life-sciences",
    marina: "marina", multifamily: "multifamily", "net-lease": "net-lease", office: "office",
    "oil-gas-royalties": "oil-gas-royalties", "self-storage": "self-storage", "senior-living": "senior-living",
    "small-bay-industrial": "small-bay-industrial", "student-housing": "student-housing",
  };
  const caps = (x) => x.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("-");
  for (const [oldSlug, newSlug] of Object.entries(PT_LEGACY)) {
    for (const v of [caps(oldSlug), oldSlug.toUpperCase()]) {
      LEGACY_DIR.push([`/property-types/${v}`, `/property-types/${newSlug}/`]);
      LEGACY_DIR.push([`/property-types/${v}/`, `/property-types/${newSlug}/`]);
    }
  }
  /* Flat legacy slugs not in the legacy-content manifest but still indexed and
     404ing (GSC 2026-07-29). Every destination verified against dist/. */
  const FLAT_LEGACY = {
    "/1031-deals": "/current-offerings", "/1031-properties": "/current-offerings",
    "/listings": "/current-offerings", "/all-listings": "/current-offerings",
    "/shares": "/current-offerings", "/realized-dsts": "/current-offerings",
    "/diversified-portfolios": "/current-offerings", "/investment-properties": "/current-offerings",
    "/1031-exchange-properties": "/current-offerings", "/access-1031-exchange-listings": "/current-offerings",
    "/1031-delaware-statutory-trust-marketplace": "/current-offerings",
    "/request-listings": "/current-offerings", "/request-listings-access": "/current-offerings",
    "/request-investment-listings": "/current-offerings", "/request-1031-dst-listings": "/current-offerings",
    "/register": "/#request-access", "/registration": "/#request-access",
    "/verification": "/#request-access", "/verification-confirm": "/#request-access",
    "/baker1031.com/registration": "/#request-access",
    "/historical-performance": "/performance", "/historical-1031-dst-performance": "/performance",
    "/past-dst-performance-data": "/performance", "/sponsor-track-records": "/performance",
    "/about-us": "/learn/about/", "/meet-jerry-baker": "/learn/jerry-baker-bio/",
    "/about-jerry-baker": "/learn/jerry-baker-bio/",
    "/glossary-1031-dst-properties": "/glossary",
    "/glossary-of-1031-exchange-and-dst-property-terms": "/glossary",
    "/1031-exchange": "/learn/1031-exchange-guide/",
    "/learn/what-is-a-1031-exchange/": "/learn/1031-exchange-guide/",
    "/learn/what-is-a-dst/": "/learn/dst-guide/",
    "/delaware-statutory-trusts-dsts": "/learn/delaware-statutory-trusts/",
    "/tenant-in-common-tic-1031-exchange": "/learn/delaware-statutory-trusts/",
    "/721-exchange-1031-exchange-into-a-reit": "/learn/721-exchange-guide/",
    "/1031-exchange-and-delaware-statutory-trust-faq": "/learn/1031-exchange-faq/",
    "/1031-exchange-dst-resources": "/learn", "/1031-investment-strategies": "/learn",
    "/real-estate-memos": "/learn", "/content-hub-1": "/learn",
    "/real-estate-has-swung-too-far-toward-simplicity": "/learn",
    "/the-quiet-compounder-a-rational-case-for-the-delaware-statutory-trust": "/learn",
    "/the-estate-planner-s-exchange-how-the-721-dst-quietly-solves-the-problem-most-heirs-never-see-coming": "/learn",
    "/lander": "/", "/homepage": "/", "/search": "/learn",
    "/1031-exchange-calculator": "/calculators",
    "/calculators/1031-dst-portfolio-builder": "/calculators",
    "/calculators/sell-vs-1031-exchange-calculator": "/calculators/after-tax-proceeds/",
    "/calculators/depreciation-recapture-calculator": "/calculators/depreciation-recapture/",
  };
  for (const [f, t] of Object.entries(FLAT_LEGACY)) { add(f, t); if (!f.endsWith("/")) add(f + "/", t); }

  /* Netlify redirect matching is case-SENSITIVE; the old site linked sponsors in
     TitleCase (/sponsors/Brookfield). Emit a cased variant per real profile page. */
  const sponsorSlugs = existsSync(join(dist, "sponsors"))
    ? readdirSync(join(dist, "sponsors")).filter((d) => statSync(join(dist, "sponsors", d)).isDirectory())
    : [];
  for (const slug of sponsorSlugs) {
    if (!exists(`/sponsors/${slug}/`)) continue;
    const v = slug.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join("-");
    if (v === slug) continue;
    add(`/sponsors/${v}`, `/sponsors/${slug}/`);
    add(`/sponsors/${v}/`, `/sponsors/${slug}/`);
  }

  for (const [f, t] of LEGACY_DIR) add(f, t);
  /* Safety net: any /sponsors/<x> with no profile page lands on the hub, not a 404.
     Non-forced, so real profile pages still serve. */
  /* Netlify silently DROPS self-referential splats: a rule of the form "/x/*  /x"
     is treated as a loop and never fires. That is why the pre-existing
     "/property-types/*  /property-types" rule never worked and the old TitleCase-
     with-spaces URLs stayed 404. Enumerate the variants instead of relying on it. */
  const titleWords = (slug) => slug.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  for (const slug of readdirSync(join(dist, "property-types")).filter((d) => statSync(join(dist, "property-types", d)).isDirectory())) {
    for (const v of new Set([titleWords(slug), titleWords(slug).replace(/ /g, "-")])) {
      if (v === slug) continue;
      add(`/property-types/${v}`, `/property-types/${slug}/`);
      add(`/property-types/${v}/`, `/property-types/${slug}/`);
    }
  }
  for (const [from, to] of [
    ["/property-types/Net-Lease Retail", "/property-types/net-lease/"],
    ["/property-types/Manufactured Housing", "/property-types"],
    ["/property-types/Medical Office", "/property-types/healthcare/"],
  ]) { add(from, to); add(from + "/", to); }

  /* Same self-referential problem killed "/sponsors/*  /sponsors". */
  for (const slug of sponsorSlugs) {
    if (!exists(`/sponsors/${slug}/`)) continue;
    for (const v of new Set([titleWords(slug), titleWords(slug).replace(/ And /g, " & "), slug.replace(/-and-/g, "-&-")])) {
      if (v === slug) continue;
      add(`/sponsors/${v}`, `/sponsors/${slug}/`);
      add(`/sponsors/${v}/`, `/sponsors/${slug}/`);
    }
  }
  for (const [from, to] of [
    ["/sponsors/AEI", "/sponsors/aei-capital-corporation/"],
    ["/sponsors/Sealy", "/sponsors/sealy-and-company/"],
  ]) { add(from, to); add(from + "/", to); }
  // Slug-preserving splats: old deep URLs mostly reused the same slugs. A miss
  // lands on the new 404 — no worse than today, and hits carry their equity.
  /* GSC 2026-07-29: these two were slug-PRESERVING and forwarded blindly, so
     /properties/<x> and /insights/<x> 301'd straight into 404s. */
  lines.push("/insights/*  /learn  301");
  const offeringSlugs = existsSync(join(dist, "offerings"))
    ? readdirSync(join(dist, "offerings")).filter((d) => statSync(join(dist, "offerings", d)).isDirectory())
    : [];
  for (const slug of offeringSlugs) {
    add(`/properties/${slug}`, `/offerings/${slug}/`);
    add(`/properties/${slug}/`, `/offerings/${slug}/`);
  }
  lines.push("/properties/*  /current-offerings  301");
  add("/offerings", "/current-offerings");
  add("/offerings/", "/current-offerings");
  lines.push("/strategies/*  /learn  301");
  lines.push("/property-types/*  /property-types  301");

  /* Retired Squarespace-era collections still being crawled (GSC 2026-07-29). */
  for (const [pre, hub] of [
    ["/1031-dst-education", "/learn"], ["/1031-education-insights", "/learn"],
    ["/content-hub", "/learn"], ["/1031-dst-success-stories", "/learn"],
    ["/jerrys-insights", "/learn"], ["/tax-center", "/learn"],
    ["/guides", "/learn"], ["/1031-exchange-strategies", "/learn"],
    ["/capabilities", "/learn"], ["/about-baker-1031", "/learn/about/"],
    ["/investor-portal", "/current-offerings"], ["/property-listings", "/current-offerings"],
    ["/available-dst-properties", "/current-offerings"], ["/delaware-statutory-trust", "/current-offerings"],
    ["/request-access", "/#request-access"], ["/data-center", "/performance"],
  ]) { add(pre, hub); add(pre + "/", hub); lines.push(`${pre}/*  ${hub}  301`); }

  /* ---- URL standardization (audit): extensionless is the canonical form the
     nav already uses; force the .html duplicates to it so the 9 exact-duplicate
     pairs collapse. Netlify still serves /learn from learn.html on lookup. ---- */
  for (const hub of ["learn", "glossary", "markets", "calculators", "audiences", "sponsors", "current-offerings", "performance", "property-types"]) {
    lines.push(`/${hub}.html  /${hub}  301!`);
  }
  lines.push("/index.html  /  301!");
  // Browsers request /favicon.ico unconditionally; the PNG icons live in /assets.
  lines.push("/favicon.ico  /assets/favicon-48.png  301");

  writeFileSync(join(dist, "_redirects"), lines.join("\n") + "\n");
  console.log(`Wrote dist/_redirects (${lines.length} redirects: ${mapped} direct, ${fallback} hub-fallback).`);
}

/* ---------------- SEO guard (audit) ----------------
   Reports anything in dist/ that would trip the Screaming Frog checks again:
   over-length titles/descriptions, missing <h2>, images with no dimensions,
   and any brand logo that slipped out untransformed. Warns rather than fails
   — a handful of Learn headlines are long on their own words and are worked
   through editorially — but a regression shows up in the deploy log. */
{
  const dist = join(ROOT, "dist");
  const long = { title: [], desc: [], noH2: [], noDim: 0, rawLogo: 0 };
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      if (["assets", "css", "js", "documents", "data", "video"].includes(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!e.endsWith(".html")) continue;
      const s = readFileSync(p, "utf8");
      const rel = p.slice(dist.length) || "/";
      const unesc = (x) => x.replace(/&amp;/g, "&").replace(/&mdash;/g, "—").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&rsquo;/g, "’").replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”");
      const tm = s.match(/<title>([\s\S]*?)<\/title>/);
      if (tm && unesc(tm[1]).trim().length > 60) long.title.push(`${rel} (${unesc(tm[1]).trim().length})`);
      const dm = s.match(/<meta name="description" content="([\s\S]*?)">/);
      if (dm && unesc(dm[1]).length > 155) long.desc.push(`${rel} (${unesc(dm[1]).length})`);
      if (!/<h2[\s>]/.test(s)) long.noH2.push(rel);
      for (const tag of s.match(/<img[^>]*>/g) || []) if (!/width=/.test(tag) || !/height=/.test(tag)) long.noDim++;
      long.rawLogo += (s.match(/upload\/v1783843015/g) || []).length;
    }
  })(dist);
  const n = (a) => a.length;
  console.log(`SEO guard: ${n(long.title)} titles >60, ${n(long.desc)} descriptions >155, ${n(long.noH2)} pages with no <h2>, ${long.noDim} images without dimensions, ${long.rawLogo} untransformed logo refs.`);
  if (n(long.desc)) console.warn(`  descriptions >155: ${long.desc.join(", ")}`);
  if (n(long.noH2)) console.warn(`  no <h2>: ${long.noH2.join(", ")}`);
  if (long.rawLogo) console.warn(`  WARNING: untransformed brand logo is back — check lib/images.mjs BRAND_LOGO usage.`);
}

console.log("Build complete.");
