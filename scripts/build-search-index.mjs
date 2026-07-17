/* ============================================================
   Algolia search index build — runs AFTER build-offerings.mjs
   (needs the data/offerings.json it generates).

   Pushes one record per public content page to the
   "baker1031_search" index:
     - Current offerings (Closed excluded — they live on the
       gated Performance page and must NOT be in the index)
     - Learn library articles
     - Glossary terms
     - Markets (states + metros)
     - Audiences
     - Calculators

   The index deliberately contains ONLY content that is already
   public in the page HTML (the soft gate is a UI overlay, not a
   content gate). Gated data — performance tables, sponsor track
   record, closed-offering results — is never indexed, because
   anything in Algolia is queryable with the public search key.

   Env (set in Netlify):
     ALGOLIA_APP_ID     (defaults to B5R182P2TL)
     ALGOLIA_WRITE_KEY  (required — the "Write API Key", NOT admin)

   Missing key → warn + skip (local builds keep working).
   Push failure → warn + exit 0 (the previous index keeps serving;
   a search hiccup must never block a site deploy).

   Run locally:
     ALGOLIA_WRITE_KEY=… node scripts/build-search-index.mjs
   ============================================================ */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = process.env.ALGOLIA_APP_ID || "B5R182P2TL";
const WRITE_KEY = process.env.ALGOLIA_WRITE_KEY || "";
const INDEX = "baker1031_search";

if (!WRITE_KEY) {
  console.warn("search-index: ALGOLIA_WRITE_KEY not set — skipping index push.");
  process.exit(0);
}

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const strip = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const clip = (s, n) => { s = strip(s); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };

/* ---------------- Build records ---------------- */
const records = [];

// Offerings — current only (Closed = gated Performance page, never indexed)
{
  const offerings = read("data/offerings.json").offerings;
  const open = offerings.filter((o) => (o["Status"] || "").trim().toLowerCase() !== "closed");
  for (const o of open) {
    const facts = [o["Property Type"], o["Structure"], o["Location (Use)"] || o["Location"],
      o["Minimum Investment"] && `Minimum ${o["Minimum Investment"]}`].filter(Boolean).join(" · ");
    records.push({
      objectID: `offering-${o.slug}`,
      type: "Offering",
      typeOrder: 0,
      title: o["Investment Name"],
      kicker: [o["Sponsor"], o["Property Type"], o["Location (Use)"] || o["Location"]].filter(Boolean).join(" · "),
      url: `/offerings/${o.slug}/`,
      snippet: clip(o["Description"] || facts, 180),
      body: clip([o["Sponsor"], o["Property Type"], o["Structure"], o["Strategy"],
        o["Location (Use)"], o["Location"], o["Status"], o["Description"],
        o["Highlight 1"], o["Highlight 2"], o["Highlight 3"], o["Highlight 4"], o["Highlight 5"]]
        .filter(Boolean).join(" "), 6500),
    });
  }
  console.log(`search-index: ${open.length} offerings (${offerings.length - open.length} closed excluded).`);
}

// Learn articles
{
  const articles = read("data/learn-articles.json");
  for (const a of articles) {
    const paras = (a.sections || []).flatMap((s) => [s.heading, ...(s.paras || [])]);
    const faq = (a.faq || []).flatMap((f) => [f.q, f.a]);
    records.push({
      objectID: `learn-${a.slug}`,
      type: "Article",
      typeOrder: 2,
      title: a.title,
      kicker: [a.kicker, a.pillarName].filter(Boolean).join(" · "),
      url: `/learn/${a.slug}/`,
      snippet: clip(a.metaDesc || a.lead || paras.join(" "), 180),
      body: clip([a.lead, ...(a.takeaways || []), ...paras, ...faq].filter(Boolean).join(" "), 6500),
    });
  }
  console.log(`search-index: ${articles.length} learn articles.`);
}

// Glossary terms
{
  const terms = read("data/glossary.json").terms;
  for (const t of terms) {
    records.push({
      objectID: `glossary-${t.slug}`,
      type: "Glossary",
      typeOrder: 1,
      title: t.term,
      kicker: `Glossary · ${t.category}`,
      url: `/glossary/${t.slug}/`,
      snippet: clip(t.oneLine || t.lead, 180),
      body: clip([t.term, t.lead, t.definition, ...(t.keyPoints || [])].filter(Boolean).join(" "), 6500),
    });
  }
  console.log(`search-index: ${terms.length} glossary terms.`);
}

// Markets (states + metros)
{
  const juris = read("data/markets.json").jurisdictions;
  for (const j of juris) {
    const faq = (j.faq || []).flatMap((f) => [f.q, f.a]);
    records.push({
      objectID: `market-${j.slug}`,
      type: "Market",
      typeOrder: 2,
      title: `1031 Exchange in ${j.name}`,
      kicker: `Markets · ${j.region || (j.type === "metro" ? "Metro" : "State")}`,
      url: `/markets/${j.slug}/`,
      snippet: clip(j.metaDesc || j.lead, 180),
      body: clip([j.name, j.lead, j.taxBody, j.callout, j.market, ...(Array.isArray(j.why) ? j.why : []), j.replace, ...faq]
        .filter(Boolean).join(" "), 6500),
    });
  }
  console.log(`search-index: ${juris.length} markets.`);
}

// Audiences
{
  const audiences = read("data/audiences.json").audiences;
  for (const a of audiences) {
    const faq = (a.faq || []).flatMap((f) => [f.q, f.a]);
    records.push({
      objectID: `audience-${a.slug}`,
      type: "Audience",
      typeOrder: 2,
      title: a.title || a.name,
      kicker: `Who we serve${a.kicker ? " · " + a.kicker : ""}`,
      url: `/audiences/${a.slug}/`,
      snippet: clip(a.metaDesc || a.card || a.lead, 180),
      body: clip([a.headline, a.lead, ...(Array.isArray(a.pains) ? a.pains : []), a.helpIntro,
        ...(Array.isArray(a.helpPoints) ? a.helpPoints : []), a.callout, ...faq].filter(Boolean).join(" "), 6500),
    });
  }
  console.log(`search-index: ${audiences.length} audiences.`);
}

// Calculators
{
  const calcs = read("data/calculators.json").calculators;
  for (const c of calcs) {
    const faq = (c.faq || []).flatMap((f) => [f.q, f.a]);
    records.push({
      objectID: `calculator-${c.slug}`,
      type: "Calculator",
      typeOrder: 2,
      title: c.title || c.name,
      kicker: `Calculator${c.kicker ? " · " + c.kicker : ""}`,
      url: `/calculators/${c.slug}/`,
      snippet: clip(c.metaDesc || c.card || c.lead, 180),
      body: clip([c.name, c.lead, c.howto, c.callout, c.note,
        ...(Array.isArray(c.notes) ? c.notes : []), ...faq].filter(Boolean).join(" "), 6500),
    });
  }
  console.log(`search-index: ${calcs.length} calculators.`);
}

if (records.length < 500) {
  console.warn(`search-index: only ${records.length} records — refusing to push (data problem?).`);
  process.exit(0);
}
console.log(`search-index: ${records.length} records total.`);

/* ---------------- Push to Algolia (plain REST, no SDK) ---------------- */
const api = async (method, path, body) => {
  const r = await fetch(`https://${APP_ID}.algolia.net/1/indexes/${path}`, {
    method,
    headers: {
      "X-Algolia-Application-Id": APP_ID,
      "X-Algolia-API-Key": WRITE_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Algolia ${method} ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
};

try {
  // Index settings (idempotent)
  await api("PUT", `${INDEX}/settings`, {
    searchableAttributes: ["title", "kicker", "body"],
    attributesForFaceting: ["filterOnly(type)"],
    attributesToRetrieve: ["title", "kicker", "url", "type", "snippet"],
    attributesToSnippet: ["body:20"],
    customRanking: ["asc(typeOrder)"],
    highlightPreTag: "<mark>",
    highlightPostTag: "</mark>",
    typoTolerance: true,
    removeWordsIfNoResults: "lastWords",
  });

  // Upsert all records in batches (objectIDs are deterministic)
  for (let i = 0; i < records.length; i += 500) {
    await api("POST", `${INDEX}/batch`, {
      requests: records.slice(i, i + 500).map((r) => ({ action: "updateObject", body: r })),
    });
  }

  // Remove stale records (pages that no longer exist)
  const live = new Set(records.map((r) => r.objectID));
  const stale = [];
  let cursor;
  do {
    const page = await api("POST", `${INDEX}/browse`, {
      attributesToRetrieve: ["objectID"], hitsPerPage: 1000, ...(cursor ? { cursor } : {}),
    });
    for (const h of page.hits) if (!live.has(h.objectID)) stale.push(h.objectID);
    cursor = page.cursor;
  } while (cursor);
  if (stale.length) {
    await api("POST", `${INDEX}/batch`, {
      requests: stale.map((id) => ({ action: "deleteObject", body: { objectID: id } })),
    });
    console.log(`search-index: deleted ${stale.length} stale records.`);
  }

  console.log(`search-index: pushed ${records.length} records to "${INDEX}".`);
} catch (err) {
  // Never fail the deploy over a search push — the previous index keeps serving.
  console.warn(`search-index: push failed (site deploy continues): ${err.message}`);
}
