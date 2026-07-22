/* ============================================================
   Granola → GoHighLevel sync (POLLER).

   Granola has NO outbound webhook, so — like ghl-portal-sync — this runs on a
   schedule and pulls from Granola's public REST API (public-api.granola.ai/v1).
   For each new meeting note it:
     • identifies the external participant, by EMAIL (calendar meetings) or by
       PHONE (Granola "Phone call with +1…" notes carry the number in the title
       and list only the owner in attendees),
     • finds — or creates — the matching GHL contact (by email or phone),
     • adds the AI summary as a NOTE,
     • extracts the action items out of the summary markdown and adds one
       TASK per item (due next day by default).

   Reuses lib/ghl.mjs (ghl / createNote). State lives in Netlify Blobs as a
   per-note "processed" marker: a note is only marked once handled (or skipped
   as internal); if its summary isn't generated yet it's retried on a later run.

   Env: GRANOLA_API_KEY        Granola key (grn_…) — desktop app → Settings → Connectors → API keys
        GRANOLA_OWNER_EMAIL    your address(es), never treated as the contact (comma-sep ok)
        GRANOLA_OWNER_PHONE    your number(s), never treated as the contact (comma-sep, default +14155791660)
        GHL_TOKEN, GHL_LOCATION_ID
        GHL_USER_ID            task assignee (defaults to Jerry)
        GRANOLA_CREATE_MISSING_CONTACTS  default "true"  — create a contact when no email/phone match
        GRANOLA_TASK_DUE_DAYS            default 1        — task due date offset (1 = next day)
        GRANOLA_SYNC_LOOKBACK_HOURS     default 48
        OWN_EMAIL_DOMAINS               default "baker1031.com" (comma-sep)
        GRANOLA_MAX_TASKS_PER_NOTE      default 25
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { ghl, createNote } from "./lib/ghl.mjs";
import { extractActionItems } from "./lib/action-items.mjs";

const GRANOLA_BASE = process.env.GRANOLA_API_BASE || "https://public-api.granola.ai/v1";

const CREATE_MISSING = String(process.env.GRANOLA_CREATE_MISSING_CONTACTS ?? "true").toLowerCase() === "true";
const DUE_DAYS       = Number(process.env.GRANOLA_TASK_DUE_DAYS || 1);
const LOOKBACK_HRS   = Number(process.env.GRANOLA_SYNC_LOOKBACK_HOURS || 48);
const MAX_TASKS      = Number(process.env.GRANOLA_MAX_TASKS_PER_NOTE || 25);
const USER_ID        = process.env.GHL_USER_ID || "vsVfOmQ3f1ZnYEVdHolp"; // Jerry; override via GHL_USER_ID

const LOC = () => process.env.GHL_LOCATION_ID;
const digits = (s) => String(s || "").replace(/\D/g, "");

const ownEmails  = (process.env.GRANOLA_OWNER_EMAIL || "jerry@baker1031.com")
  .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const ownDomains = (process.env.OWN_EMAIL_DOMAINS || "baker1031.com")
  .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const ownPhones  = (process.env.GRANOLA_OWNER_PHONE || "+14155791660")
  .split(",").map((s) => digits(s).slice(-10)).filter((d) => d.length === 10);

// Bumped to -2 so the fix re-scans the recent window once (old store marked the
// phone-call notes as internal-skip; nothing was ever imported, so no dup risk).
const BLOB_STORE = "granola-ghl-2";

/* ---- Granola API ---- */
async function granola(path, query) {
  const url = new URL(GRANOLA_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.GRANOLA_API_KEY}`, Accept: "application/json" }
  });
  if (!res.ok) { console.error(`Granola GET ${path} -> ${res.status}`); throw new Error(`granola ${res.status}`); }
  return res.json();
}

async function listNotesSince(sinceISO) {
  const notes = [];
  let cursor;
  do {
    const data = await granola("/notes", { created_after: sinceISO, page_size: 30, cursor });
    for (const n of data.notes || []) notes.push(n);
    cursor = data.hasMore ? data.cursor : undefined;
  } while (cursor);
  return notes;
}

const getNote = (id) => granola(`/notes/${encodeURIComponent(id)}`);

/* ---- GHL helpers on the shared ghl() client ---- */
async function findContactByEmail(email) {
  if (!email) return null;
  const res = await ghl(`/contacts/`, { query: { locationId: LOC(), query: email, limit: 20 } });
  const list = (res.data && res.data.contacts) || [];
  return list.find((c) => String(c.email || "").toLowerCase() === String(email).toLowerCase()) || null;
}

async function findContactByPhone(phone) {
  const last10 = digits(phone).slice(-10);
  if (last10.length < 10) return null;
  // Search by last-10 (matches regardless of stored formatting), then the raw value.
  for (const q of [last10, phone]) {
    const res = await ghl(`/contacts/`, { query: { locationId: LOC(), query: q, limit: 20 } });
    const list = (res.data && res.data.contacts) || [];
    const hit = list.find((c) => digits(c.phone).slice(-10) === last10);
    if (hit) return hit;
  }
  return null;
}

async function createContact({ email, phone, firstName, lastName }) {
  const body = { locationId: LOC(), source: "Granola meeting", tags: ["granola-import"] };
  if (email) body.email = email;
  if (phone) body.phone = phone;
  if (firstName) body.firstName = firstName;
  if (lastName) body.lastName = lastName;
  const res = await ghl(`/contacts/upsert`, { method: "POST", body });
  const c = res.data && (res.data.contact || res.data);
  return c && c.id ? c : null;
}

async function createTask(contactId, { title, body, dueDate, assignedTo }) {
  if (!contactId || !title || !dueDate) return null;
  const payload = { title, dueDate, completed: false };
  if (body) payload.body = body;
  if (assignedTo) payload.assignedTo = assignedTo;
  const res = await ghl(`/contacts/${contactId}/tasks`, { method: "POST", body: payload });
  const t = res.data && (res.data.task || res.data);
  return (t && t.id) || null;
}

/* ---- participant selection ---- */
const isOurs = (email) => {
  const e = String(email || "").toLowerCase();
  if (!e) return true;
  if (ownEmails.includes(e)) return true;
  return ownDomains.includes(e.split("@")[1] || "");
};
const isOurPhone = (p) => {
  const d = digits(p).slice(-10);
  return d.length === 10 && ownPhones.includes(d);
};

function pickParticipant(note) {
  // 1) external email — from attendees / calendar invitees / organiser
  const emails = [];
  for (const a of note.attendees || []) if (a && a.email) emails.push({ email: a.email, name: a.name });
  const ce = note.calendar_event || {};
  for (const inv of ce.invitees || []) if (inv && inv.email) emails.push({ email: inv.email });
  if (ce.organiser) emails.push({ email: ce.organiser });
  const extEmail = emails.find((p) => !isOurs(p.email));

  // 2) phone — an attendee phone field, else the number in a "Phone call with +1…" title
  let phone = null, phoneName = "";
  for (const a of note.attendees || []) {
    const p = a && (a.phone || a.phoneNumber || a.phone_number);
    if (p && !isOurs(a.email) && !isOurPhone(p)) { phone = p; phoneName = a.name || ""; break; }
  }
  if (!phone) {
    const m = String(note.title || "").match(/(\+?\d[\d\s().\-]{7,}\d)/);
    if (m && !isOurPhone(m[1])) phone = m[1].trim();
  }

  if (extEmail) {
    const [firstName, ...rest] = String(extEmail.name || "").split(" ");
    return { email: extEmail.email, phone: phone || undefined, firstName: firstName || "", lastName: rest.join(" ") };
  }
  if (phone) {
    const [firstName, ...rest] = String(phoneName || "").split(" ");
    return { phone, firstName: firstName || "", lastName: rest.join(" ") };
  }
  return null;
}

function noteBody(note) {
  const title = note.title || "Untitled meeting";
  const when = note.calendar_event?.scheduled_start_time || note.created_at || "";
  const summary = note.summary_markdown || note.summary_text || "(no summary)";
  const link = note.web_url ? `\n\nGranola: ${note.web_url}` : "";
  return `Granola meeting notes — ${title}${when ? ` (${when})` : ""}\n\n${summary}${link}`;
}

const dueISO = (days) => new Date(Date.now() + days * 864e5).toISOString();

/* ---- per-note handler; returns { status, mark } ---- */
async function handleNote(noteMeta) {
  const note = await getNote(noteMeta.id);
  if (!note.summary_markdown && !note.summary_text) return { status: "no-summary-yet", mark: false };

  const who = pickParticipant(note);
  if (!who) return { status: "internal-skip", mark: true };
  const label = who.email || who.phone;

  let contact = null;
  if (who.email) contact = await findContactByEmail(who.email);
  if (!contact && who.phone) contact = await findContactByPhone(who.phone);

  if (!contact) {
    if (!CREATE_MISSING) return { status: `no-contact ${label}`, mark: true };
    contact = await createContact(who);
    if (!contact) return { status: `create-failed ${label}`, mark: false };
  }

  await createNote(contact.id, noteBody(note));

  const items = extractActionItems(note.summary_markdown || "", { max: MAX_TASKS });
  const due = dueISO(DUE_DAYS);
  let tasks = 0;
  for (const it of items) {
    const title = it.title.length > 100 ? it.title.slice(0, 97) + "…" : it.title;
    const id = await createTask(contact.id, {
      title,
      body: `From Granola meeting "${note.title || ""}"${note.web_url ? `\n${note.web_url}` : ""}`,
      dueDate: due,
      assignedTo: USER_ID
    });
    if (id) tasks++;
  }
  return { status: `ok contact=${contact.id} via=${who.email ? "email" : "phone"}(${label}) tasks=${tasks}`, mark: true };
}

/* ---- entry ---- */
export default async () => {
  if (!process.env.GRANOLA_API_KEY) { console.log("granola-ghl-sync: no GRANOLA_API_KEY"); return; }
  if (!process.env.GHL_TOKEN)        { console.log("granola-ghl-sync: no GHL_TOKEN"); return; }

  const store = getStore(BLOB_STORE);
  const sinceISO = new Date(Date.now() - LOOKBACK_HRS * 36e5).toISOString();

  let notes;
  try { notes = await listNotesSince(sinceISO); }
  catch (e) { console.error("granola-ghl-sync: list failed", e.message); return; }

  let imported = 0, skipped = 0, errors = 0;
  for (const n of notes) {
    const seen = await store.get(`note:${n.id}`).catch(() => null);
    if (seen) continue;
    try {
      const r = await handleNote(n);
      console.log(`granola-ghl-sync: ${n.id} :: ${r.status}`);
      if (r.mark) await store.set(`note:${n.id}`, new Date().toISOString()).catch(() => {});
      if (r.status.startsWith("ok")) imported++; else skipped++;
    } catch (e) {
      errors++;
      console.error(`granola-ghl-sync: ${n.id} ERROR ${e.message}`);
    }
  }
  console.log(`granola-ghl-sync: ${imported} imported, ${skipped} skipped, ${errors} error(s), ${notes.length} scanned`);
};

/* Poll every 15 minutes — Granola summaries take a few minutes to generate. */
export const config = { schedule: "*/15 * * * *" };
