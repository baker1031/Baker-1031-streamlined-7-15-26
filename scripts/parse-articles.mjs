// Parse legacy Insights articles (flattened .md) into structured data/learn-articles.json
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, "legacy-content/index.json"), "utf8"));
const manifest = idx.manifest.filter((p) => p.category === "article");

// Map the byline category tag -> one of the 6 Learn pillars
const PILLARS = {
  "1031-basics": "1031 Basics",
  "dst-essentials": "DST Essentials",
  "721-reits": "721 & REITs",
  "opportunity-zones": "Opportunity Zones",
  "mineral-royalties": "Mineral & Royalties",
  "taxes-planning": "Taxes & Planning",
};
function tagToPillar(tag) {
  const t = (tag || "").toLowerCase();
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

const isHeading = (line, next) => {
  if (!line) return false;
  const words = line.split(/\s+/).length;
  if (line.length > 92 || words > 13) return false;
  if (/[.,:;]$/.test(line)) return false;
  if (!/^[A-Z0-9"“']/.test(line)) return false;
  // A heading is followed by a paragraph (long line), not another short line/heading
  if (!next || next.length < 90) return false;
  return true;
};

const isQuestion = (line) => /\?$/.test(line) && line.length < 170 && /^[A-Z0-9"“']/.test(line);

// Trailing boilerplate: once we hit one of these, the real article content is over.
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

const results = [];
const skipped = [];

for (const p of manifest) {
  const raw = fs.readFileSync(path.join(ROOT, "legacy-content", p.file), "utf8");
  const body = raw.replace(/^---[\s\S]*?---\n/, "").trim();
  const lines = body.split("\n").map((s) => s.trim()).filter(Boolean);
  const crumb = lines.find((l) => l.includes("❯")) || "";
  if (!/Insights/i.test(crumb)) {
    skipped.push(p.slug);
    continue;
  }

  const title = decodeEntities(p.title).replace(/\s*\|\s*Baker 1031.*$/i, "").trim();

  // byline
  const byIdx = lines.findIndex((l) => /min read/i.test(l));
  let tag = "1031 Exchange",
    updated = "June 2026",
    readMin = Math.max(3, Math.round(p.words / 225));
  if (byIdx >= 0) {
    const by = lines[byIdx];
    const mUpd = by.match(/Updated\s+([A-Za-z]+\s+\d{4})/);
    if (mUpd) updated = mUpd[1];
    const mRead = by.match(/(\d+)\s*min read/);
    if (mRead) readMin = +mRead[1];
    tag = by
      .split(/Gerald|Jerry\s+Baker|·/)[0]
      .replace(/\bBy\b\s*$/i, "")
      .replace(/Baker 1031 Investments/i, "")
      .trim();
    if (!tag) tag = "1031 Exchange";
  }
  const pillar = tagToPillar(tag);

  // Content region: from byline+1 up to the first trailing-boilerplate marker.
  const startIdx = byIdx >= 0 ? byIdx + 1 : (crumb ? lines.indexOf(crumb) + 1 : 0);
  let stopIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    if (isStop(lines[i])) { stopIdx = i; break; }
  }

  const lead = [];
  const takeaways = [];
  const sections = [];
  const faq = [];
  let mode = "lead"; // lead -> body -> kt -> faq
  let cur = null;
  let q = null;

  for (let i = startIdx; i < stopIdx; i++) {
    const l = lines[i];
    if (/^Back to /i.test(l) || l === title) continue;

    if (/^Key Takeaways$/i.test(l)) { mode = "kt"; continue; }
    if (/^Frequently Asked Questions$/i.test(l)) { mode = "faq"; q = null; continue; }

    if (mode === "faq") {
      if (isQuestion(l)) { q = { q: decodeEntities(l), a: [] }; faq.push(q); }
      else if (q) q.a.push(l);
      continue;
    }

    const heading = isHeading(l, lines[i + 1]);

    if (mode === "kt") {
      if (heading) { mode = "body"; cur = { heading: decodeEntities(l), paras: [] }; sections.push(cur); }
      else takeaways.push(l);
      continue;
    }

    if (mode === "lead") {
      if (heading) { mode = "body"; cur = { heading: decodeEntities(l), paras: [] }; sections.push(cur); }
      else lead.push(l);
      continue;
    }

    // mode === "body"
    if (heading) { cur = { heading: decodeEntities(l), paras: [] }; sections.push(cur); }
    else {
      if (!cur) { cur = { heading: "", paras: [] }; sections.push(cur); }
      cur.paras.push(l);
    }
  }

  const metaDesc = (lead[0] || sections[0]?.paras[0] || title)
    .replace(/\s+/g, " ")
    .slice(0, 155)
    .trim();

  results.push({
    slug: p.slug,
    title,
    kicker: decodeEntities(tag),
    pillar,
    pillarName: PILLARS[pillar],
    updated,
    readMin,
    words: p.words,
    lead,
    takeaways,
    sections: sections.filter((s) => s.heading || s.paras.length),
    faq,
    metaDesc,
  });
}

results.sort((a, b) => a.title.localeCompare(b.title));
fs.writeFileSync(path.join(ROOT, "data/learn-articles.json"), JSON.stringify(results, null, 2));

// Report
const byPillar = {};
let noHead = 0,
  thinLead = 0;
for (const r of results) {
  byPillar[r.pillar] = (byPillar[r.pillar] || 0) + 1;
  if (r.sections.filter((s) => s.heading).length === 0) noHead++;
  if (r.lead.length === 0) thinLead++;
}
console.log("parsed:", results.length, "skipped(non-Insights):", skipped.length);
console.log("by pillar:", byPillar);
console.log("articles with NO detected section headings:", noHead);
console.log("articles with empty lead:", thinLead);
