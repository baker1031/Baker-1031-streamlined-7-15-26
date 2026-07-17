/* Refresh data/article-dates.json — the honest-dates ledger for Learn articles.
   Run locally after editing article content (data/learn-articles.json or
   data/article-sources.json), then commit the ledger with the content change:

     node scripts/update-article-dates.mjs

   Rules:
   - `published` is set once (first time a slug appears) and never changes.
   - `modified` bumps to today ONLY when the article's content hash actually
     changed — no blanket "freshness" date-bumping. Search engines treat
     mass-updated dates as auto-generated noise, so dates must track real edits.
   - The build (build-offerings.mjs) only READS this ledger; it never writes it,
     so nightly Netlify rebuilds cannot silently re-date the library. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arts = JSON.parse(readFileSync(join(ROOT, "data", "learn-articles.json"), "utf8"));
const srcPath = join(ROOT, "data", "article-sources.json");
const sources = existsSync(srcPath) ? JSON.parse(readFileSync(srcPath, "utf8")) : {};
const ledgerPath = join(ROOT, "data", "article-dates.json");
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {};

const today = new Date().toISOString().slice(0, 10);
let added = 0, bumped = 0;
for (const a of arts) {
  // hash covers the article body AND its attached sources (both render on-page)
  const payload = JSON.stringify(a, Object.keys(a).sort()) + JSON.stringify(sources[a.slug] || null);
  const hash = createHash("sha1").update(payload).digest("hex").slice(0, 16);
  const cur = ledger[a.slug];
  if (!cur) {
    ledger[a.slug] = { published: today, modified: today, hash };
    added++;
  } else if (cur.hash !== hash) {
    cur.modified = today;
    cur.hash = hash;
    bumped++;
  }
}
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 0));
console.log(`article-dates.json: ${added} added, ${bumped} modified-date bumps, ${arts.length} total.`);
