/* Image URL helpers. */

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
