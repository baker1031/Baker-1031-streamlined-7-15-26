/* Optional GHL workflow webhook for stage/task changes after the backfill.
   Configure a GHL Custom Webhook action to POST here with
   ?secret=<GHL_WEBHOOK_SECRET>. The one-time backfill remains the source for
   historical records; this endpoint keeps later GHL changes flowing. */

import { json } from "./lib/http.mjs";
import {
  upsertContact, findContactByGhlId, findDealByGhlId, findOpenDealForContact,
  createDeal, updateDeal, createTask, searchTasksByMarker
} from "./lib/hubspot.mjs";
import { DEAL_STAGES } from "./lib/hs-config.mjs";
import { properName } from "./lib/name.mjs";
import { resolvePipeline } from "./lib/ghl.mjs";
import { PIPELINE_NAME } from "./lib/ghl-config.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret || new URL(req.url).searchParams.get("secret") !== secret) return json({ error: "forbidden" }, 403);
  if (!process.env.HUBSPOT_TOKEN) return json({ ok: true, note: "HubSpot not configured" });

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const source = body.contact || body.customData || body;
  const email = String(source.email || body.email || "").trim().toLowerCase();
  const ghlContactId = source.id || source.contactId || body.contactId;
  const contact = email || ghlContactId
    ? await upsertContact(email, clean({
        ghl_contact_id: ghlContactId,
        firstname: properName(source.firstName || source.first_name),
        lastname: properName(source.lastName || source.last_name),
        phone: source.phone,
        company: source.companyName,
        contact_source: source.source
      }))
    : null;
  const contactId = contact?.id || (ghlContactId && (await findContactByGhlId(ghlContactId))?.id);

  const opportunity = body.opportunity || body.opportunities?.[0] || null;
  let deal = null;
  if (opportunity?.id && contactId) {
    const ghlPipeline = await resolvePipeline(PIPELINE_NAME).catch(() => null);
    const incomingStage = stageLabel(opportunity, ghlPipeline);
    const props = clean({
      dealname: opportunity.name,
      amount: opportunity.monetaryValue,
      pipeline: "default",
      dealstage: mapStage(incomingStage, opportunity.status),
      ghl_opportunity_id: opportunity.id,
      ghl_pipeline_id: opportunity.pipelineId,
      ghl_stage_name: incomingStage,
      ghl_status: opportunity.status,
      ghl_source: opportunity.source
    });
    const existing = await findDealByGhlId(opportunity.id) || (await findOpenDealForContact(contactId));
    deal = existing ? await updateDeal(existing.id, props) : await createDeal(props, contactId);
  }

  const task = body.task || body.tasks?.[0];
  let taskCreated = false;
  if (task?.id && contactId) {
    const marker = `[GHL task:${task.id}]`;
    if (!(await searchTasksByMarker(marker)).length) {
      taskCreated = Boolean(await createTask({
        title: task.title || task.name || "GHL task",
        body: task.body || task.description,
        dueDate: task.dueDate || task.due_date,
        startDate: task.startDate || task.start_date,
        completed: Boolean(task.completed),
        priority: task.priority,
        contactId,
        dealId: deal?.id,
        marker
      }));
    }
  }
  return json({ ok: true, contact: Boolean(contactId), deal: Boolean(deal?.id), taskCreated });
};

function mapStage(stage, status) {
  const value = String(stage || "").toLowerCase();
  if (/closed.?lost|lost/.test(value) || String(status).toLowerCase() === "lost") return DEAL_STAGES.CLOSED_LOST;
  if (/closed.?won|closed funded|won/.test(value) || String(status).toLowerCase() === "won") return DEAL_STAGES.CLOSED_FUNDED;
  if (/consultation|appointment/.test(value)) return DEAL_STAGES.CONSULTATION_SCHEDULED;
  if (/review/.test(value)) return DEAL_STAGES.REVIEWING_OPPORTUNITIES;
  if (/commit/.test(value)) return DEAL_STAGES.COMMITTED;
  return DEAL_STAGES.NEW_REGISTRATION;
}
function stageLabel(opportunity, ghlPipeline) {
  const direct = opportunity.pipelineStageName || opportunity.stageName || "";
  const id = opportunity.pipelineStageId || direct;
  return ghlPipeline?.stageNames?.[String(id)] || direct || id;
}
function clean(values) { return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")); }
