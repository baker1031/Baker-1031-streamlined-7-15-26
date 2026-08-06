/* Cal.com phone-booking bridge.

   Cal.com sends a signed POST here for the event type used by the website.
   The handler keeps the established GHL -> HubSpot -> Kinde path in sync and
   stores the appointment for reference. Reminder emails are handled by
   GoHighLevel; this function no longer drives an email provider.
*/

import { getStore } from "@netlify/blobs";
import { json, verifyCalSignature } from "./lib/http.mjs";
import { kindeToken, createUser, findUserByEmail, unsuspendUser } from "./lib/kinde.mjs";
import {
  upsertContact, getContactFieldMap, resolvePipeline,
  findOpenOpportunity, createOpportunity, updateOpportunity, stageId
} from "./lib/ghl.mjs";
import { PIPELINE_NAME, STAGES, LEAD_STATUS, buildContactFields } from "./lib/ghl-config.mjs";
import {
  upsertContact as upsertHubSpotContact,
  findOpenDealForContact, createDeal, updateDeal,
  createNote as createHubSpotNote, searchNotesByMarker,
  createTask, searchTasksByMarker
} from "./lib/hubspot.mjs";
import { DEAL_STAGES, LEAD_STATUS as HUBSPOT_LEAD_STATUS } from "./lib/hs-config.mjs";
import { properName } from "./lib/name.mjs";

const APPOINTMENT_STORE = "cal-appointments";
const BOOKING_EVENT = "BOOKING_CREATED";
const RESCHEDULE_EVENT = "BOOKING_RESCHEDULED";
const CANCEL_EVENT = "BOOKING_CANCELLED";
const NO_SHOW_EVENTS = new Set([
  "BOOKING_NO_SHOW_UPDATED",
  "AFTER_HOSTS_CAL_VIDEO_NO_SHOW",
  "AFTER_GUESTS_CAL_VIDEO_NO_SHOW"
]);

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const rawBody = await req.text();
  const secret = env("CAL_WEBHOOK_SECRET") || env("CAL_API_SECRET") || env("CAL_API_Secret");
  if (!secret || !(await verifyCalSignature(rawBody, req.headers.get("x-cal-signature-256"), secret))) {
    return json({ error: "forbidden" }, 403);
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { return json({ error: "invalid JSON" }, 400); }

  const triggerEvent = String(body.triggerEvent || body.trigger_event || "").toUpperCase();
  const payload = body.payload || body;
  if (![BOOKING_EVENT, RESCHEDULE_EVENT, CANCEL_EVENT, ...NO_SHOW_EVENTS].includes(triggerEvent)) {
    return json({ ok: true, ignored: true, triggerEvent });
  }

  const details = contactDetails(payload);
  const appointmentId = String(payload.uid || payload.bookingUid || payload.bookingId || payload.id || "").trim();
  const markerId = appointmentId || `${details.email}:${payload.startTime || payload.start_time || "unknown"}`;
  const errors = [];

  if (triggerEvent === BOOKING_EVENT || triggerEvent === RESCHEDULE_EVENT) {
    const reminder = appointmentRecord(payload, details, triggerEvent);
    if (reminder.email && reminder.startTime) {
      await getStore(APPOINTMENT_STORE).setJSON(`booking/${markerId}`, reminder);
    }
    await processBooking(details, payload, markerId, triggerEvent, errors);
  } else if (triggerEvent === CANCEL_EVENT) {
    await markAppointmentCancelled(markerId, payload);
    await processCancellation(details, payload, markerId, errors);
  } else if (NO_SHOW_EVENTS.has(triggerEvent)) {
    await processNoShow(details, payload, markerId, errors);
  }

  return json({
    ok: errors.length === 0,
    triggerEvent,
    appointmentId: appointmentId || undefined,
    errors
  }, errors.length ? 500 : 200);
};

async function processBooking(details, payload, markerId, triggerEvent, errors) {
  const fullName = details.fullName || details.email;
  let ghlContact = null;
  if (env("GHL_TOKEN") && details.email) {
    try {
      const fieldMap = await getContactFieldMap();
      const customFields = buildContactFields(fieldMap, {
        lead_status: LEAD_STATUS.INTRO_CALL_SCHEDULED,
        portal_access: "Yes"
      });
      ghlContact = await upsertContact({
        email: details.email,
        firstName: details.first,
        lastName: details.last,
        name: fullName,
        phone: details.phone,
        customFields
      });
      const pipeline = await resolvePipeline(PIPELINE_NAME);
      if (pipeline && ghlContact?.id) {
        const open = await findOpenOpportunity(ghlContact.id);
        const stage = stageId(pipeline, STAGES.CONSULTATION);
        if (open) await updateOpportunity(open.id, { pipelineId: pipeline.id, pipelineStageId: stage });
        else await createOpportunity({
          name: `${fullName} — Consultation`,
          pipelineId: pipeline.id,
          pipelineStageId: stage,
          contactId: ghlContact.id
        });
      }
    } catch (error) { errors.push({ system: "ghl", message: errorMessage(error) }); }
  }

  let hsContact = null;
  if (env("HUBSPOT_TOKEN") && details.email) {
    try {
      hsContact = await upsertHubSpotContact(details.email, {
        firstname: details.first,
        lastname: details.last,
        phone: details.phone,
        hs_lead_status: HUBSPOT_LEAD_STATUS.INTRO_CALL_SCHEDULED,
        lifecyclestage: "salesqualifiedlead",
        portal_access: "Yes"
      });
      if (hsContact?.id) {
        const existing = await findOpenDealForContact(hsContact.id);
        const deal = existing
          ? await updateDeal(existing.id, {
            pipeline: "default",
            dealstage: DEAL_STAGES.CONSULTATION_SCHEDULED,
            ghl_stage_name: "Consultation Scheduled",
            ghl_status: "open",
            ghl_source: "Cal.com webhook"
          })
          : await createDeal({
            dealname: `${fullName} — Consultation`,
            pipeline: "default",
            dealstage: DEAL_STAGES.CONSULTATION_SCHEDULED,
            ghl_stage_name: "Consultation Scheduled",
            ghl_status: "open",
            ghl_source: "Cal.com webhook"
          }, hsContact.id);
        const noteMarker = `[Cal booking:${markerId}]`;
        if (!(await searchNotesByMarker(noteMarker)).length) {
          await createHubSpotNote({
            body: `${noteMarker}\n${triggerEvent === RESCHEDULE_EVENT ? "Phone appointment rescheduled" : "Phone appointment booked"}.\n${appointmentSummary(payload)}`,
            contactId: hsContact.id,
            dealId: deal?.id || existing?.id
          });
        }
        const taskMarker = `[Cal task:${markerId}]`;
        if (!(await searchTasksByMarker(taskMarker)).length) {
          await createTask({
            title: "Introductory phone call",
            body: appointmentSummary(payload),
            dueDate: payload.startTime || payload.start_time,
            startDate: payload.startTime || payload.start_time,
            contactId: hsContact.id,
            dealId: deal?.id || existing?.id,
            marker: taskMarker
          });
        }
      }
    } catch (error) { errors.push({ system: "hubspot", message: errorMessage(error) }); }
  }

  if (details.email) {
    try {
      const token = await kindeToken();
      if (token) {
        const parts = fullName.split(/\s+/);
        const result = await createUser(token, {
          email: details.email,
          given: details.first || parts[0] || "",
          family: details.last || parts.slice(1).join(" ") || ""
        });
        if (result.ok && !result.created) {
          const user = await findUserByEmail(token, details.email);
          if (user?.is_suspended) await unsuspendUser(token, user.id);
        }
      }
    } catch (error) { errors.push({ system: "kinde", message: errorMessage(error) }); }
  }
}

async function processCancellation(details, payload, markerId, errors) {
  const marker = `[Cal cancelled:${markerId}]`;
  if (!details.email) return;

  if (env("HUBSPOT_TOKEN")) {
    try {
      const contact = await upsertHubSpotContact(details.email, {
        firstname: details.first,
        lastname: details.last,
        phone: details.phone
      });
      if (contact?.id && !(await searchNotesByMarker(marker)).length) {
        await createHubSpotNote({ body: `${marker}\nPhone appointment cancelled.\n${appointmentSummary(payload)}`, contactId: contact.id });
      }
    } catch (error) { errors.push({ system: "hubspot", message: errorMessage(error) }); }
  }
}

async function processNoShow(details, payload, markerId, errors) {
  if (!details.email) return;
  let markerCreated = true;
  if (env("HUBSPOT_TOKEN")) {
    try {
      const contact = await upsertHubSpotContact(details.email, {
        firstname: details.first,
        lastname: details.last,
        phone: details.phone,
        hs_lead_status: HUBSPOT_LEAD_STATUS.NO_SHOW,
        lifecyclestage: "lead",
        portal_access: "No"
      });
      const marker = `[Cal no-show:${markerId}]`;
      markerCreated = !(await searchNotesByMarker(marker)).length;
      if (contact?.id && markerCreated) {
        await createHubSpotNote({ body: `${marker}\nCal.com marked the phone appointment as a no-show.`, contactId: contact.id });
      }
    } catch (error) { errors.push({ system: "hubspot", message: errorMessage(error) }); }
  }

}

async function markAppointmentCancelled(markerId, payload) {
  if (!markerId) return;
  const store = getStore(APPOINTMENT_STORE);
  const key = `booking/${markerId}`;
  const existing = await store.get(key, { type: "json" });
  if (existing) await store.setJSON(key, { ...existing, cancelled: true, updatedAt: new Date().toISOString() });
  else await store.setJSON(key, { bookingId: markerId, cancelled: true, startTime: payload.startTime || payload.start_time, updatedAt: new Date().toISOString() });
}

function appointmentRecord(payload, details, triggerEvent) {
  return {
    bookingId: String(payload.uid || payload.bookingUid || payload.bookingId || payload.id || ""),
    email: details.email,
    firstName: details.first,
    lastName: details.last,
    phone: details.phone,
    title: payload.title || "Introductory Phone Call",
    startTime: payload.startTime || payload.start_time,
    endTime: payload.endTime || payload.end_time,
    bookingUrl: payload.bookingUrl || payload.booking_url,
    triggerEvent,
    cancelled: false,
    sent24h: false,
    sent1h: false,
    updatedAt: new Date().toISOString()
  };
}

function contactDetails(payload) {
  const responses = payload.responses || {};
  const attendee = Array.isArray(payload.attendees) ? payload.attendees[0] || {} : {};
  const email = firstValue(payload.email, responses.email, attendee.email, payload.attendee?.email);
  const name = firstValue(payload.name, responses.name, attendee.name, payload.attendee?.name);
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return {
    email: String(email || "").trim().toLowerCase(),
    phone: firstValue(payload.phone, payload.attendeePhoneNumber, responses.attendeePhoneNumber, responses.phone, attendee.phone),
    first: properName(firstValue(payload.firstName, payload.first_name, responses.firstName, parts[0] || "")),
    last: properName(firstValue(payload.lastName, payload.last_name, responses.lastName, parts.slice(1).join(" "))),
    fullName: properName(name || [parts[0], parts.slice(1).join(" ")].filter(Boolean).join(" "))
  };
}

function firstValue(...values) {
  for (const value of values) {
    const unwrapped = value && typeof value === "object" ? value.value || value.answer || value.label : value;
    if (unwrapped !== undefined && unwrapped !== null && String(unwrapped).trim()) return String(unwrapped).trim();
  }
  return "";
}

function appointmentSummary(payload) {
  return [
    `Title: ${payload.title || "Introductory Phone Call"}`,
    `Start: ${payload.startTime || payload.start_time || "not provided"}`,
    `End: ${payload.endTime || payload.end_time || "not provided"}`,
    "Location: attendee phone number"
  ].join("\n");
}

function env(name) {
  try {
    const value = globalThis.Netlify?.env?.get?.(name);
    if (value) return value;
  } catch { /* local fallback */ }
  return process.env[name];
}

function errorMessage(error) { return String(error?.message || error).slice(0, 500); }
