/* Image URL helpers. */

/* ---- Brand logo -------------------------------------------------------
   The Cloudinary source is 4029x755 / 217 KB. Served untransformed it was
   downloading ~218 KB on every page (384 inlinks in the Jul-2026 crawl).
   Always request it through BRAND_LOGO so f_auto,q_auto,w_400,c_limit is
   applied — delivered at 400x75, a few KB. Keep LOGO_W/LOGO_H in sync with
   the w_ value so pages can emit correct width/height attributes (CLS). */
const LOGO_ID = "v1783843015/76c3b97b-a853-46f1-bf6f-19285b0754f8_l5pbup.png";
export const LOGO_W = 400;
export const LOGO_H = 75; // 755 * 400 / 4029, rounded
export const BRAND_LOGO =
  `https://res.cloudinary.com/opoazlei/image/upload/f_auto,q_auto,w_${LOGO_W},c_limit/${LOGO_ID}`;

/* logo.clearbit.com was retired — its DNS no longer resolves, so any sheet
   row still carrying a Clearbit URL renders a broken image. Map it onto the
   logo.dev pattern every other sponsor already uses. (The token is a public
   publishable key; it is already visible in the delivered HTML.) */
const LOGODEV_TOKEN = "pk_FIVsDKgZTvCedVXXtt2rEg";
export function normalizeLogo(url) {
  const m = String(url || "").match(/^https?:\/\/logo\.clearbit\.com\/([^/?#]+)/i);
  return m ? `https://img.logo.dev/${m[1]}?token=${LOGODEV_TOKEN}&size=200&retina=true` : url;
}

/* Proxy remote photos (Google Drive/lh3) through Cloudinary fetch for
   format/quality/size optimization — 1.2MB Drive originals become ~30KB. */
export function optimizedPhoto(url, width) {
  if (!url || !/^https?:\/\//.test(url)) return url;
  if (url.includes("res.cloudinary.com")) return url; // already optimized
  return `https://res.cloudinary.com/opoazlei/image/fetch/f_auto,q_auto,w_${width}/${encodeURIComponent(url)}`;
}

/* Google Drive file links → direct-download links. */
export function directDownload(url) {
  const m = String(url || "").match(/drive\.google\.com\/file\/d\/([\w-]+)/) ||
            String(url || "").match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
}
