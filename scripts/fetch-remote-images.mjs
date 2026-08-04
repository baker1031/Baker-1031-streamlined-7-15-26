#!/usr/bin/env node
/**
 * Pre-fetch remote sheet images (Google Drive photos + logo.dev sponsor logos)
 * into assets/img/ as WebP, so nothing is proxied through a third-party CDN
 * at request time.
 *
 * Run after adding rows to the Google Sheet:
 *   node scripts/fetch-remote-images.mjs
 *
 * Idempotent: files that already exist are skipped. Keys match localKeyFor()
 * in scripts/lib/images.mjs exactly.
 *
 * Requires: sharp  (npm i -D sharp)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { localKeyFor, normalizeLogo } from "./lib/images.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "img");
const WIDTHS = { sponsors: 260, listings: 640 };

let sharp;
try { ({ default: sharp } = await import("sharp")); }
catch { console.error("✗ sharp is not installed.  npm i -D sharp"); process.exit(1); }

// Pull the same image URLs the build uses, straight from the generated snapshot.
const snapshot = path.join(ROOT, "data", "offerings.json");
if (!fs.existsSync(snapshot)) {
  console.error("✗ data/offerings.json not found — run the offerings build first.");
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(snapshot, "utf8"));

const urls = new Set();
const collect = (v) => {
  if (typeof v === "string" && /^https?:\/\//.test(v) &&
      /(lh3\.googleusercontent|drive\.google|logo\.dev|clearbit)/.test(v)) {
    urls.add(normalizeLogo(v));
  } else if (Array.isArray(v)) v.forEach(collect);
  else if (v && typeof v === "object") Object.values(v).forEach(collect);
};
collect(rows);

console.log(`found ${urls.size} remote image urls`);
let fetched = 0, skipped = 0, failed = [];

for (const url of urls) {
  const key = localKeyFor(url);
  const dest = path.join(OUT, key);
  if (fs.existsSync(dest)) { skipped++; continue; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const width = WIDTHS[key.split("/")[0]] || 640;
    await sharp(buf).resize({ width, withoutEnlargement: true })
                    .webp({ quality: 82, effort: 6 }).toFile(dest);
    fetched++;
    console.log(`  + ${key}`);
  } catch (e) {
    failed.push([key, url, e.message]);
  }
}

console.log(`\nfetched ${fetched}, already present ${skipped}, failed ${failed.length}`);
for (const [k, u, m] of failed) console.log(`  ✗ ${k}  ${m}\n     ${u}`);
// Failures are non-fatal: images.mjs falls back to the remote URL for any key
// with no local file, so the page still renders.
