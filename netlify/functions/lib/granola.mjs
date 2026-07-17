/* Shared Granola → Pipedrive sync logic, used by both the scheduled poller
   (granola-poll.mjs, pulls from the Granola API) and the webhook receiver
   (granola-sync.mjs, receives a Granola Zap). */

import { pd, findPersonByEmail, findOpenDeal, addNote, mdToNoteHtml, esc } from "./pipedrive.mjs";

const lower = (s) => String(s || "").trim().toLowerCase();

/* Pull action items / next steps out of a Granola summary (or an explicit
   list), returned de-duped and capped. */
export function extractActionItems(md, explicit) {
  let lines = [];
  if (explicit) {
    lines = Array.isArray(explicit) ? explicit.map(String) : String(explicit).split(/\n|;/);
  } else {
    const text = String(md || "");
    const m = text.match(/(?:^|\n)\s*#{0,6}\s*(?:action items?|next steps?|to-?dos?|follow[- ]?ups?|tasks?)\s*:?\s*\n([\s\S]*?)(?:\n\s*#{1,6}\s|\n\s*\n\s*\n|$)/i);
    if (m) lines = m[1].split(/\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l));
  }
  const seen = new Set();
  return lines
    .map((l) => String(l)
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")   // list marker
      .replace(/^\[[ x]\]\s*/i, "")               // checkbox
      .replace(/\*\*([^*]+)\*\*/g, "$1")          // **bold**
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")    // *italic*
      .replace(/`([^`]+)`/g, "$1")                // `code`
      .trim())
    .filter((l) => l.length > 2 && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()))
    .slice(0, 15);
}

/* Normalize attendees: array of {email,name} | array of strings | a
   comma/semicolon string of emails. */
export function parseAttendees(raw) {
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

/* Sync one meeting to Pipedrive. For each attendee (owner/creator skipped):
   find or create the person, attach the summary as a Note on their open deal
   (or the person), log a completed meeting Activity, and open a task Activity
   per action item. De-dupes per (meetingId, person) via the given Blobs store. */
export async function syncMeetingToPipedrive(token, opts) {
  const {
    meetingId, title = "Meeting", summaryMd = "", transcript = "", shareUrl = "",
    dateStr = null, attendees = [], ownerEmail = "", creatorEmail = "",
    actionItems = [], dueDate, includeTranscript = false,
    createPersons = true, store
  } = opts;

  let noteHtml = `<b>${esc(title)}</b>${dateStr ? ` &mdash; ${esc(dateStr)}` : ""} (Granola meeting notes)<br><br>`;
  noteHtml += summaryMd ? mdToNoteHtml(summaryMd) : "<i>No summary provided.</i>";
  if (shareUrl) noteHtml += `<br><br><a href="${esc(shareUrl)}">Open in Granola</a>`;
  if (includeTranscript && transcript) noteHtml += `<br><br><b>Transcript</b><br>${mdToNoteHtml(String(transcript).slice(0, 60000))}`;

  const results = [];
  for (const a of attendees) {
    if (!a.email || a.email === lower(ownerEmail) || a.email === lower(creatorEmail)) continue;

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

    const dedupeKey = `note:${meetingId}:${person.id}`;
    if (store) {
      const already = await store.get(dedupeKey).catch(() => null);
      if (already) { results.push({ email: a.email, personId: person.id, action: "already synced" }); continue; }
    }

    const deal = await findOpenDeal(token, person.id);
    const note = await addNote(token, { content: noteHtml, personId: person.id, dealId: deal ? deal.id : undefined });
    const noteId = note && note.data && note.data.id;

    await pd(`/activities`, token, {
      method: "POST",
      body: {
        subject: `Meeting — ${title}`, type: "meeting", done: 1,
        person_id: person.id, deal_id: deal ? deal.id : undefined,
        due_date: dateStr || undefined,
        note: shareUrl ? `Granola notes: ${shareUrl}` : "Logged from Granola."
      }
    });

    let tasksCreated = 0;
    for (const item of actionItems) {
      const t = await pd(`/activities`, token, {
        method: "POST",
        body: {
          subject: item.slice(0, 240), type: "task", done: 0,
          person_id: person.id, deal_id: deal ? deal.id : undefined,
          due_date: dueDate,
          note: `Follow-up from Granola meeting &ldquo;${esc(title)}&rdquo;${shareUrl ? ` — ${esc(shareUrl)}` : ""}`
        }
      });
      if (t && t.data && t.data.id) tasksCreated++;
    }

    if (store && noteId) await store.set(dedupeKey, String(noteId)).catch(() => {});
    results.push({
      email: a.email, personId: person.id, dealId: deal ? deal.id : null,
      noteId: noteId || null, personCreated: createdPerson, tasksCreated,
      action: "note + meeting logged" + (tasksCreated ? ` + ${tasksCreated} task(s)` : "")
    });
  }
  return results;
}
