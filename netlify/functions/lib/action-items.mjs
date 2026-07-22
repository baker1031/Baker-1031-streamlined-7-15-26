// action-items.mjs
// Extract discrete action items from a Granola AI summary.
//
// Granola returns the summary as one Markdown blob (`summary_markdown`).
// Action items are NOT a structured field — they live inside that Markdown,
// usually under a heading like "Action Items", "Next Steps", "To-dos",
// "Follow-ups", or "Tasks". This module pulls those bullets out into a clean
// list so each one can become its own GoHighLevel task.

// Headings that introduce an action-item / task section.
const ACTION_HEADING_RE =
  /^\s*(?:#{1,6}\s*)?[*_]{0,2}\s*(action\s*items?|action\s*points?|next\s*steps?|to-?dos?|to\s*do|follow[-\s]?ups?|tasks?|deliverables?|assignments?)\s*[:*_]*\s*$/i;

// Any other Markdown heading (used to know where a section ends).
const ANY_HEADING_RE = /^\s*#{1,6}\s+\S/;
// A "bold line as heading" e.g. **Summary** or __Decisions__ on its own line.
const BOLD_HEADING_RE = /^\s*[*_]{2}[^*_].*[*_]{2}\s*:?\s*$/;
// A bullet / list item.
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
// Checkbox prefix inside a bullet, e.g. "[ ] " or "[x] ".
const CHECKBOX_RE = /^\[([ xX~-])\]\s*/;

// Strip surrounding/inline Markdown emphasis and links from a bullet's text,
// keeping it readable as a plain task title.
function cleanItemText(text) {
  let t = text.trim();
  // Markdown links [label](url) -> label
  t = t.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
  // Bold/italic markers
  t = t.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1");
  // Stray leading emphasis/backticks
  t = t.replace(/^[`*_\s]+/, "").replace(/[`*_\s]+$/, "");
  // Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Extract action items from a Granola summary.
 *
 * @param {string} markdown - the note's summary_markdown
 * @param {object} [opts]
 * @param {number} [opts.max=25] - cap on number of items returned
 * @param {boolean} [opts.includeCompleted=false] - include checked-off [x] items
 * @returns {{ title: string, done: boolean }[]}
 */
export function extractActionItems(markdown, opts = {}) {
  const max = opts.max ?? 25;
  const includeCompleted = opts.includeCompleted ?? false;
  if (!markdown || typeof markdown !== "string") return [];

  const lines = markdown.split(/\r?\n/);
  const items = [];
  let inSection = false;
  let sectionIndent = null;

  for (const line of lines) {
    if (!inSection) {
      if (ACTION_HEADING_RE.test(line)) {
        inSection = true;
        sectionIndent = null;
      }
      continue;
    }

    // We're inside an action-item section. Decide whether it has ended.
    const isBlank = line.trim() === "";
    const isHeading = ANY_HEADING_RE.test(line) || BOLD_HEADING_RE.test(line);
    const bulletMatch = line.match(BULLET_RE);

    // A new heading (that isn't itself an action heading) closes the section.
    if (isHeading && !ACTION_HEADING_RE.test(line)) {
      inSection = false;
      continue;
    }
    // If a *new* action heading appears, just stay in-section.
    if (ACTION_HEADING_RE.test(line)) continue;

    if (bulletMatch) {
      let raw = bulletMatch[1];

      // Handle checkbox items.
      let done = false;
      const cb = raw.match(CHECKBOX_RE);
      if (cb) {
        done = /[xX~-]/.test(cb[1]);
        raw = raw.replace(CHECKBOX_RE, "");
      }

      const title = cleanItemText(raw);
      if (title && (includeCompleted || !done)) {
        items.push({ title, done });
        if (items.length >= max) break;
      }
      continue;
    }

    // Non-bullet, non-blank prose after bullets -> treat as end of the list,
    // but tolerate a single blank line between bullets.
    if (!isBlank && items.length > 0) {
      inSection = false;
    }
  }

  // De-duplicate (case-insensitive) while preserving order.
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const key = it.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  return deduped;
}

export default extractActionItems;
