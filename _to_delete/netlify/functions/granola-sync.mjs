/* ============================================================
   Granola → Pipedrive webhook receiver (Zapier path).

   Alternate to the scheduled poller (granola-poll.mjs, which pulls from the
   Granola API with your key). Use THIS one only if you'd rather push from a
   Granola Zap than poll the API. Point the Zap's "Webhooks by Zapier → POST"
   step at:

     https://<site>/.netlify/functions/granola-sync?secret=<GRANOLA_WEBHOOK_SECRET>

   Sends the meeting title, attendee emails, the enhanced summary, and
   (optional) the action-items field. Shares all sync behaviour with the
   poller via lib/granola.mjs: logs a Note, creates the person if missing,
   logs a completed meeting Activity, opens a task per action item, de-dupes.

   Env: PIPEDRIVE_API_TOKEN, GRANOLA_WEBHOOK_SECRET, GRANOLA_OWNER_EMAIL,
        GRANOLA_TASK_DUE_DAYS (3), GRANOLA_SKIP_UNKNOWN=1, GRANOLA_INCLUDE_TRANSCRIPT=1
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { ok, json } from "./lib/http.mjs";
import { extractActionItems, parseAttendees, extractPhone, syncMeetingToPipedrive } from "./lib/granola.mjs";

const lower = (s) => String(s || "").trim().toLowerCase();

/* First matching key from the payload (Zapier field names vary). */
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
  return "";
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
  const p = body.payload || body.data || body.note || body;

  const title = String(pick(p, ["title", "meeting_title", "name", "subject"]) || "Meeting").trim();
  const summaryMd = String(pick(p, ["summary", "summary_markdown", "enhanced_notes", "notes", "content", "markdown", "enhanced_summary"]) || "");
  const transcript = String(pick(p, ["transcript", "full_transcript"]) || "");
  const shareUrl = String(pick(p, ["share_url", "web_url", "url", "link", "shareable_link"]) || "");
  const meetingId = String(pick(p, ["id", "meeting_id", "note_id", "uid"]) || shareUrl || title);
  const whenRaw = pick(p, ["date", "start", "start_time", "startTime", "created_at", "meeting_date"]);
  const when = whenRaw ? new Date(whenRaw) : null;
  const dateStr = when && !isNaN(when) ? when.toISOString().slice(0, 10) : null;

  const attendees = parseAttendees(p.attendees || p.attendee_emails || p.participants || p.emails || pick(p, ["attendees_list"]));
  const matchByPhone = process.env.GRANOLA_MATCH_BY_PHONE !== "0";
  const phone = matchByPhone ? (String(pick(p, ["phone", "phone_number", "caller"])) || extractPhone(title)) : "";
  if (!attendees.length && !phone) return ok("no attendee email or phone in payload");

  const dueDays = Number(process.env.GRANOLA_TASK_DUE_DAYS || 3) || 3;
  const results = await syncMeetingToPipedrive(token, {
    meetingId, title, summaryMd, transcript, shareUrl, dateStr, attendees,
    ownerEmail: process.env.GRANOLA_OWNER_EMAIL,
    creatorEmail: pick(p, ["creator_email", "organizer_email", "owner_email"]),
    actionItems: extractActionItems(summaryMd, p.action_items || p.actionItems || p.next_steps || p.tasks),
    dueDate: new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10),
    includeTranscript: process.env.GRANOLA_INCLUDE_TRANSCRIPT === "1",
    createPersons: process.env.GRANOLA_SKIP_UNKNOWN !== "1",
    phone,
    createFromPhone: process.env.GRANOLA_CREATE_FROM_PHONE === "1",
    store: getStore("granola-sync")
  });

  return json({ ok: true, meeting: title, meetingId, synced: results });
};
