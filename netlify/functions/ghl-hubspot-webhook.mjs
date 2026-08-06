/* Live GHL workflow -> HubSpot mirror.

   Add this as a Custom Webhook action to the published GHL workflows that
   change contacts or appointment status.  The endpoint is deliberately
   tolerant of GHL's payload variants and fetches the full contact from GHL
   when the webhook only supplies an ID.

   URL: https://baker1031.com/.netlify/functions/ghl-hubspot-webhook?secret=...
*/

import { json } from "./lib/http.mjs";
import {
  createDeal, createEmail, createNote, createTask, findDealByGhlId,
  findOpenDealForContact, searchEmailsByMarker, searchNotesByMarker,
  searchTasksByMarker, updateDeal
} from "./lib/hubspot.mjs";
import { DEAL_STAGES, LEAD_STATUS } from "./lib/hs-config.mjs";
import { getContactById, resolvePipeline } from "./lib/ghl.mjs";
import { PIPELINE_NAME } from "./lib/ghl-config.mjs";
import { mirrorGhlContact } from "./lib/ghl-hubspot-sync.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret || new URL(req.url).searchParams.get("secret") !== secret) {
    // Log loudly: a silent 403 here is indistinguishable from "nothing happened"
    // in the GHL execution log, which hid a two-day outage.
    console.warn(!secret
      ? "ghl-hubspot-webhook REJECTED: GHL_WEBHOOK_SECRET is not set in this deploy"
      : "ghl-hubspot-webhook REJECTED: ?secret does not match GHL_WEBHOOK_SECRET for this deploy. "
        + "Netlify bakes env vars in at deploy time — after rotating the value you must create a new deploy.");
    return json({ error: "forbidden" }, 403);
  }
  if (!process.env.HUBSPOT_TOKEN) return json({ ok: true, note: "HubSpot not configured" });

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const source = body.contact || body.customData || body;
  const contactId = body.contactId || body.contact_id || body.appointment?.contactId || body.appointment?.contact_id
    || source.contactId || source.contact_id || body.contact?.id || (!body.appointment && source.id);
  const fullContact = contactId ? await getContactById(contactId).catch(() => null) : null;
  const contact = mergeContact(fullContact, source);
  const noShow = isNoShow(body, source);
  const workflowName = String(body.workflowName || body.workflow_name || body.workflow?.name || "").toLowerCase();
  const contactOverrides = {
    ...(noShow ? { hs_lead_status: LEAD_STATUS.NO_SHOW, lifecyclestage: "lead", portal_access: "No" } : {}),
    ...(workflowName.includes("new contact") && process.env.HUBSPOT_DEFAULT_OWNER_ID
      ? { hubspot_owner_id: process.env.HUBSPOT_DEFAULT_OWNER_ID }
      : {})
  };

  const hsContact = contact?.id || contact?.email || contact?.phone
    ? await mirrorGhlContact(contact, contactOverrides)
    : null;
  const contactHsId = hsContact?.id || null;

  const pipeline = await resolvePipeline(PIPELINE_NAME).catch(() => null);
  const opportunities = asArray(body.opportunity || body.opportunities || contact?.opportunities);
  let deals = 0;
  for (const opportunity of opportunities) {
    if (!opportunity?.id || !contactHsId) continue;
    const stageName = stageLabel(opportunity, pipeline);
    const props = clean({
      dealname: opportunity.name || "GHL Opportunity",
      amount: opportunity.monetaryValue,
      pipeline: "default",
      dealstage: noShow ? undefined : mapStage(stageName, opportunity.status),
      ghl_opportunity_id: opportunity.id,
      ghl_pipeline_id: opportunity.pipelineId,
      ghl_stage_name: noShow ? (stageName || "No-Show") : stageName,
      ghl_status: noShow ? "no-show" : opportunity.status,
      ghl_source: opportunity.source,
      situation: opportunity.customFields?.situation,
      closing_date: opportunity.customFields?.closing_date,
      equity: opportunity.customFields?.equity,
      debt: opportunity.customFields?.debt,
      anticipated_investment: opportunity.customFields?.anticipated_investment,
      in_place_ltv: opportunity.customFields?.in_place_ltv,
      total_investment_size: opportunity.customFields?.total_investment_size,
      deadline_45: opportunity.customFields?.deadline_45,
      deadline_180: opportunity.customFields?.deadline_180,
      routed_to: opportunity.customFields?.routed_to
    });
    const existing = await findDealByGhlId(opportunity.id) || await findOpenDealForContact(contactHsId);
    const deal = existing ? await updateDeal(existing.id, props) : await createDeal(props, contactHsId);
    if (deal?.id || existing?.id) deals++;
  }

  const deal = opportunities.length && contactHsId
    ? (await findDealByGhlId(opportunities[0]?.id)) || await findOpenDealForContact(contactHsId)
    : await findOpenDealForContact(contactHsId);

  let tasksCreated = 0;
  for (const task of asArray(body.task || body.tasks || contact?.tasks)) {
    if (!task?.id || !contactHsId) continue;
    const marker = `[GHL task:${task.id}]`;
    if ((await searchTasksByMarker(marker)).length) continue;
    if (await createTask({
      title: task.title || task.name || "GHL task",
      body: task.body || task.description,
      dueDate: task.dueDate || task.due_date,
      startDate: task.startDate || task.start_date,
      completed: Boolean(task.completed),
      priority: task.priority,
      contactId: contactHsId,
      dealId: deal?.id,
      marker
    })) tasksCreated++;
  }

  let notesCreated = 0;
  for (const note of asArray(body.note || body.notes || contact?.notes)) {
    if (!contactHsId) continue;
    const marker = `[GHL note:${note.id || hashNote(note)}]`;
    if ((await searchNotesByMarker(marker)).length) continue;
    if (await createNote({
      body: `${marker}\n${note.body || note.content || note.note || ""}`,
      contactId: contactHsId,
      dealId: deal?.id,
      timestamp: note.dateAdded || note.createdAt || note.created_at
    })) notesCreated++;
  }

  let noShowEmail = "not-applicable";
  if (noShow && contactHsId) {
    const marker = `[GHL no-show:${body.appointmentId || body.appointment?.id || contact.id || contactHsId}]`;
    if (!(await searchEmailsByMarker(marker)).length) {
      await createEmail({
        subject: "No-show consultation follow-up",
        text: `${marker}\nThe GHL No Show workflow was triggered for this contact. The existing GHL email remains the outbound message until Resend is configured.`,
        contactId: contactHsId,
        dealId: deal?.id,
        timestamp: new Date().toISOString(),
        marker
      });
      noShowEmail = await sendResendNoShow(contact, marker);
    } else {
      noShowEmail = "already-logged";
    }
  }

  return json({ ok: true, contact: Boolean(contactHsId), deals, tasksCreated, notesCreated, noShow, noShowEmail });
};

function mergeContact(full, source) {
  if (!full && !source) return null;
  return { ...(full || {}), ...(source || {}), id: full?.id || source?.id || source?.contactId };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isNoShow(body, source) {
  const values = [
    body.eventType, body.event_type, body.appointmentStatus, body.appointment_status,
    body.status, body.appointment?.status, source?.appointmentStatus, source?.status
  ].filter(Boolean).join(" ").toLowerCase();
  return /no[ -]?show/.test(values);
}

function mapStage(stage, status) {
  const value = String(stage || "").toLowerCase();
  const state = String(status || "").toLowerCase();
  if (/closed.?lost|lost/.test(value) || state === "lost") return DEAL_STAGES.CLOSED_LOST;
  if (/closed.?won|closed funded|won/.test(value) || state === "won") return DEAL_STAGES.CLOSED_FUNDED;
  if (/consultation|appointment/.test(value)) return DEAL_STAGES.CONSULTATION_SCHEDULED;
  if (/review/.test(value)) return DEAL_STAGES.REVIEWING_OPPORTUNITIES;
  if (/paperwork|committed/.test(value)) return DEAL_STAGES.COMMITTED;
  if (/closing/.test(value)) return "contractsent";
  return DEAL_STAGES.NEW_REGISTRATION;
}

function stageLabel(opportunity, pipeline) {
  const direct = opportunity.pipelineStageName || opportunity.stageName || "";
  const id = opportunity.pipelineStageId || direct;
  return pipeline?.stageNames?.[String(id)] || direct || id;
}

function hashNote(note) {
  return String(note.body || note.content || note.note || "").slice(0, 40).replace(/\s+/g, "-");
}

function clean(values) { return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")); }

async function sendResendNoShow(contact, marker) {
  if (!process.env.RESEND_API_KEY || String(process.env.RESEND_NO_SHOW_ENABLED).toLowerCase() !== "true") return "not-configured";
  const to = String(contact?.email || "").trim().toLowerCase();
  if (!to) return "no-email";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || "Baker 1031 Investments <invest@baker1031.com>",
      to: [to],
      subject: "We missed you for your Baker 1031 consultation",
      text: `We missed you for your scheduled consultation. Please reply to this email or use your Baker 1031 scheduling link to choose another time.\n\n${marker}`
    })
  });
  if (!response.ok) return `resend-${response.status}`;
  return "sent";
}
