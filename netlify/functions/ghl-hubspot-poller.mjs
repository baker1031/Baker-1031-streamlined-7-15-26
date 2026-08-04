/* Scheduled GHL -> HubSpot backstop.

   GHL custom webhooks provide fast delivery for the published workflows. This
   poller catches changes when a workflow is edited, a user changes a record
   manually, or an activity arrives without a webhook action. It processes a
   small cursor-based batch on each run to stay below Netlify's scheduled
   function timeout.
*/

import { getStore } from "@netlify/blobs";
import {
  createDeal, createNote, createTask, findDealByGhlId, findOpenDealForContact,
  searchNotesByMarker, searchTasksByMarker, updateDeal
} from "./lib/hubspot.mjs";
import { ghl, listContacts, resolvePipeline } from "./lib/ghl.mjs";
import { PIPELINE_NAME } from "./lib/ghl-config.mjs";
import { DEAL_STAGES } from "./lib/hs-config.mjs";
import { mirrorGhlContact } from "./lib/ghl-hubspot-sync.mjs";

const BATCH_SIZE = 3;
const STORE = "ghl-hubspot-poller";

export default async () => {
  if (!process.env.GHL_TOKEN || !process.env.HUBSPOT_TOKEN) {
    console.log("ghl-hubspot-poller: GHL_TOKEN and HUBSPOT_TOKEN are required");
    return;
  }
  const store = getStore(STORE);
  const state = (await store.get("state", { type: "json" })) || { startAfterId: null, startAfter: null };
  const pipeline = await resolvePipeline(PIPELINE_NAME).catch(() => null);
  const page = await listContacts({ limit: BATCH_SIZE, startAfterId: state.startAfterId, startAfter: state.startAfter });
  const contacts = page.contacts || [];
  let mirrored = 0, deals = 0, tasks = 0, notes = 0, errors = 0;

  for (const contact of contacts) {
    try {
      const fingerprint = JSON.stringify({
        id: contact.id, updated: contact.dateUpdated || contact.updatedAt,
        email: contact.email, phone: contact.phone, tags: contact.tags,
        assignedTo: contact.assignedTo, customFields: contact.customFields
      });
      const prior = await store.get(`contact:${contact.id}`).catch(() => null);
      let hsContact = null;
      if (prior !== fingerprint) {
        hsContact = await mirrorGhlContact(contact);
        if (hsContact?.id) {
          mirrored++;
          await store.set(`contact:${contact.id}`, fingerprint);
        }
      } else {
        // The contact ID is stable; find the HubSpot record through the GHL ID
        // only when an activity needs an association.
        hsContact = await mirrorGhlContact(contact);
      }
      if (!hsContact?.id) continue;

      const opportunities = await listOpportunities(contact.id);
      let firstDeal = null;
      for (const opportunity of opportunities) {
        const props = clean({
          dealname: opportunity.name || "GHL Opportunity",
          amount: opportunity.monetaryValue,
          pipeline: "default",
          dealstage: mapStage(stageLabel(opportunity, pipeline), opportunity.status),
          ghl_opportunity_id: opportunity.id,
          ghl_pipeline_id: opportunity.pipelineId,
          ghl_stage_name: stageLabel(opportunity, pipeline),
          ghl_status: opportunity.status,
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
        const existing = await findDealByGhlId(opportunity.id) || (isOpen(opportunity) ? await findOpenDealForContact(hsContact.id) : null);
        const deal = existing ? await updateDeal(existing.id, props) : await createDeal(props, hsContact.id);
        if (deal?.id || existing?.id) { deals++; firstDeal ||= deal || existing; }
      }

      for (const note of await listNotes(contact.id)) {
        const marker = `[GHL note:${note.id || "unknown"}]`;
        if (!note.id || (await store.get(`note:${note.id}`).catch(() => null)) || (await searchNotesByMarker(marker)).length) continue;
        if (await createNote({ body: `${marker}\n${note.body || note.content || note.note || ""}`, contactId: hsContact.id, dealId: firstDeal?.id, timestamp: note.dateAdded || note.createdAt })) {
          notes++;
          await store.set(`note:${note.id}`, new Date().toISOString());
        }
      }
      for (const task of await listTasks(contact.id)) {
        const marker = `[GHL task:${task.id}]`;
        if (!task.id || (await store.get(`task:${task.id}`).catch(() => null)) || (await searchTasksByMarker(marker)).length) continue;
        if (await createTask({
          title: task.title || task.name || "GHL task",
          body: task.body || task.description,
          dueDate: task.dueDate || task.due_date,
          startDate: task.startDate || task.start_date,
          completed: Boolean(task.completed), priority: task.priority,
          contactId: hsContact.id, dealId: firstDeal?.id, marker
        })) {
          tasks++;
          await store.set(`task:${task.id}`, new Date().toISOString());
        }
      }
    } catch (error) {
      errors++;
      console.error(`ghl-hubspot-poller: ${contact.id} failed`, String(error?.message || error).slice(0, 240));
    }
  }

  const meta = page.meta || {};
  if (meta.startAfterId || meta.startAfter) {
    await store.setJSON("state", { startAfterId: meta.startAfterId || null, startAfter: meta.startAfter || null });
  } else {
    await store.setJSON("state", { startAfterId: null, startAfter: null });
  }
  console.log(`ghl-hubspot-poller: ${mirrored} contacts, ${deals} deals, ${tasks} tasks, ${notes} notes, ${errors} error(s)`);
};

async function listOpportunities(contactId) {
  const result = await ghl("/opportunities/search", { query: { location_id: process.env.GHL_LOCATION_ID, contact_id: contactId, page: 1, limit: 100 } });
  return result.data?.opportunities || [];
}
async function listTasks(contactId) {
  const result = await ghl(`/contacts/${encodeURIComponent(contactId)}/tasks`);
  const tasks = result.data?.tasks || result.data?.data || result.data || [];
  return Array.isArray(tasks) ? tasks : [];
}
async function listNotes(contactId) {
  const result = await ghl(`/contacts/${encodeURIComponent(contactId)}/notes`);
  const notes = result.data?.notes || result.data?.data || result.data || [];
  return Array.isArray(notes) ? notes : [];
}
function stageLabel(opportunity, pipeline) {
  const direct = opportunity.pipelineStageName || opportunity.stageName || "";
  const id = opportunity.pipelineStageId || direct;
  return pipeline?.stageNames?.[String(id)] || direct || id;
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
function isOpen(opportunity) { return !["won", "lost", "abandoned"].includes(String(opportunity.status || "open").toLowerCase()); }
function clean(values) { return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")); }

export const config = { schedule: "*/5 * * * *" };
