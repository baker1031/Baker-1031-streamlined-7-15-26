/* Shared Pipedrive REST helpers (token in x-api-token header, never the URL). */

const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";

/* pd("/persons/1", token) — GET v1
   pd("/persons/search?term=x", token, { v: 2 }) — GET v2
   pd("/activities", token, { method: "POST", body: {...} }) */
export async function pd(path, token, { method = "GET", body, v = 1 } = {}) {
  const res = await fetch(`${v === 2 ? V2 : V1}${path}`, {
    method,
    headers: {
      "x-api-token": token,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    console.error(`Pipedrive ${method} ${path} -> ${res.status}`, JSON.stringify(data).slice(0, 300));
  }
  return data;
}

export async function findPersonByEmail(token, email) {
  const res = await pd(
    `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true`,
    token, { v: 2 }
  );
  const item = res && res.data && res.data.items && res.data.items[0];
  return item ? item.item : null;
}

/* Find a person by phone number. Searches Pipedrive's phone field on the
   national (last-10-digit) number so stored formats like "(575) 556-8500",
   "+1 575 556 8500", or "5755568500" all match, then verifies the last 10
   digits actually line up before returning (avoids false positives). */
export async function findPersonByPhone(token, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const nat = digits.length > 10 ? digits.slice(-10) : digits; // drop country code
  if (nat.length < 10) return null;
  const res = await pd(`/persons/search?term=${encodeURIComponent(nat)}&fields=phone`, token, { v: 2 });
  const items = (res && res.data && res.data.items) || [];
  const verified = items.find((it) => {
    const p = (it && it.item) || {};
    const phones = [].concat(p.phones || [], p.phone || []).map((x) => String(x).replace(/\D/g, ""));
    return phones.some((d) => d.endsWith(nat));
  });
  if (verified) return verified.item;
  // No phones in the result payload to verify against, but Pipedrive matched
  // on the phone field — accept the single top hit only (ambiguous if several).
  return items.length === 1 ? items[0].item : null;
}

export async function findOpenDeal(token, personId) {
  const res = await pd(
    `/deals?person_id=${personId}&status=open&sort_by=add_time&sort_direction=desc&limit=1`,
    token, { v: 2 }
  );
  return (res && res.data && res.data[0]) || null;
}

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Attach a Note (HTML content) to a person and/or deal. */
export async function addNote(token, { content, personId, dealId }) {
  const body = { content };
  if (personId) body.person_id = personId;
  if (dealId) body.deal_id = dealId;
  return pd(`/notes`, token, { method: "POST", body });
}

/* Minimal, injection-safe Markdown → Pipedrive-note HTML: escape first,
   then re-introduce a small, known-safe subset (headings, bold, bullets,
   links, line breaks). Granola summaries arrive as Markdown. */
export function mdToNoteHtml(md) {
  let h = esc(String(md || "").trim());
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>");
  h = h.replace(/^\s*[-*]\s+(.+)$/gm, "&bull; $1");
  return h.replace(/\n/g, "<br>");
}
