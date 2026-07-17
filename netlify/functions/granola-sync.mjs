/* ============================================================
   Granola → Pipedrive webhook receiver.

   Granola has NO native Pipedrive connector, so meetings reach Pipedrive
   through a Granola Zap (Zapier). Point the Zap's "Webhooks by Zapier →
   POST" step at:

     https://<site>/.netlify/functions/granola-sync?secret=<GRANOLA_WEBHOOK_SECRET>

   Granola's Zapier trigger ("Note added to folder" or "Note shared to
   Zapier") includes the meeting title, attendee names + emails, the
   enhanced summary (Markdown), the transcript, and a share link. Map those
   onto the JSON body below in the Zap's POST step (or send the whole
   payload — this function reads several common field names defensively).

   What it does, for each attendee email that ALREADY matches a Pipedrive
   person (the meeting owner's own email is skipped):
     - attaches the Granola summary as a Note on their most recent open
       Deal (or on the Person if they have no open deal)
     - logs a completed "meeting" Activity with the title + date
     - de-dupes on (meeting id → person) via Netlify Blobs, so a Zap that
       re-fires doesn't create duplicate notes

   By default it does NOT create new persons — random external attendees
   shouldn't land in the CRM. Set GRANOLA_CREATE_PERSONS=1 to change that.

   Env: PIPEDRIVE_API_TOKEN, GRANOLA_WEBHOOK_SECRET
        GRANOLA_OWNER_EMAIL (your own address, skipped as an attendee)
        GRANOLA_CREATE_PERSONS=1 (optional — create unknown attendees)
        GRANOLA_INCLUDE_TRANSCRIPT=1 (optional — append full transcript)
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { json, ok } from "./lib/http.mjs";
import { pd, findPersonByEmail, findOpenDeal, addNote, mdToNoteHtml, esc } from "./lib/pipedrive.mjs";

const lower = (s) => String(s || "").trim().toLowerCase();

/* Pull a value from the first matching key (Zapier field names vary). */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
  }
  return "";
}

/* Normalize attendees from any of: array of {email,name} | array of strings
   | comma/semicolon-separated string of emails. */
function parseAttendees(raw) {
  const out = [];
  const push = (email, name) => { const e = lower(email); if (e && /@/.test(e)) out.push({ email: e, name: (name || "").trim() }); };
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (typeof a === "string") push(a);
      else if (a && typeof a === "object") push(a.email || a.address || a.value, a.name || a.displayName);
    }
  } else if (typeof raw === "string") {
    for (const part of raw.split(/[,;]+/)) push(part);
  }
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return ok("method ignored");

  const secret = process.env.GRANOLA_WEBHOOK_SECRET;
  if (!secret) return new Response("forbidden", { status: 403 }); // fail closed
  const url = new URL(req.url);
  const secretOk = url.searchParams.get("secret") === secret ||
    lower(req.headers.get("x-granola-secret")) === lower(secret);
  if (!secretOk) return new Response("forbidden", { status: 403 });

  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return ok("pipedrive not configured");

  let body;
  try { body = JSON.parse(await req.text()); } catch { return ok("bad payload"); }

  // Granola/Zapier payloads nest differently; look at the root and a few common wrappers.
  const p = body.payload || body.data || body.note || body;

  const title = String(pick(p, ["title", "meeting_title", "name", "subject"]) || "Meeting").trim();
  const summaryMd = String(pick(p, ["summary", "enhanced_notes", "notes", "content", "markdown", "enhanced_summary"]) || "");
  const transcript = String(pick(p, ["transcript", "full_transcript"]) || "");
  const shareUrl = String(pick(p, ["share_url", "url", "link", "shareable_link"]) || "");
  const meetingId = String(pick(p, ["id", "meeting_id", "note_id", "uid"]) || shareUrl || title);
  const whenRaw = pick(p, ["date", "start", "start_time", "startTime", "created_at", "meeting_date"]);
  const when = whenRaw ? new Date(whenRaw) : null;
  const dateStr = when && !isNaN(when) ? when.toISOString().slice(0, 10) : null;

  const attendees = parseAttendees(
    p.attendees || p.attendee_emails || p.participants || p.emails || pick(p, ["attendees_list"])
  );
  if (!attendees.length) return ok("no attendee emails in payload");

  const ownerEmail = lower(process.env.GRANOLA_OWNER_EMAIL);
  const creatorEmail = lower(pick(p, ["creator_email", "organizer_email", "owner_email"]));
  const createPersons = process.env.GRANOLA_CREATE_PERSONS === "1";
  const includeTranscript = process.env.GRANOLA_INCLUDE_TRANSCRIPT === "1";

  // Build the note HTML once (same content per matched person).
  let noteHtml = `<b>${esc(title)}</b>${dateStr ? ` &mdash; ${esc(dateStr)}` : ""} (Granola meeting notes)<br><br>`;
  noteHtml += summaryMd ? mdToNoteHtml(summaryMd) : "<i>No summary provided.</i>";
  if (shareUrl) noteHtml += `<br><br><a href="${esc(shareUrl)}">Open in Granola</a>`;
  if (includeTranscript && transcript) noteHtml += `<br><br><b>Transcript</b><br>${mdToNoteHtml(transcript.slice(0, 60000))}`;

  const store = getStore("granola-notes");
  const results = [];

  for (const a of attendees) {
    if (a.email === ownerEmail || a.email === creatorEmail) continue; // skip yourself

    let person = await findPersonByEmail(token, a.email);
    if (!person) {
      if (!createPersons) { results.push({ email: a.email, action: "skipped (not in Pipedrive)" }); continue; }
      const created = await pd(`/persons`, token, {
        method: "POST", v: 2,
        body: { name: a.name || a.email, emails: [{ value: a.email, primary: true }] }
      });
      person = created && created.data;
      if (!person) { results.push({ email: a.email, action: "person create failed" }); continue; }
    }

    // De-dupe: one note per (meeting, person). Skip if we've already logged it.
    const dedupeKey = `note:${meetingId}:${person.id}`;
    const already = await store.get(dedupeKey).catch(() => null);
    if (already) { results.push({ email: a.email, personId: person.id, action: "already synced" }); continue; }

    const deal = await findOpenDeal(token, person.id);
    const note = await addNote(token, { content: noteHtml, personId: person.id, dealId: deal ? deal.id : undefined });
    const noteId = note && note.data && note.data.id;

    // Completed "meeting" activity so it shows on the timeline.
    await pd(`/activities`, token, {
      method: "POST",
      body: {
        subject: `Meeting — ${title}`,
        type: "meeting",
        done: 1,
        person_id: person.id,
        deal_id: deal ? deal.id : undefined,
        due_date: dateStr || undefined,
        note: shareUrl ? `Granola notes: ${shareUrl}` : "Logged from Granola."
      }
    });

    if (noteId) await store.set(dedupeKey, String(noteId)).catch(() => {});
    results.push({ email: a.email, personId: person.id, dealId: deal ? deal.id : null, noteId: noteId || null, action: "note + activity created" });
  }

  return json({ ok: true, meeting: title, meetingId, synced: results });
};
