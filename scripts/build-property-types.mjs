/* Generates the Property Types hub + 16 detail pages from legacy-content,
   on the insights/learn layout. Run before build-offerings.mjs. */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT = process.argv[2] || ".";
const SITE = "https://baker1031.com";
const LEGACY = join(ROOT, "legacy-content", "article");

const t = (s) => String(s == null ? "" : s)
  .replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => t(s).replace(/"/g, "&quot;");

const rawTpl = readFileSync(join(ROOT, "audiences", "audience-template.html"), "utf8");
function shell({ title, desc, canonical, jsonld = "", main, gate = "public" }) {
  let h = rawTpl;
  h = h.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${title}</title>`);
  h = h.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${attr(desc)}">`);
  h = h.replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${canonical}">`);
  h = h.replace(/\s*<meta name="robots"[^>]*>/g, "");
  h = h.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => jsonld);
  h = h.replace(/<body data-gate="[^"]*">/, `<body data-gate="${gate}">`);
  h = h.replace(/<main class="container" id="main-content">[\s\S]*?<\/main>/, () => `<main class="container" id="main-content">\n${main}\n  </main>`);
  return h;
}

/* 16 property types → source file + display name + short blurb for the hub */
const TYPES = [
  ["data-centers", "property-type-data-centers", "Data Centers", "The power-and-connectivity backbone of the digital economy, and one of the fastest-growing DST sectors."],
  ["government-leased", "property-type-government-leased", "Government-Leased", "GSA and other government tenants on long leases — credit-tenant income backed by the full faith of the lessee."],
  ["healthcare", "property-type-healthcare", "Healthcare", "Medical office and healthcare real estate riding durable demographic demand."],
  ["hospitality", "property-type-hospitality", "Hospitality", "Hotels and resorts — higher-beta, revenue-per-room income for the right investor."],
  ["industrial", "property-type-industrial", "Industrial", "Warehouse and logistics space powering e-commerce and reshoring supply chains."],
  ["land", "property-type-land", "Land", "Raw and entitled land as a 1031 replacement — appreciation-driven and patient."],
  ["life-sciences", "property-type-life-sciences", "Life Sciences", "Lab and R&D space for biotech and pharma tenants, a specialized high-barrier niche."],
  ["marina", "property-type-marina", "Marina", "Waterfront marina assets — scarce, supply-constrained, recreation-driven income."],
  ["multifamily", "property-type-multifamily", "Multifamily", "Apartments — the deepest, most-traded property type on the DST shelf."],
  ["net-lease", "property-type-net-lease", "Net Lease (NNN)", "Single-tenant net-lease properties with long leases and predictable, hands-off income."],
  ["office", "property-type-office", "Office", "Office DSTs in a hybrid-work world — where the risks and the opportunities both sit."],
  ["oil-gas-royalties", "property-type-oil-gas-royalties", "Oil & Gas Royalties", "Mineral and royalty interests as 1031-eligible real property with depletion advantages."],
  ["self-storage", "property-type-self-storage", "Self-Storage", "Recession-resilient storage income with low operating intensity."],
  ["senior-living", "property-type-senior-living", "Senior Living", "Senior housing riding a powerful demographic wave of aging demand."],
  ["small-bay-industrial", "property-type-small-bay-industrial", "Small-Bay Industrial", "Multi-tenant small-bay industrial — granular demand and pricing power."],
  ["student-housing", "property-type-student-housing", "Student Housing", "Purpose-built student housing near anchor universities — its pros, cons, and risks."],
];

/* ---- parse one property-type article into lead + sections + quote ---- */
function parse(file) {
  const raw = readFileSync(join(LEGACY, `${file}.md`), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const stop = /^(On this page|On This Page|Executive summary audio|Your browser does not support|Explore the Baker 1031|Related (guides|articles)|Glossary$|Sources (&|and) References$|Sources$|Disclosures$|1031 Exchanges$|DSTs$|721 \/ UPREITs$|Opportunity Zones$|Mineral & Royalty|REITs$|Current Offerings$|Sponsor Directory$)/;
  const lines = [];
  for (let l of raw.split("\n")) {
    l = l.trim();
    if (!l || l.includes("❯") || l.includes("| Baker 1031") || /^Back to /.test(l)) continue;
    if (stop.test(l)) break;
    lines.push(l);
  }
  // byline line contains "min read"; content starts after it
  const by = lines.findIndex((l) => /min read/.test(l));
  const rest = lines.slice(by >= 0 ? by + 1 : 0);

  const isBullet = (l) => /^(❯|•|-)\s+/.test(l);
  const capsAfterFirst = (l) => l.split(/\s+/).slice(1).filter((w) => /^[A-Z]/.test(w)).length;
  const repeatsWord = (l) => { const w = l.toLowerCase().match(/[a-z]{4,}/g) || []; return new Set(w).size !== w.length; };
  const isHeading = (l, next) =>
    l.length <= 78 && !isBullet(l) && !/[.:,?;]$/.test(l) && !/;/.test(l) && l.split(/\s+/).length <= 11 &&
    !/\d/.test(l) && !/[+]/.test(l) && capsAfterFirst(l) < 3 && !repeatsWord(l) &&   // reject flattened table rows
    next && next.length > 90 && !/^(❯|•|-)/.test(next) && !/["“]/.test(l.slice(-1));

  const lead = [];
  const sections = [];
  let quote = "";
  let cur = null, i = 0;
  // lead = paragraphs before first heading
  for (; i < rest.length; i++) {
    if (isHeading(rest[i], rest[i + 1])) break;
    if (rest[i].length > 40) lead.push(rest[i]);
  }
  for (; i < rest.length; i++) {
    const l = rest[i];
    // pull-quote attributed to Jerry
    if (/Gerald F\.\s*["“]?Jerry["”]?\s*Baker,?\s*III\.?$/.test(l) && l.length > 90) {
      quote = l.replace(/\s*Gerald F\.\s*["“]?Jerry["”]?\s*Baker,?\s*III\.?$/, "").trim();
      continue;
    }
    if (isHeading(l, rest[i + 1])) { cur = { h: l, paras: [], bullets: [] }; sections.push(cur); continue; }
    if (!cur) { if (l.length > 40) lead.push(l); continue; }
    if (isBullet(l)) cur.bullets.push(l.replace(/^(❯|•|-)\s+/, ""));
    else cur.paras.push(l);
  }
  return { lead: lead.slice(0, 3), sections, quote };
}

/* ---- shared left nav (all 16, active marked) ---- */
const navFor = (activeSlug) => {
  const lis = TYPES.map(([slug, , name]) =>
    `          <li><a${slug === activeSlug ? ' class="active"' : ""} href="/property-types/${slug}/">${t(name)}</a></li>`).join("\n");
  return `        <details open><summary>Property types</summary><ul>\n${lis}\n        </ul></details>`;
};

/* ---- detail pages ---- */
let count = 0;
for (const [slug, file, name, blurb] of TYPES) {
  const { lead, sections, quote } = parse(file);
  const canonical = `${SITE}/property-types/${slug}/`;
  const metaDesc = `${name} for 1031 exchange & DST investors — ${blurb}`.slice(0, 300);

  const secHtml = sections.map((s) => {
    const paras = s.paras.map((p) => `        <p>${t(p)}</p>`).join("\n");
    const bl = s.bullets.length ? `        <ul>\n${s.bullets.map((b) => `          <li>${t(b)}</li>`).join("\n")}\n        </ul>` : "";
    return `        <h2>${t(s.h)}</h2>\n${paras}\n${bl}`;
  }).join("\n");
  const quoteHtml = quote ? `        <div class="callout" style="font-style:italic">${t(quote)}<br><span style="font-style:normal;font-weight:700;font-size:0.82rem">— Gerald F. &ldquo;Jerry&rdquo; Baker, III</span></div>` : "";
  const leadHtml = lead.map((l, i) => i === 0
    ? `        <p style="font-size:1.05rem;font-weight:500;color:var(--ink)">${t(l)}</p>`
    : `        <p>${t(l)}</p>`).join("\n");

  const jsonld = `<script type="application/ld+json">${JSON.stringify([
    { "@context": "https://schema.org", "@type": "Article", headline: `${name} for 1031 Exchange & DST Investors`, description: metaDesc, author: { "@type": "Person", name: 'Gerald F. "Jerry" Baker, III' }, publisher: { "@type": "Organization", name: "Baker 1031 Investments" }, url: canonical, inLanguage: "en-US", dateModified: "2026-07-01" },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Property Types", item: `${SITE}/property-types.html` },
      { "@type": "ListItem", position: 3, name },
    ] },
  ])}</script>`;

  const main = `    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="sep">&rsaquo;</span><a href="/property-types.html">Property Types</a><span class="sep">&rsaquo;</span><span class="current">${t(name)}</span></nav>

    <div class="learn-layout">
      <nav class="learn-nav" aria-label="Property types">
        <a class="learn-back" href="/property-types.html"><span aria-hidden="true">&larr;</span> All property types</a>
${navFor(slug)}
      </nav>

      <article class="learn-article">
        <div class="kicker">Property Types</div>
        <h1>${t(name)} for 1031 Exchange &amp; DST Investors</h1>
        <div class="meta">By <a href="#author">Gerald F. &ldquo;Jerry&rdquo; Baker, III</a> &middot; Updated June 2026</div>
${leadHtml}
        <a class="aud-btn" href="/#request-access">Request Investment Access</a>
${secHtml}
${quoteHtml}
        <div class="eeat" id="author" style="border-top:1px solid var(--hairline);margin-top:2rem;padding-top:1.4rem">
          <p style="font-size:0.84rem;color:var(--muted)"><strong>Gerald F. &ldquo;Jerry&rdquo; Baker, III</strong> &mdash; Founder &amp; Managing Principal, Baker 1031 Investments &middot; FINRA Series 22 / 63 &middot; SIE. <a href="/#about">Read full bio &rarr;</a></p>
        </div>
        <p class="mk-disclosure">This page is educational and is not investment, tax, or legal advice or an offer to sell or a solicitation to buy any security. Property-type characteristics are general and vary by offering; sector figures are drawn from the DST marketplace we monitor, are not Baker 1031 returns, and past performance does not guarantee future results. Offerings are available only to accredited investors and made solely through a sponsor&rsquo;s private placement memorandum. Securities offered through Aurora Securities, member FINRA/SIPC. Real estate involves risk, including possible loss of principal.</p>
        <div class="article-footer-nav"><a href="/property-types.html">&larr; All property types</a><a href="/current-offerings.html">View current offerings &rarr;</a></div>
      </article>
    </div>`;

  const html = shell({ title: `${t(name)} for 1031 Exchange &amp; DST Investors &mdash; Baker 1031`, desc: metaDesc, canonical, jsonld, main });
  const dir = join(ROOT, "property-types", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  count++;
}

/* ---- hub ---- */
{
  const cards = TYPES.map(([slug, , name, blurb]) =>
    `        <a class="pt-card" href="/property-types/${slug}/"><h3>${t(name)}</h3><p>${t(blurb)}</p><span class="pt-go">Explore ${t(name)} &rarr;</span></a>`).join("\n");
  const extraCss = `<style>
  .pt-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1.1rem; margin-top:1.4rem; }
  @media (max-width:900px){ .pt-grid{ grid-template-columns:repeat(2,1fr);} }
  @media (max-width:600px){ .pt-grid{ grid-template-columns:1fr;} }
  .pt-card { display:flex; flex-direction:column; background:#fff; border:1px solid var(--hairline); border-radius:10px; padding:1.3rem 1.4rem; transition:box-shadow .2s, transform .2s; }
  .pt-card:hover { box-shadow:0 10px 28px rgba(9,14,26,.08); transform:translateY(-2px); }
  .pt-card h3 { font-size:1.02rem; font-weight:700; color:var(--ink); margin-bottom:.4rem; }
  .pt-card p { font-size:.86rem; line-height:1.55; color:var(--muted); flex:1; }
  .pt-go { font-size:.8rem; font-weight:600; color:var(--navy); margin-top:.9rem; }
  </style>`;
  const main = `    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="sep">&rsaquo;</span><a href="/learn.html">Learn</a><span class="sep">&rsaquo;</span><span class="current">Property Types</span></nav>
    <div class="page-head" style="padding-top:0.5rem">
      <div class="kicker" style="font-size:0.72rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--navy)">Property Types</div>
      <h1>DST &amp; 1031 Property Types</h1>
      <p>Every property type that reaches the DST and 1031-exchange market has its own demand drivers, lease structure, and risk profile. These guides break down how each sector works, what the track record shows, where the risks sit, and who it suits &mdash; so you can match a replacement property to your goals.</p>
    </div>
    <div class="pt-grid">
${cards}
    </div>`;
  const jsonld = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "CollectionPage", name: "DST & 1031 Property Types", url: `${SITE}/property-types.html`,
    hasPart: TYPES.map(([slug, , name]) => ({ "@type": "Article", name, url: `${SITE}/property-types/${slug}/` }))
  })}</script>`;
  let html = shell({ title: "DST &amp; 1031 Property Types &mdash; Baker 1031 Investments", desc: "Guides to every DST and 1031-exchange property type — multifamily, industrial, net lease, self-storage, healthcare, data centers, and more.", canonical: `${SITE}/property-types.html`, jsonld, main });
  html = html.replace("</head>", `${extraCss}\n</head>`);
  writeFileSync(join(ROOT, "property-types.html"), html);
}

console.log(`build-property-types: ${count} detail pages + hub.`);
