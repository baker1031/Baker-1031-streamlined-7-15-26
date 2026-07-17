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

   What it does, for each attendee (the meeting owner's own email is
   skipped):
     - finds the Pipedrive person by email, or CREATES them if missing
       (so a new prospect from a meeting lands in the CRM automatically)
     - attaches the Granola summary as a Note on their most recent open
       Deal (or on the Person if they have no open deal)
     - logs a completed "meeting" Activity with the title + date
     - creates an open "task" Activity for each action item / next step
       from the meeting (parsed from the summary, or from an explicit
       action-items field mapped in the Zap), due in a few days
     - de-dupes on (meeting id → person) via Netlify Blobs, so a Zap that
       re-fires doesn't create duplicate notes/tasks

   Env: PIPEDRIVE_API_TOKEN, GRANOLA_WEBHOOK_SECRET
        GRANOLA_OWNER_EMAIL (your own address, skipped as an attendee)
        GRANOLA_TASK_DUE_DAYS (optional, default 3 — task due-date horizon)
        GRANOLA_SKIP_UNKNOWN=1 (optional — do NOT create missing people)
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

/* Pull action items / next steps out of a Granola summary, or from an
   explicit field the Zap mapped in. Returns a de-duped list of task lines. */
function extractActionItems(md, explicit) {
  let lines = [];
  if (explicit) {
    lines = Array.isArray(explicit) ? explicit.map(String) : String(explicit).split(/\n|;/);
  } else {
    const text = String(md || "");
    // Grab the block under an "Action items / Next steps / To-dos / Follow-ups" heading.
    const m = text.match(/(?:^|\n)\s*#{0,6}\s*(?:action items?|next steps?|to-?dos?|follow[- ]?ups?|tasks?)\s*:?\s*\n([\s\S]*?)(?:\n\s*#{1,6}\s|\n\s*\n\s*\n|$)/i);
    if (m) lines = m[1].split(/\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l));
  }
  const seen = new Set();
  return lines
    .map((l) => String(l).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^\[[ x]\]\s*/i, "").trim())
    .filter((l) => l.length > 2 && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()))
    .slice(0, 15);
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
  const createPersons = process.env.GRANOLA_SKIP_UNKNOWN !== "1"; // create missing people by default
  const includeTranscript = process.env.GRANOLA_INCLUDE_TRANSCRIPT === "1";

  const actionItems = extractActionItems(summaryMd, p.action_items || p.actionItems || p.next_steps || p.tasks);
  const dueDays = Number(process.env.GRANOLA_TASK_DUE_DAYS || 3) || 3;
  const dueDate = new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10);

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
    let createdPerson = false;
    if (!person) {
      if (!createPersons) { results.push({ email: a.email, action: "skipped (not in Pipedrive)" }); continue; }
      const created = await pd(`/persons`, token, {
        method: "POST", v: 2,
        body: { name: a.name || a.email, emails: [{ value: a.email, primary: true }] }
      });
      person = created && created.data;
      if (!person) { results.push({ email: a.email, action: "person create failed" }); continue; }
      createdPerson = true;
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

    // Open follow-up tasks from the meeting's action items.
    let tasksCreated = 0;
    for (const item of actionItems) {
      const t = await pd(`/activities`, token, {
        method: "POST",
        body: {
          subject: item.slice(0, 240),
          type: "task",
          done: 0,
          person_id: person.id,
          deal_id: deal ? deal.id : undefined,
          due_date: dueDate,
          note: `Follow-up from Granola meeting &ldquo;${esc(title)}&rdquo;${shareUrl ? ` — ${esc(shareUrl)}` : ""}`
        }
      });
      if (t && t.data && t.data.id) tasksCreated++;
    }

    if (noteId) await store.set(dedupeKey, String(noteId)).catch(() => {});
    results.push({
      email: a.email, personId: person.id, dealId: deal ? deal.id : null,
      noteId: noteId || null, personCreated: createdPerson, tasksCreated,
      action: "note + meeting logged" + (tasksCreated ? ` + ${tasksCreated} task(s)` : "")
    });
  }

  return json({ ok: true, meeting: title, meetingId, actionItems: actionItems.length, synced: results });
};
