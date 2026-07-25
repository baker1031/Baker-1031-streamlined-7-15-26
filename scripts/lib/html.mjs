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

/* ---- SEO length helpers ------------------------------------------------
   Google truncates titles around 60 characters and meta descriptions around
   155. Both helpers degrade gracefully instead of hard-cutting mid-word. */

const BRAND = "Baker 1031";
export const TITLE_MAX = 60;

/* Append the brand suffix only when it fits inside TITLE_MAX. A long page
   title keeps its own words rather than losing them to the brand. */
export function brandTitle(core, max = TITLE_MAX) {
  core = String(core || "").replace(/\s+/g, " ").trim();
  const suffix = ` | ${BRAND}`;
  return core.length + suffix.length <= max ? core + suffix : core;
}

/* Trim a meta description to `max` at the cleanest available boundary:
   end of sentence, then a trailing ", and …" / " and …" clause, then a
   comma clause, and only as a last resort a word boundary with an ellipsis.
   Returns the original string untouched when it already fits. */
export function metaTrim(s, max = 155) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const floor = Math.floor(max * 0.7); // never cut back past ~70% of the budget

  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentence >= floor) return head.slice(0, sentence + 1).trim();

  for (const sep of [", and ", " and ", "; ", ", "]) {
    const i = head.lastIndexOf(sep);
    if (i >= floor) return head.slice(0, i).replace(/[,;:\s]+$/, "") + ".";
  }

  const cut = s.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\s]+$/, "") + "…";
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
