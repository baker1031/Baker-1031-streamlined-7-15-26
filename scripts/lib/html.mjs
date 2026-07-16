/* Shared HTML/string helpers for the build. */
export const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

export function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

export function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/* Replace the content between marker comments. Throws loudly when a
   marker is missing — a silent regex miss must fail the build. */
export function put(src, startMark, endMark, content, file = "") {
  const s = src.indexOf(startMark), e = src.indexOf(endMark);
  if (s === -1 || e === -1) throw new Error(`Missing ${startMark} / ${endMark} markers${file ? " in " + file : ""}`);
  return src.slice(0, s + startMark.length) + "\n" + content + "\n" + src.slice(e);
}
