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

const ENTITIES = {
  "&ldquo;": "“", "&rdquo;": "”", "&lsquo;": "‘", "&rsquo;": "’",
  "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&nbsp;": " ",
  "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'",
  "&times;": "×", "&deg;": "°", "&frac12;": "½", "&frac14;": "¼", "&frac34;": "¾",
  "&reg;": "®", "&trade;": "™", "&copy;": "©", "&sect;": "§", "&bull;": "•",
  "&rsaquo;": "›", "&lsaquo;": "‹", "&rarr;": "→", "&larr;": "←", "&asymp;": "≈",
  "&le;": "≤", "&ge;": "≥", "&plusmn;": "±", "&minus;": "−",
};
function decodeEntities(s) {
  s = s || "";
  // Some source text is double-encoded ("&amp;ldquo;"), so iterate until stable.
  for (let k = 0; k < 4; k++) {
    const before = s;
    s = s
      .replace(/&(?:ldquo|rdquo|lsquo|rsquo|mdash|ndash|hellip|nbsp|lt|gt|quot|apos|#39|times|deg|frac12|frac14|frac34|reg|trade|copy|sect|bull|rsaquo|lsaquo|rarr|larr|asymp|le|ge|plusmn|minus);/g, (m) => ENTITIES[m] || m)
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, "&");
    if (s === before) break;
  }
  return s;
}
// Tidy flattened-link remnants: a space left before punctuation where an inline
// link's trailing whitespace was ("the DST guide ." → "the DST guide."), and a
// space after an opening paren.
function tidy(s) {
  return decodeEntities(s || "")
    .replace(/[ \t]+([.,;:!?)\]])/g, "$1")
    .replace(/([(\[])[ \t]+/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const cleanHeading = (l) => decodeEntities(l).replace(/^\d+\s*[·.:]\s*/, ""); // strip "01 · " numbering

const isHeading = (line, next) => {
  if (!line) return false;
  const words = line.split(/\s+/).length;
  if (line.length > 92 || words > 13) return false;
  if (/[.,:;]$/.test(line)) return false;
  if (/[—–-]$/.test(line)) return false; // widget result row ("Gain deferred —"), not a heading
  if (!/^[A-Z0-9"“']/.test(line)) return false;
  if (/@|https?:|\d{3}[.\-]\d{3,4}/.test(line)) return false; // contact-info line, not a heading
  if (!next || next.length < 90) return false;
  return true;
};

const isQuestion = (line) => /\?$/.test(line) && line.length < 170 && /^[A-Z0-9"“']/.test(line);

// Editorial section pattern on strategy/detail pages: a short "eyebrow" label
// (e.g. "Our Standard", "The Total Load") sits above a short "deck" headline
// (e.g. "We underwrite the building before the offering.") which precedes the
// body. Collapse those: drop the eyebrow, promote the deck to the section heading.
const isLong = (l) => !!l && l.length > 90;
const isLabelish = (l) => !!l && l.length <= 55 && l.split(/\s+/).length <= 6 && /^[A-Z0-9"“']/.test(l) && !/[.?!:;]$/.test(l) && !/@|https?:/.test(l);
const isDeckish = (l) => !!l && l.length <= 95 && l.split(/\s+/).length <= 15 && /^[A-Z0-9"“']/.test(l);

const stripNum = (l) => l.replace(/^\d{1,2}\s*[·.:]\s*/, ""); // "12 · Glossary" → "Glossary"
const isStop = (raw) => {
  const l = stripNum(raw);
  return (
  /^Glossary$/i.test(l) ||
  /^Sources?(\s*(&|and)\s*References)?$/i.test(l) ||
  /^References$/i.test(l) ||
  /^Important disclosures$/i.test(l) ||
  /^Disclosures?$/i.test(l) ||
  /^Filed under\b/i.test(l) ||
  /^Executive summary audio$/i.test(l) ||
  /^Your browser does not support/i.test(l) ||
  /^Explore the Baker 1031 research library$/i.test(l) ||
  /^Related(\s|$)/i.test(l)
  );
};

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
  // Prefer cutting through the "Back to …" line; if there is none, consume the
  // run of short TOC entries (no terminal sentence punctuation) that follows.
  const tocIdx = lines.findIndex((l) => /^On This Page$/i.test(l));
  if (tocIdx >= 0) {
    const backIdx = lines.findIndex((l, i) => i > tocIdx && /^Back to /i.test(l));
    let end;
    if (backIdx >= 0) {
      end = backIdx;
    } else {
      end = tocIdx;
      for (let j = tocIdx + 1; j < lines.length; j++) {
        const lj = lines[j];
        if (lj.length <= 60 && !/[.?!]$/.test(lj) && !lj.includes("❯")) end = j;
        else break;
      }
    }
    lines = lines.slice(0, tocIdx).concat(lines.slice(end + 1));
  }

  // Strategy overview pages flatten each section onto a single line as
  // "<Label> <body…>" (e.g. "Overview A Real Estate Investment Trust…").
  // Split the known leading label off so it becomes a proper heading.
  if (category === "strategy") {
    const SLABELS = ["Considerations & risks", "What to weigh before investing", "By the numbers", "How it works", "Who it's for", "Considerations", "Comparison", "Overview", "Benefits", "Compare", "Risks", "What to weigh"];
    const out = [];
    for (const l of lines) {
      let split = null;
      for (const lab of SLABELS) {
        if (l.length > lab.length + 1 && l.slice(0, lab.length).toLowerCase() === lab.toLowerCase() && l[lab.length] === " " && /[A-Z0-9]/.test(l[lab.length + 1])) {
          split = [l.slice(0, lab.length), l.slice(lab.length + 1)];
          break;
        }
      }
      if (split) out.push(split[0], split[1]);
      else out.push(l);
    }
    lines = out;
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
  let forceHeading = false; // set when the previous line was an eyebrow → this line is the deck/heading

  for (let i = startIdx; i < stopIdx; i++) {
    let l = lines[i];
    if (/^Back to /i.test(l) || l === title || /^On This Page$/i.test(l)) continue;

    // Flattened interactive widget (calculator/quiz): a short "Interactive <title>"
    // line followed by input labels, values, options and "—" result rows. Skip the
    // whole block up to the next real section (numbered/normal heading, KT, or FAQ).
    if (/^Interactive\b/i.test(l) && l.length < 70) {
      let j = i + 1;
      while (j < stopIdx) {
        const lj = lines[j];
        if (/^\d{1,2}\s*[·.:]\s/.test(lj)) break;
        if (/^(Key Takeaways|Frequently Asked Questions)$/i.test(lj)) break;
        if (/^Back to /i.test(lj)) break;
        if (isHeading(lj, lines[j + 1])) break;
        j++;
      }
      i = j - 1;
      continue;
    }

    if (/^Key Takeaways$/i.test(stripNum(l))) { mode = "kt"; continue; }
    if (/^Frequently Asked Questions$/i.test(stripNum(l))) { mode = "faq"; q = null; continue; }

    if (mode === "faq") {
      // guides flatten FAQ as "Question? Answer." on one line; split it
      const inline = category === "guide" && l.match(/^(.{5,160}?\?)\s+(\S.*)$/);
      if (inline) { faq.push({ q: decodeEntities(inline[1].trim()), a: [inline[2].trim()] }); q = null; }
      else if (isQuestion(l)) { q = { q: decodeEntities(l), a: [] }; faq.push(q); }
      else if (q) q.a.push(l);
      continue;
    }

    // eyebrow + deck + body: drop the eyebrow, treat the deck as a heading.
    // The deck's body is either a long paragraph, or (when the deck ends in a
    // sentence and a sub-heading follows) another short label line. The sentence
    // check keeps stat-tile runs (short lines, no terminal period) intact.
    if (
      !forceHeading &&
      (mode === "lead" || mode === "body") &&
      isLabelish(l) &&
      isDeckish(lines[i + 1]) &&
      (isLong(lines[i + 2]) || (isLabelish(lines[i + 2]) && /[.!]$/.test(lines[i + 1])))
    ) {
      forceHeading = true;
      continue;
    }

    let heading = isHeading(l, lines[i + 1]);
    if (forceHeading) { heading = true; l = l.replace(/[.]$/, ""); forceHeading = false; }
    // flattened comparison-table header rows ("Feature … | Rule …") aren't real headings
    if (heading && /^(Feature|Rule)\s/.test(l)) heading = false;
    // a numbered section label that didn't resolve to a heading shouldn't show its raw "NN · " prefix
    if (!heading) l = stripNum(l);

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

  // Group runs of bullet ("❯ …") / numbered ("01 …") lines into real lists,
  // and tidy entity + link-spacing remnants across all text.
  const cleanParas = (arr) => groupLists(arr.map(tidy), category).map((x) => (typeof x === "string" ? x : { t: x.t, items: x.items.map(tidy) }));
  const leadClean = cleanParas(lead);
  const takeClean = takeaways.map(tidy);
  const sectionsClean = sections
    .filter((s) => s.heading || s.paras.length)
    .map((s) => ({ heading: tidy(s.heading), paras: cleanParas(s.paras) }));
  const faqClean = faq.map((f) => ({ q: tidy(f.q), a: f.a.map(tidy) }));

  const firstText = leadClean.find((x) => typeof x === "string") || sectionsClean[0]?.paras.find((x) => typeof x === "string") || title;
  const metaDesc = firstText.replace(/\s+/g, " ").slice(0, 155).trim();

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
      lead: leadClean,
      takeaways: takeClean,
      sections: sectionsClean,
      faq: faqClean,
      metaDesc,
    },
  };
}

// Group consecutive bullet/numbered lines into list objects {t:'ul'|'ol', items:[…]}.
// Only a run of 2+ becomes a list; a lone match falls back to a paragraph (bullets
// lose the "❯" marker, numbered lines keep their number in case it's real data).
function groupLists(paras, category) {
  // On the firm/detail pages, unmarked definition lists ("Selling Commissions
  // Paid by…", "Sources. Performance is…") should also become bullets.
  const isDefItem = (l) =>
    category === "detail" &&
    l.length <= 300 &&
    (/^[A-Z][\w'’&/-]*(?:\s+[\w'’&/-]+){0,3}\.\s+[A-Z]/.test(l) || // "Sources. Performance…"
      /^(?:[A-Z][A-Za-z'’/-]+|&)(?:\s+(?:[A-Z][A-Za-z'’/-]+|&)){1,5}\s+\S/.test(l)); // "Sponsor Spreading…", "Selling Commissions Paid…"

  const out = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    if (run.items.length >= 2) out.push({ t: run.t, items: run.items.map((i) => i.text) });
    else out.push(...run.items.map((i) => (run.t === "ul" ? i.text : i.orig)));
    run = null;
  };
  for (const p of paras) {
    if (typeof p !== "string") { flush(); out.push(p); continue; }
    const bullet = /^[❯•‣▸›]\s+(.+)$/.exec(p);
    const numbered = /^0?\d{1,2}\s+([A-Z].+)$/.exec(p);
    if (bullet) {
      if (!run || run.t !== "ul") { flush(); run = { t: "ul", items: [] }; }
      run.items.push({ text: bullet[1].trim(), orig: p });
    } else if (numbered) {
      if (!run || run.t !== "ol") { flush(); run = { t: "ol", items: [] }; }
      run.items.push({ text: numbered[1].trim(), orig: p });
    } else if (isDefItem(p)) {
      if (!run || run.t !== "dl") { flush(); run = { t: "dl", items: [] }; }
      run.items.push({ text: p.trim(), orig: p });
    } else {
      flush();
      out.push(p);
    }
  }
  flush();
  return out;
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
