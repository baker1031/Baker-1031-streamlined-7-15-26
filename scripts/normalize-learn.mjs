/* One-time normalizer for the static Learn article pages.
   - Shortens the <title> brand suffix to " | Baker 1031" (SEO: title length).
   - Links the author byline to the bio page (E-E-A-T).
   Idempotent — safe to re-run. Usage: node scripts/normalize-learn.mjs [ROOT]
*/
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = process.argv[2] || ".";
const LEARN = join(ROOT, "learn");

const BYLINE_PLAIN = 'By Gerald F. &ldquo;Jerry&rdquo; Baker, III';
const BYLINE_LINK  = 'By <a href="/learn/jerry-baker-bio/" rel="author">Gerald F. &ldquo;Jerry&rdquo; Baker, III</a>';

let scanned = 0, titlesChanged = 0, bylinesLinked = 0, filesWritten = 0;

for (const d of readdirSync(LEARN, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const f = join(LEARN, d.name, "index.html");
  if (!existsSync(f)) continue;
  scanned++;
  const orig = readFileSync(f, "utf8");
  let h = orig;

  // 1) Title suffix -> " | Baker 1031" (only inside <title>, anchored on </title>)
  const before = h;
  h = h.replace(/\s*(?:&mdash;|—|\|)\s*Baker 1031(?:\s+Investments)?<\/title>/, " | Baker 1031</title>");
  if (h !== before) titlesChanged++;

  // 2) Link the byline to the bio (skip if already linked)
  if (h.includes(BYLINE_PLAIN)) { h = h.replace(BYLINE_PLAIN, BYLINE_LINK); bylinesLinked++; }

  if (h !== orig) { writeFileSync(f, h); filesWritten++; }
}

console.log(`normalize-learn: scanned ${scanned} articles — titles shortened: ${titlesChanged}, bylines linked: ${bylinesLinked}, files written: ${filesWritten}`);
