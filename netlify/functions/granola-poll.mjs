/* ============================================================
   Granola → Pipedrive scheduled poller.

   Runs on a schedule (default every 15 min). Pulls new Granola notes via
   the official Granola API (https://public-api.granola.ai/v1) using your
   API key, then for each meeting:
     - finds the Pipedrive person by attendee email, or CREATES them
     - attaches the Granola summary as a Note on their open deal / person
     - logs a completed "meeting" Activity
     - opens a "task" Activity per action item / next step

   This is the API-key path (no Zapier). The webhook receiver
   (granola-sync.mjs) is an alternate path and shares the same sync logic.

   State (Netlify Blobs "granola-sync"): lastSync timestamp + per-(meeting,
   person) dedupe keys — so a note is never synced twice.

   Env: GRANOLA_API_KEY (grn_… — set in Netlify, NOT in code)
        PIPEDRIVE_API_TOKEN
        GRANOLA_OWNER_EMAIL (your address, skipped as an attendee)
        GRANOLA_BACKFILL_HOURS (first-run window, default 48)
        GRANOLA_TASK_DUE_DAYS (default 3)
        GRANOLA_SKIP_UNKNOWN=1 (don't auto-create missing people)
        GRANOLA_INCLUDE_TRANSCRIPT=1
        GRANOLA_MAX_NOTES (safety cap per run, default 40)
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { extractActionItems, parseAttendees, syncMeetingToPipedrive } from "./lib/granola.mjs";

const API = "https://public-api.granola.ai/v1";

async function granola(path, key) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); return granola(path, key); }
  if (!res.ok) { console.error(`Granola ${path} -> ${res.status}`); return null; }
  return res.json();
}

export default async () => {
  const key = process.env.GRANOLA_API_KEY;
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!key || !token) { console.log("granola-poll: not configured"); return; }

  const store = getStore("granola-sync");
  const backfillH = Number(process.env.GRANOLA_BACKFILL_HOURS || 48) || 48;
  const lastSync = (await store.get("lastSync").catch(() => null)) ||
    new Date(Date.now() - backfillH * 3600000).toISOString();

  // Page through notes created since lastSync (newest-first), oldest processed first.
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

  if (!collected.length) { console.log("granola-poll: no new notes"); return; }
  collected.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const batch = collected.slice(0, maxNotes);

  const ownerEmail = process.env.GRANOLA_OWNER_EMAIL;
  const createPersons = process.env.GRANOLA_SKIP_UNKNOWN !== "1";
  const includeTranscript = process.env.GRANOLA_INCLUDE_TRANSCRIPT === "1";
  const dueDays = Number(process.env.GRANOLA_TASK_DUE_DAYS || 3) || 3;
  const dueDate = new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10);

  let newest = lastSync, processed = 0, synced = 0;
  for (const stub of batch) {
    const detail = await granola(`/notes/${stub.id}${includeTranscript ? "?include=transcript" : ""}`, key);
    if (!detail) continue;
    const when = detail.created_at ? new Date(detail.created_at) : null;
    const dateStr = when && !isNaN(when) ? when.toISOString().slice(0, 10) : null;
    const attendees = parseAttendees(detail.attendees || []);
    const summaryMd = detail.summary_markdown || detail.summary_text || "";

    const results = await syncMeetingToPipedrive(token, {
      meetingId: detail.id,
      title: detail.title || "Meeting",
      summaryMd,
      transcript: includeTranscript ? textFromTranscript(detail.transcript) : "",
      shareUrl: detail.web_url || "",
      dateStr,
      attendees,
      ownerEmail,
      creatorEmail: detail.owner && detail.owner.email,
      actionItems: extractActionItems(summaryMd),
      dueDate,
      includeTranscript,
      createPersons,
      store
    });
    synced += results.filter((r) => /created/.test(r.action)).length;
    processed++;
    if (detail.created_at && new Date(detail.created_at) > new Date(newest)) newest = detail.created_at;
  }

  await store.set("lastSync", newest).catch(() => {});
  console.log(`granola-poll: processed ${processed} note(s), ${synced} person-sync(s); lastSync=${newest}`);
};

/* Granola transcript is an array of segments; flatten to text if present. */
function textFromTranscript(t) {
  if (!Array.isArray(t)) return "";
  return t.map((s) => (typeof s === "string" ? s : (s.text || s.content || ""))).filter(Boolean).join("\n");
}

/* Run every 15 minutes. */
export const config = { schedule: "*/15 * * * *" };
