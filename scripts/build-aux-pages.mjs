/* Generates the legal/compliance pages, the Process page, and the 404 page
   from legacy-content markdown, reusing the site shell (audiences template).
   Run BEFORE build-offerings.mjs so the files exist when dist/ is assembled. */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = process.argv[2] || ".";
const SITE = "https://baker1031.com";
const LEGACY = join(ROOT, "legacy-content", "article");

/* Escape only bare & (keep existing entities) and stray < > in prose. */
const t = (s) => String(s == null ? "" : s)
  .replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => t(s).replace(/"/g, "&quot;");

/* ---- shell from the audiences template (all CSS/header/footer/auth.js) ---- */
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
  const ogTitle = String(title).replace(/\s*(?:&mdash;|—|\|)\s*Baker 1031.*$/, "").trim();
  h = h.replace("</head>", `  <meta property="og:type" content="website">\n  <meta property="og:site_name" content="Baker 1031 Investments">\n  <meta property="og:title" content="${attr(ogTitle)}">\n  <meta property="og:description" content="${attr(desc)}">\n  <meta property="og:url" content="${canonical}">\n  <meta property="og:image" content="${SITE}/assets/og-card.png">\n  <meta name="twitter:card" content="summary_large_image">\n  <meta name="twitter:title" content="${attr(ogTitle)}">\n  <meta name="twitter:description" content="${attr(desc)}">\n  <meta name="twitter:image" content="${SITE}/assets/og-card.png">\n</head>`);
  return h;
}

/* ---- read + clean a legacy markdown file into content lines ---- */
function bodyLines(slug) {
  const raw = readFileSync(join(LEGACY, `${slug}.md`), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const stop = /^(On this page|On This Page|Executive summary audio|Your browser does not support|Explore the Baker 1031|1031 Exchanges$|DSTs$|721 \/ UPREITs$|Opportunity Zones$|Mineral & Royalty|REITs$|Current Offerings$|Sponsor Directory$)/;
  const out = [];
  for (let line of raw.split("\n")) {
    line = line.trim();
    if (!line) continue;
    if (line.includes("❯")) continue;              // breadcrumb
    if (line.includes("| Baker 1031")) continue;    // <title> echo
    if (/^Back to /.test(line)) continue;           // "Back to Home/About" nav (appears before content)
    if (stop.test(line)) break;                     // trailing boilerplate/TOC
    out.push(line);
  }
  return out;
}

/* ============================ LEGAL PAGES ============================ */
const LEGAL = [
  { slug: "terms", file: "terms", crumb: "Terms & Conditions", kicker: "Legal", title: "Terms & Conditions" },
  { slug: "disclosures", file: "disclosures", crumb: "Important Disclosures", kicker: "Legal", title: "Important Disclosures" },
  { slug: "reg-bi", file: "dst-suitability-and-finra-reg-bi", crumb: "Reg BI & DST Suitability", kicker: "Legal", title: "Regulation Best Interest & DST Suitability" },
  { slug: "ccpa", file: "ccpa", crumb: "California Privacy (CCPA/CPRA)", kicker: "Legal", title: "California Privacy Notice (CCPA/CPRA)" },
  { slug: "accessibility", file: "accessibility", crumb: "Accessibility", kicker: "Legal", title: "Accessibility Statement" },
  { slug: "commitment-to-privacy", file: "commitment-to-privacy", crumb: "Commitment to Privacy", kicker: "Legal", title: "Our Commitment to Privacy" },
];

function renderLegal(p) {
  const lines = bodyLines(p.file);
  // Drop the leading short-title echo line (e.g. "Terms", "California Privacy").
  while (lines.length && lines[0].length < 40 && !/\.\s|:/.test(lines[0]) && !/^\d+\s/.test(lines[0])) lines.shift();
  // intro = lines until the first numbered/section clause; last long line = disclaimer.
  const isNum = (l) => /^\d+\s+\S/.test(l);
  let intro = [];
  let i = 0;
  for (; i < lines.length && !isNum(lines[i]); i++) intro.push(lines[i]);
  let body = lines.slice(i);
  // The final line is the standardized regulatory disclaimer.
  let disclaimer = "";
  if (body.length && /Securities offered through Aurora/.test(body[body.length - 1])) disclaimer = body.pop();
  else if (intro.length && /Securities offered through Aurora/.test(intro[intro.length - 1])) disclaimer = intro.pop();

  // If there were no numbered clauses (label-style docs), treat non-intro lines as sections.
  if (!body.length && intro.length > 2) { body = intro.slice(1); intro = [intro[0]]; }

  const lead = intro.length ? `<p style="font-size:1.05rem;font-weight:500;color:var(--ink)">${t(intro[0])}</p>` : "";
  const introRest = intro.slice(1).map((l) => `<p>${t(l)}</p>`).join("\n        ");
  const sections = body.map((l) => {
    const m = l.match(/^(\d+)\s+(.+)$/);
    if (m) return `        <p><strong>${m[1]}.</strong> ${t(m[2])}</p>`;
    return `        <p>${t(l)}</p>`;
  }).join("\n");

  const main = `    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="sep">&rsaquo;</span><span class="current">${t(p.crumb)}</span></nav>

    <div class="learn-layout" style="grid-template-columns:1fr;max-width:56rem;margin:0 auto">
      <article class="learn-article" style="max-width:none">
        <div class="kicker">${p.kicker}</div>
        <h1>${t(p.title)}</h1>
        ${lead}
        ${introRest}
${sections}
        ${disclaimer ? `<p class="mk-disclosure">${t(disclaimer)}</p>` : ""}
        <div class="article-footer-nav"><a href="/">&larr; Home</a><a href="/disclosures">Important disclosures &rarr;</a></div>
      </article>
    </div>`;

  const desc = `${p.title} — Baker 1031 Investments.`;
  const jsonld = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "WebPage", name: p.title, url: `${SITE}/${p.slug}`,
    isPartOf: { "@id": `${SITE}/#website` }, inLanguage: "en-US"
  })}</script>`;
  return shell({ title: `${t(p.title)} &mdash; Baker 1031 Investments`, desc, canonical: `${SITE}/${p.slug}`, jsonld, main });
}

let n = 0;
for (const p of LEGAL) { writeFileSync(join(ROOT, `${p.slug}.html`), renderLegal(p)); n++; }

/* ============================ PROCESS PAGE ============================ */
function renderProcess() {
  const raw = readFileSync(join(ROOT, "legacy-content", "detail", "our-approach.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const stopRe = /^(On This Page|Back to About|Explore the Baker 1031|Current Offerings$|Sponsor Directory$)/;
  const lines = [];
  for (let l of raw.split("\n")) {
    l = l.trim();
    if (!l) continue;
    if (l.includes("❯") || l.includes("| Baker 1031")) continue;
    if (stopRe.test(l)) { if (/^On This Page/.test(l)) { continue; } }
    lines.push(l);
  }
  // byline + lead
  const byIdx = lines.findIndex((l) => /min read|Reviewed by|Updated \w+ 20/.test(l));
  const meta = byIdx >= 0 ? lines[byIdx] : "Updated June 2026";
  let rest = lines.slice(byIdx >= 0 ? byIdx + 1 : 0).filter((l) => !stopRe.test(l));
  // Remove any TOC-ish single-word lines that appear before Step 1
  const firstStep = rest.findIndex((l) => /^Step\s+\d+/i.test(l));
  const lead = firstStep > 0 ? rest.slice(0, firstStep).filter((l) => l.length > 60) : [];
  const steps = [];
  let cur = null;
  for (const l of rest.slice(firstStep >= 0 ? firstStep : 0)) {
    if (/^Step\s+\d+/i.test(l)) { cur = { n: l, head: "", paras: [], bullets: [] }; steps.push(cur); continue; }
    if (!cur) continue;
    if (!cur.head) { cur.head = l; continue; }
    if (/^❯/.test(l)) cur.bullets.push(l.replace(/^❯\s*/, ""));
    else cur.paras.push(l);
  }
  const stepHtml = steps.map((s) => {
    const b = s.bullets.length ? `<ul>\n${s.bullets.map((x) => `          <li>${t(x)}</li>`).join("\n")}\n        </ul>` : "";
    const ps = s.paras.map((p) => `<p>${t(p)}</p>`).join("\n        ");
    return `        <h2>${t(s.n)} &mdash; ${t(s.head)}</h2>\n        ${ps}\n        ${b}`;
  }).join("\n");

  const main = `    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="sep">&rsaquo;</span><a href="/learn.html">Learn</a><span class="sep">&rsaquo;</span><span class="current">Our Process</span></nav>

    <div class="learn-layout" style="grid-template-columns:1fr;max-width:56rem;margin:0 auto">
      <article class="learn-article" style="max-width:none">
        <div class="kicker">How We Work</div>
        <h1>Our Process</h1>
        <div class="meta">By <a href="#author">Gerald F. &ldquo;Jerry&rdquo; Baker, III</a> &middot; ${t(meta.replace(/^.*?(Updated)/, "$1"))}</div>
        ${lead.map((l) => `<p style="font-size:1.05rem;font-weight:500;color:var(--ink)">${t(l)}</p>`).join("\n        ")}
${stepHtml}
        <div class="eeat" id="author" style="border-top:1px solid var(--hairline);margin-top:2rem;padding-top:1.4rem">
          <p style="font-size:0.84rem;color:var(--muted)"><strong>Gerald F. &ldquo;Jerry&rdquo; Baker, III</strong> &mdash; Founder &amp; Managing Principal, Baker 1031 Investments &middot; FINRA Series 22 / 63 &middot; SIE. <a href="/#about">Read full bio &rarr;</a></p>
        </div>
        <p class="mk-disclosure">This page is educational and is not investment, tax, or legal advice or an offer to sell or a solicitation to buy any security. Offerings are available only to accredited investors and are made solely through a sponsor&rsquo;s private placement memorandum. Securities offered through Aurora Securities, member FINRA/SIPC. Real estate investments involve risk, including possible loss of principal.</p>
        <div class="article-footer-nav"><a href="/learn.html">&larr; Learn</a><a href="/#request-access">Request Investment Access &rarr;</a></div>
      </article>
    </div>`;
  const jsonld = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "HowTo", name: "The Baker 1031 DST exchange process",
    description: "How Baker 1031 works a 1031 exchange into a diversified DST portfolio, step by step.",
    step: steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, name: s.head })), url: `${SITE}/process`
  })}</script>`;
  return shell({ title: "Our Process &mdash; Baker 1031 Investments", desc: "How Baker 1031 works a 1031 exchange into a diversified DST portfolio — exchange math, position count, diversification, debt, and closing.", canonical: `${SITE}/process`, jsonld, main });
}
writeFileSync(join(ROOT, "process.html"), renderProcess());
n++;

/* ============================ 404 PAGE ============================ */
{
  const main = `    <div style="max-width:44rem;margin:5rem auto 6rem;text-align:center;padding:0 1rem">
      <div style="font-size:clamp(4rem,12vw,7rem);font-weight:800;color:var(--navy);letter-spacing:-0.03em;line-height:1">404</div>
      <h1 style="font-size:clamp(1.4rem,3vw,2rem);font-weight:800;margin:0.5rem 0 0.8rem">This page took a different exchange</h1>
      <p style="font-size:1rem;line-height:1.7;color:var(--ink-soft);max-width:34rem;margin:0 auto 2rem">The page you&rsquo;re looking for isn&rsquo;t here &mdash; it may have moved, or the link may be out of date. Here are some good places to pick up.</p>
      <div style="display:flex;flex-wrap:wrap;gap:0.7rem;justify-content:center;margin-bottom:2.5rem">
        <a href="/" style="background:var(--navy);color:#fff;font-weight:700;font-size:0.92rem;padding:0.75rem 1.4rem;border-radius:8px">Home</a>
        <a href="/learn.html" style="border:1px solid #cfd4dd;color:var(--navy);font-weight:700;font-size:0.92rem;padding:0.75rem 1.4rem;border-radius:8px">Learn</a>
        <a href="/sponsors.html" style="border:1px solid #cfd4dd;color:var(--navy);font-weight:700;font-size:0.92rem;padding:0.75rem 1.4rem;border-radius:8px">Sponsors</a>
        <a href="/current-offerings.html" style="border:1px solid #cfd4dd;color:var(--navy);font-weight:700;font-size:0.92rem;padding:0.75rem 1.4rem;border-radius:8px">Current Offerings</a>
      </div>
      <p style="font-size:0.88rem;color:var(--muted)">Still stuck? Email <a href="mailto:invest@baker1031.com">invest@baker1031.com</a> or call <a href="tel:+14155791660">(415) 579-1660</a>.</p>
    </div>`;
  const html = shell({ title: "Page not found &mdash; Baker 1031 Investments", desc: "The page you&rsquo;re looking for isn&rsquo;t here. Explore the Baker 1031 research library, sponsor directory, and current offerings.", canonical: `${SITE}/404.html`, jsonld: "", main });
  writeFileSync(join(ROOT, "404.html"), html);
  n++;
}

console.log(`build-aux-pages: wrote ${n} pages (6 legal + process + 404).`);
