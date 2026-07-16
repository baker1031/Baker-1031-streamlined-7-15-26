/* ============================================================
   Cal.com → Pipedrive + Kinde webhook receiver.

   Webhook URL (Cal.com → Settings → Developer → Webhooks):
     https://<site>/.netlify/functions/cal-booking?secret=<CAL_WEBHOOK_SECRET>

   Auth: prefers Cal's HMAC header (X-Cal-Signature-256, signed with the
   same secret); falls back to the ?secret= URL check. Fails closed.

   BOOKING_CREATED:
     - find/create the Person, link their most recent open Deal
     - create (or update, on re-delivery) a call Activity
     - PROVISION the investor portal login server-side (Kinde) and set
       Pipedrive "Portal Access" = Yes — the browser never triggers
       provisioning (the old public provision-user endpoint is gone)
   BOOKING_RESCHEDULED:
     - update the SAME activity (uid → activity_id map in Netlify Blobs)
       instead of creating a duplicate
   BOOKING_CANCELLED:
     - mark the mapped activity done + note the cancellation on the person

   Env: PIPEDRIVE_API_TOKEN, CAL_WEBHOOK_SECRET,
        KINDE_DOMAIN, KINDE_M2M_CLIENT_ID, KINDE_M2M_CLIENT_SECRET,
        PD_FIELD_PORTAL_ACCESS, PD_PORTAL_YES
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { json, ok, verifyCalSignature } from "./lib/http.mjs";
import { pd, findPersonByEmail, findOpenDeal, esc } from "./lib/pipedrive.mjs";
import { kindeToken, createUser, findUserByEmail, unsuspendUser } from "./lib/kinde.mjs";

export default async (req) => {
  if (req.method !== "POST") return ok("method ignored");

  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (!secret) return new Response("forbidden", { status: 403 }); // fail closed

  const rawBody = await req.text();
  const sigOk = await verifyCalSignature(rawBody, req.headers.get("x-cal-signature-256"), secret);
  const urlOk = new URL(req.url).searchParams.get("secret") === secret;
  if (!sigOk && !urlOk) return new Response("forbidden", { status: 403 });

  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return ok("pipedrive not configured");

  let body;
  try { body = JSON.parse(rawBody); } catch { return ok("bad payload"); }

  const event = body.triggerEvent || body.event || "";
  const p = body.payload || {};
  const attendee = (p.attendees && p.attendees[0]) || {};
  const email = String(
    attendee.email || (p.responses && p.responses.email && p.responses.email.value) || ""
  ).trim().toLowerCase();
  const attendeeName = attendee.name || (p.responses && p.responses.name && p.responses.name.value) || email;
  if (!email) return ok("no attendee email");

  /* ---------- Person (find, or create so no booking is lost) ---------- */
  let person = await findPersonByEmail(token, email);
  if (!person) {
    const created = await pd(`/persons`, token, {
      method: "POST", v: 2,
      body: { name: attendeeName || email, emails: [{ value: email, primary: true }] }
    });
    person = created && created.data;
  }
  if (!person) return ok("person unavailable");

  const deal = await findOpenDeal(token, person.id);

  const eventTitle = (p.eventType && p.eventType.title) || p.title || "Call";
  const start = p.startTime ? new Date(p.startTime) : null;
  const end = p.endTime ? new Date(p.endTime) : null;
  const uid = p.uid || "";
  const tz = attendee.timeZone || p.organizer?.timeZone || "";

  const store = getStore("cal-bookings");
  const mapKey = uid ? `uid:${uid}` : null;

  if (event === "BOOKING_CREATED" || event === "BOOKING_RESCHEDULED") {
    const rescheduled = event === "BOOKING_RESCHEDULED";
    const fields = clean({
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
    });

    // Same booking already has an activity? Update it instead of duplicating.
    let existingId = mapKey ? await store.get(mapKey).catch(() => null) : null;
    if (existingId) {
      const upd = await pd(`/activities/${existingId}`, token, { method: "PUT", body: fields });
      if (!upd || upd.success === false) existingId = null; // stale mapping — recreate
    }
    if (!existingId) {
      const createdAct = await pd(`/activities`, token, { method: "POST", body: fields });
      const newId = createdAct && createdAct.data && createdAct.data.id;
      if (newId && mapKey) await store.set(mapKey, String(newId)).catch(() => {});
    }

    /* ---------- Server-side portal provisioning (BOOKING_CREATED only) ---------- */
    if (!rescheduled) {
      try {
        const kt = await kindeToken();
        if (kt) {
          const nameParts = String(attendeeName || "").trim().split(/\s+/);
          const res = await createUser(kt, {
            email,
            given: person.first_name || nameParts[0] || "",
            family: person.last_name || nameParts.slice(1).join(" ") || ""
          });
          if (res.ok && !res.created) {
            // pre-existing user: make sure they aren't suspended
            const u = await findUserByEmail(kt, email);
            if (u && u.is_suspended) await unsuspendUser(kt, u.id);
          }
          if (res.ok) await markPortalAccess(token, person.id);
        }
      } catch (e) {
        console.error("provisioning failed:", e);
      }
    }

    return ok(rescheduled ? "activity updated" : "activity created + provisioned");
  }

  if (event === "BOOKING_CANCELLED") {
    const existingId = mapKey ? await store.get(mapKey).catch(() => null) : null;
    if (existingId) {
      await pd(`/activities/${existingId}`, token, {
        method: "PUT",
        body: { subject: `${eventTitle} — ${attendeeName} (cancelled)`, done: 1 }
      });
    }
    await pd(`/notes`, token, {
      method: "POST",
      body: clean({
        content: `<b>Cal.com booking cancelled</b><br>${esc(eventTitle)}${start ? ` — was scheduled for ${start.toISOString()}` : ""}${uid ? `<br>Cal booking UID: ${uid}` : ""}`,
        person_id: person.id,
        deal_id: deal ? deal.id : undefined
      })
    });
    return ok("cancellation noted");
  }

  return ok(`event ${event} ignored`);
};

async function markPortalAccess(token, personId) {
  const fieldKey = process.env.PD_FIELD_PORTAL_ACCESS;
  const yes = process.env.PD_PORTAL_YES;
  if (!fieldKey || !yes) return;
  await pd(`/persons/${personId}`, token, {
    method: "PATCH", v: 2,
    body: { custom_fields: { [fieldKey]: Number(yes) } }
  });
}

function msToHHMM(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}
function clean(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && obj[k] !== "" && obj[k] !== null) out[k] = obj[k];
  }
  return out;
}
