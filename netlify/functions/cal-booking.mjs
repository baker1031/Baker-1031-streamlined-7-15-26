/* ============================================================
   Cal.com → Pipedrive webhook receiver.

   Add this URL as a webhook subscriber in Cal.com
   (Settings → Developer → Webhooks):

     https://<site>/.netlify/functions/cal-booking?secret=<CAL_WEBHOOK_SECRET>

   Triggers handled:
   - BOOKING_CREATED     → find Person by attendee email, create a
                           scheduled Activity (call) at the booking
                           time, linked to the person + their most
                           recent open Deal, with a booking note.
   - BOOKING_RESCHEDULED → same as created (new time), note says so.
   - BOOKING_CANCELLED   → note on the person (and deal) that the
                           call was cancelled.

   Env: PIPEDRIVE_API_TOKEN, CAL_WEBHOOK_SECRET
   ============================================================ */

const API = "https://api.pipedrive.com/v1";

export default async (req) => {
  if (req.method !== "POST") return ok("method ignored");

  const secret = process.env.CAL_WEBHOOK_SECRET;
  const url = new URL(req.url);
  // Fail closed: no configured secret means no access
  if (!secret || url.searchParams.get("secret") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return ok("pipedrive not configured");

  let body;
  try { body = await req.json(); } catch { return ok("bad payload"); }

  const event = body.triggerEvent || body.event || "";
  const p = body.payload || {};
  const attendee = (p.attendees && p.attendees[0]) || {};
  const email = attendee.email || (p.responses && p.responses.email && p.responses.email.value);
  const attendeeName = attendee.name || (p.responses && p.responses.name && p.responses.name.value) || email;
  if (!email) return ok("no attendee email");

  // ---------- Person (find, or create so no booking is lost) ----------
  let person = await findPerson(token, email);
  if (!person) {
    const created = await pd("POST", `/persons`, token, {
      name: attendeeName || email,
      emails: [{ value: email, primary: true }]
    }, 2);
    person = created && created.data;
  }
  if (!person) return ok("person unavailable");

  // Most recent open deal for this person, if any
  const dealsRes = await pd("GET", `/deals&person_id=${person.id}&status=open&sort_by=add_time&sort_direction=desc&limit=1`, token, null, 2);
  const deal = dealsRes && dealsRes.data && dealsRes.data[0];

  const eventTitle = (p.eventType && p.eventType.title) || p.title || "Call";
  const start = p.startTime ? new Date(p.startTime) : null;
  const end = p.endTime ? new Date(p.endTime) : null;
  const uid = p.uid || "";
  const tz = attendee.timeZone || p.organizer?.timeZone || "";

  if (event === "BOOKING_CREATED" || event === "BOOKING_RESCHEDULED") {
    const rescheduled = event === "BOOKING_RESCHEDULED";
    await pd("POST", `/activities`, token, clean({
      subject: `${eventTitle} — ${attendeeName}${rescheduled ? " (rescheduled)" : ""}`,
      type: "call",
      person_id: person.id,
      deal_id: deal ? deal.id : undefined,
      due_date: start ? start.toISOString().slice(0, 10) : undefined,
      due_time: start ? start.toISOString().slice(11, 16) : undefined, // UTC HH:MM
      duration: start && end ? msToHHMM(end - start) : undefined,
      note: [
        `Booked via Cal.com${rescheduled ? " (rescheduled)" : ""}.`,
        start ? `Starts: ${start.toISOString()}${tz ? ` (attendee TZ: ${tz})` : ""}` : "",
        uid ? `Cal booking UID: ${uid}` : ""
      ].filter(Boolean).join("<br>")
    }));
    return ok("activity created");
  }

  if (event === "BOOKING_CANCELLED") {
    await pd("POST", `/notes`, token, clean({
      content: `<b>Cal.com booking cancelled</b><br>${esc(eventTitle)}${start ? ` — was scheduled for ${start.toISOString()}` : ""}${uid ? `<br>Cal booking UID: ${uid}` : ""}`,
      person_id: person.id,
      deal_id: deal ? deal.id : undefined
    }));
    return ok("cancellation noted");
  }

  return ok(`event ${event} ignored`);
};

async function findPerson(token, email) {
  const res = await pd("GET", `/persons/search&term=${encodeURIComponent(email)}&fields=email&exact_match=true`, token);
  const item = res && res.data && res.data.items && res.data.items[0];
  return item ? item.item : null;
}

async function pd(method, path, token, body, v) {
  const base = v === 2 ? "https://api.pipedrive.com/api/v2" : API;
  const [p, extra] = path.split("&");
  const url = `${base}${p}${extra ? "?" + extra : ""}`;
  const res = await fetch(url, {
    method,
    headers: { "x-api-token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  try { return await res.json(); } catch { return {}; }
}

function msToHHMM(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function clean(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && obj[k] !== "" && obj[k] !== null) out[k] = obj[k];
  }
  return out;
}
function ok(note) {
  return new Response(JSON.stringify({ ok: true, note }), { status: 200, headers: { "Content-Type": "application/json" } });
}
