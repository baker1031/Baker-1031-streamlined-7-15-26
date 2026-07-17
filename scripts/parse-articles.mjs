// Parse legacy Learn content (Insights articles + strategy + guide + detail pages)
// from the flattened .md corpus into structured data/learn-articles.json.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, "legacy-content/index.json"), "utf8"));
const manifest = idx.manifest;

const PILLARS = {
  "1031-basics": "1031 Basics",
  "dst-essentials": "DST Essentials",
  "721-reits": "721 & REITs",
  "opportunity-zones": "Opportunity Zones",
  "mineral-royalties": "Mineral & Royalties",
  "taxes-planning": "Taxes & Planning",
  firm: "Firm, Fees & Methodology",
};
function textToPillar(t) {
  t = (t || "").toLowerCase();
  if (/oppo?rtunity zone|qof|\boz\b/.test(t)) return "opportunity-zones";
  if (/mineral|royalt|oil\s*&?\s*gas/.test(t)) return "mineral-royalties";
  if (/reit|721|upreit/.test(t)) return "721-reits";
  if (/delaware statutory|\bdst/.test(t)) return "dst-essentials";
  if (/capital gain|tax defer|net investment income|niit|tax form|estate|depreciation|installment|boot|withhold|state tax/.test(t))
    return "taxes-planning";
  return "1031-basics";
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&nbsp;/g, " ");
}

const cleanHeading = (l) => decodeEntities(l).replace(/^\d+\s*[·.:]\s*/, ""); // strip "01 · " numbering

const isHeading = (line, next) => {
  if (!line) return false;
  const words = line.split(/\s+/).length;
  if (line.length > 92 || words > 13) return false;
  if (/[.,:;]$/.test(line)) return false;
  if (!/^[A-Z0-9"“']/.test(line)) return false;
  if (/@|https?:|\d{3}[.\-]\d{3,4}/.test(line)) return false; // contact-info line, not a heading
  if (!next || next.length < 90) return false;
  return true;
};

const isQuestion = (line) => /\?$/.test(line) && line.length < 170 && /^[A-Z0-9"“']/.test(line);

const isStop = (l) =>
  /^Glossary$/i.test(l) ||
  /^Sources?(\s*(&|and)\s*References)?$/i.test(l) ||
  /^References$/i.test(l) ||
  /^Important disclosures$/i.test(l) ||
  /^Disclosures?$/i.test(l) ||
  /^Filed under\b/i.test(l) ||
  /^Executive summary audio$/i.test(l) ||
  /^Your browser does not support/i.test(l) ||
  /^Explore the Baker 1031 research library$/i.test(l) ||
  /^Related(\s|$)/i.test(l);

// A byline line: has "min read", OR is a short line carrying "Updated <Month> <Year>".
const isByline = (l) => /min read/i.test(l) || (l.length < 150 && /Updated\s+[A-Za-z]+\.?\s+\d{4}/.test(l));

// ---- per-category configuration ----
const DETAIL = {
  methodology: { kicker: "Methodology", pillar: "firm" },
  "our-approach": { kicker: "Our approach", pillar: "firm" },
  "due-diligence": { kicker: "Due diligence", pillar: "firm" },
  fees: { kicker: "Fees", pillar: "firm" },
  about: { kicker: "About Baker 1031", pillar: "firm" },
  "jerry-baker-bio": { kicker: "About Baker 1031", pillar: "firm" },
  "team-partners": { kicker: "About Baker 1031", pillar: "firm" },
  "for-advisors-cpas": { kicker: "For advisors & CPAs", pillar: "firm" },
  "for-agents-brokers": { kicker: "For agents & brokers", pillar: "firm" },
  "tax-center": { kicker: "Tax resource", pillar: "taxes-planning" },
};
// Skipped: indexes/dashboards/functional pages, plus the master FAQ page (inline
// "Question? Answer." format that doesn't parse, and redundant with the dedicated
// 1031-exchange FAQ article + every article's own FAQ section).
const DETAIL_SKIP = new Set(["insights", "guides", "1031-exchange", "data-center", "contact", "faq"]);

function parseOne(p, category) {
  const raw = fs.readFileSync(path.join(ROOT, "legacy-content", p.file), "utf8");
  const body = raw.replace(/^---[\s\S]*?---\n/, "").trim();
  let lines = body.split("\n").map((s) => s.trim()).filter(Boolean);
  const crumb = lines.find((l) => l.includes("❯")) || "";

  if (category === "article" && !/Insights/i.test(crumb)) return { skip: "non-insights" };
  if (category === "detail" && DETAIL_SKIP.has(p.slug)) return { skip: "index/functional" };

  const title = decodeEntities(p.title).replace(/\s*\|\s*Baker 1031.*$/i, "").trim();

  // Strip an "On This Page" table-of-contents block (strategy/detail pages).
  const tocIdx = lines.findIndex((l) => /^On This Page$/i.test(l));
  if (tocIdx >= 0) {
    let end = lines.findIndex((l, i) => i > tocIdx && /^Back to /i.test(l));
    if (end < 0) end = tocIdx + 1;
    lines = lines.slice(0, tocIdx).concat(lines.slice(end + 1));
  }

  // byline
  const byIdx = lines.findIndex(isByline);
  let tag = null,
    updated = "June 2026",
    readMin = Math.max(3, Math.round(p.words / 225));
  if (byIdx >= 0) {
    const by = lines[byIdx];
    const mUpd = by.match(/Updated\s+([A-Za-z]+\.?\s+\d{4})/);
    if (mUpd) updated = mUpd[1];
    const mRead = by.match(/(\d+)\s*min read/);
    if (mRead) readMin = +mRead[1];
    tag = by.split(/Gerald|Jerry\s+Baker|·/)[0].replace(/\bBy\b\s*$/i, "").replace(/Baker 1031 Investments/i, "").trim();
  }

  // kicker + pillar by category
  let kicker, pillar;
  if (category === "article") {
    kicker = decodeEntities(tag || "1031 Exchange");
    pillar = textToPillar(tag || title);
  } else if (category === "strategy") {
    kicker = "Strategy";
    pillar = textToPillar(p.slug + " " + title);
  } else if (category === "guide") {
    kicker = "Guide";
    pillar = textToPillar(p.slug + " " + title);
  } else if (category === "detail") {
    const d = DETAIL[p.slug] || { kicker: "Baker 1031", pillar: "firm" };
    kicker = d.kicker;
    pillar = d.pillar;
  }

  const startIdx = byIdx >= 0 ? byIdx + 1 : (crumb ? lines.indexOf(crumb) + 1 : 0);
  let stopIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    if (isStop(lines[i])) { stopIdx = i; break; }
  }

  const lead = [];
  const takeaways = [];
  const sections = [];
  const faq = [];
  let mode = "lead";
  let cur = null;
  let q = null;

  for (let i = startIdx; i < stopIdx; i++) {
    const l = lines[i];
    if (/^Back to /i.test(l) || l === title || /^On This Page$/i.test(l)) continue;

    if (/^Key Takeaways$/i.test(l)) { mode = "kt"; continue; }
    if (/^Frequently Asked Questions$/i.test(l)) { mode = "faq"; q = null; continue; }

    if (mode === "faq") {
      if (isQuestion(l)) { q = { q: decodeEntities(l), a: [] }; faq.push(q); }
      else if (q) q.a.push(l);
      continue;
    }

    const heading = isHeading(l, lines[i + 1]);

    if (mode === "kt") {
      if (heading) { mode = "body"; cur = { heading: cleanHeading(l), paras: [] }; sections.push(cur); }
      else takeaways.push(l);
      continue;
    }
    if (mode === "lead") {
      if (heading) { mode = "body"; cur = { heading: cleanHeading(l), paras: [] }; sections.push(cur); }
      else lead.push(l);
      continue;
    }
    if (heading) { cur = { heading: cleanHeading(l), paras: [] }; sections.push(cur); }
    else {
      if (!cur) { cur = { heading: "", paras: [] }; sections.push(cur); }
      cur.paras.push(l);
    }
  }

  const metaDesc = (lead[0] || sections[0]?.paras[0] || title).replace(/\s+/g, " ").slice(0, 155).trim();

  return {
    doc: {
      slug: p.slug,
      title,
      kicker,
      pillar,
      pillarName: PILLARS[pillar],
      category,
      updated,
      readMin,
      words: p.words,
      lead,
      takeaways,
      sections: sections.filter((s) => s.heading || s.paras.length),
      faq,
      metaDesc,
    },
  };
}

const results = [];
const seen = new Set();
const report = {};
const skipped = [];
for (const category of ["article", "strategy", "guide", "detail"]) {
  for (const p of manifest.filter((m) => m.category === category)) {
    const r = parseOne(p, category);
    if (r.skip) { skipped.push(`${category}/${p.slug} (${r.skip})`); continue; }
    if (seen.has(r.doc.slug)) { skipped.push(`${category}/${p.slug} (slug collision)`); continue; }
    seen.add(r.doc.slug);
    results.push(r.doc);
    report[category] = (report[category] || 0) + 1;
  }
}

results.sort((a, b) => a.title.localeCompare(b.title));
fs.writeFileSync(path.join(ROOT, "data/learn-articles.json"), JSON.stringify(results, null, 2));

const byPillar = {};
let noHead = 0, thinLead = 0;
for (const r of results) {
  byPillar[r.pillar] = (byPillar[r.pillar] || 0) + 1;
  if (r.sections.filter((s) => s.heading).length === 0) noHead++;
  if (r.lead.length === 0) thinLead++;
}
console.log("parsed:", results.length, "by category:", report);
console.log("by pillar:", byPillar);
console.log("no section headings:", noHead, "| empty lead:", thinLead);
console.log("skipped:", skipped.length);
skipped.forEach((s) => console.log("   -", s));
