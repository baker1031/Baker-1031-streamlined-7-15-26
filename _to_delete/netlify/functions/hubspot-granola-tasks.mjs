/* ============================================================
   Granola → HubSpot TASKS.

   Granola's native HubSpot integration already syncs the meeting note (as a
   Note or Meeting) onto the matched Contact/Deal — but it does NOT turn
   action items into HubSpot tasks. This scheduled poller fills that gap and
   ONLY creates tasks: it pulls new Granola notes via the official API,
   extracts the action items, finds the matching HubSpot contact (by attendee
   email) + their open deal, and opens one HubSpot task per item (due +N days).
   De-duped via Netlify Blobs so a task is never created twice.

   Env: GRANOLA_API_KEY (grn_… — set in Netlify, NOT in code)
        HUBSPOT_TOKEN
        GRANOLA_OWNER_EMAIL      (your address, skipped as an attendee)
        GRANOLA_BACKFILL_HOURS   (first-run window, default 48)
        GRANOLA_TASK_DUE_DAYS    (default 3)
        GRANOLA_SKIP_UNKNOWN=1   (don't create a contact if none matches)
        GRANOLA_MAX_NOTES        (safety cap per run, default 40)
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { extractActionItems, parseAttendees } from "./lib/granola.mjs";
import { findContactByEmail, upsertContact, findOpenDealForContact, createTask } from "./lib/hubspot.mjs";

const API = "https://public-api.granola.ai/v1";
const lower = (s) => String(s || "").trim().toLowerCase();

async function granola(path, key) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); return granola(path, key); }
  if (!res.ok) { console.error(`Granola ${path} -> ${res.status}`); return null; }
  return res.json();
}

export default async () => {
  const key = process.env.GRANOLA_API_KEY;
  if (!key || !process.env.HUBSPOT_TOKEN) { console.log("hs-granola-tasks: not configured"); return; }

  const store = getStore("hubspot-granola-tasks");
  const backfillH = Number(process.env.GRANOLA_BACKFILL_HOURS || 48) || 48;
  const lastSync = (await store.get("lastSync").catch(() => null)) ||
    new Date(Date.now() - backfillH * 3600000).toISOString();

  const maxNotes = Number(process.env.GRANOLA_MAX_NOTES || 40) || 40;
  const collected = [];
  let cursor = null, pages = 0;
  do {
    const qs = `created_after=${encodeURIComponent(lastSync)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await granola(`/notes?${qs}`, key);
    if (!page || !Array.isArray(page.notes)) break;
    collected.push(...page.notes);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor && ++pages < 10 && collected.length < maxNotes);

  if (!collected.length) { console.log("hs-granola-tasks: no new notes"); return; }
  collected.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const batch = collected.slice(0, maxNotes);

  const ownerEmail = lower(process.env.GRANOLA_OWNER_EMAIL);
  const skipUnknown = process.env.GRANOLA_SKIP_UNKNOWN === "1";
  const dueDays = Number(process.env.GRANOLA_TASK_DUE_DAYS || 3) || 3;
  const dueTs = new Date(Date.now() + dueDays * 86400000).toISOString();

  let newest = lastSync, made = 0;
  for (const stub of batch) {
    const detail = await granola(`/notes/${stub.id}`, key);
    if (!detail) continue;
    if (detail.created_at && new Date(detail.created_at) > new Date(newest)) newest = detail.created_at;

    const summaryMd = detail.summary_markdown || detail.summary_text || "";
    const items = extractActionItems(summaryMd);
    if (!items.length) continue;

    const creatorEmail = lower(detail.owner && detail.owner.email);
    const attendees = parseAttendees(detail.attendees || [])
      .filter((a) => a.email && a.email !== ownerEmail && a.email !== creatorEmail);

    for (const a of attendees) {
      let contact = await findContactByEmail(a.email);
      let contactId = contact ? contact.id : null;
      if (!contactId && !skipUnknown) {
        const [firstname, ...rest] = String(a.name || "").trim().split(/\s+/);
        contactId = await upsertContact(a.email, clean({ firstname, lastname: rest.join(" ") }));
      }
      if (!contactId) continue;

      const deal = await findOpenDealForContact(contactId);
      const body = `Follow-up from Granola meeting “${detail.title || "Meeting"}”` +
        (detail.web_url ? ` — ${detail.web_url}` : "");
      for (const item of items) {
        const dedupeKey = `t:${detail.id}:${contactId}:${item.slice(0, 60)}`;
        if (await store.get(dedupeKey).catch(() => null)) continue;
        const taskId = await createTask({
          subject: item.slice(0, 240), body, dueTimestamp: dueTs,
          contactId, dealId: deal ? deal.id : undefined
        });
        if (taskId) { await store.set(dedupeKey, "1").catch(() => {}); made++; }
      }
    }
  }

  await store.set("lastSync", newest).catch(() => {});
  console.log(`hs-granola-tasks: created ${made} task(s); lastSync=${newest}`);
};

function clean(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined && obj[k] !== "" && obj[k] !== null) out[k] = obj[k];
  return out;
}

/* Run every 15 minutes (matches the Pipedrive Granola poller cadence). */
export const config = { schedule: "*/15 * * * *" };
