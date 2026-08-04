/* Image URL helpers.
   2026-07-29: Cloudinary retired. Assets are self-hosted under /assets/img
   (images, committed to the repo and served by Netlify) and https://assets.baker1031.com/video
   (hero video, Cloudflare R2 — zero egress cost). Derivatives are
   pre-generated, so no transformation string is applied at request time. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ASSET_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../..", "assets/img"
);

/* ---- Brand logo ------------------------------------------------------- */
export const LOGO_W = 400;
export const LOGO_H = 75; // 755 * 400 / 4029, rounded
export const BRAND_LOGO = "/assets/img/logo.webp";
/* Absolute PNG for JSON-LD / og:image, where WebP and relative URLs are
   not universally safe. */
export const BRAND_LOGO_ABS = "https://baker1031.com/assets/img/logo.png";

/* logo.clearbit.com was retired — its DNS no longer resolves, so any sheet
   row still carrying a Clearbit URL renders a broken image. Map it onto the
   logo.dev pattern every other sponsor already uses. */
const LOGODEV_TOKEN = "pk_FIVsDKgZTvCedVXXtt2rEg";
export function normalizeLogo(url) {
  const m = String(url || "").match(/^https?:\/\/logo\.clearbit\.com\/([^/?#]+)/i);
  return m ? `https://img.logo.dev/${m[1]}?token=${LOGODEV_TOKEN}&size=200&retina=true` : url;
}

/* Remote photos (Google Drive/lh3) and sponsor logos (logo.dev) are
   pre-fetched into the repo as WebP. Look the local file up by the same key
   the fetcher used; fall back to the remote URL when there is no local copy,
   so a brand-new sheet row still renders instead of 404-ing.

   To pre-fetch newly added sheet images, run: node scripts/fetch-remote-images.mjs */
const has = (p) => { try { return fs.statSync(path.join(ASSET_DIR, p)).isFile(); } catch { return false; } };

export function localKeyFor(url) {
  const u = String(url || "");
  const dev = u.match(/img\.logo\.dev\/([^?]+)/);
  if (dev) return `sponsors/${dev[1].replace(/\./g, "-")}.webp`;
  return `listings/${crypto.createHash("sha1").update(u).digest("hex").slice(0, 10)}.webp`;
}

export function optimizedPhoto(url /*, width */) {
  if (!url || !/^https?:\/\//.test(url)) return url;
  const key = localKeyFor(url);
  return has(key) ? `/assets/img/${key}` : url;
}

/* Google Drive file links → direct-download links. */
export function directDownload(url) {
  const m = String(url || "").match(/drive\.google\.com\/file\/d\/([\w-]+)/) ||
            String(url || "").match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
}
