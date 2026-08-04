/* Protected one-time GHL → HubSpot migration.

   Dry run:
     GET /.netlify/functions/ghl-hubspot-backfill?secret=...&mode=dry-run&limit=10
   Write run (requires both guards):
     POST /.netlify/functions/ghl-hubspot-backfill?secret=...&mode=write&confirm=IMPORT_GHL_TO_HUBSPOT

   The endpoint is intentionally guarded and capped per request. It is
   idempotent for contacts/deals and marks migrated tasks with their GHL ID.
   The response includes a continuation cursor for the next batch.
*/

import { json, requireSecret } from "./lib/http.mjs";
import {
  upsertContact, findContactById, findContactByGhlId,
  findDealByGhlId, findOpenDealForContact, createDeal, updateDeal,
  createNote, createTask, searchNotesByMarker, searchTasksByMarker
} from "./lib/hubspot.mjs";
import { DEAL_STAGES, assessAccreditation } from "./lib/hs-config.mjs";
import { getContactFieldMap, listContacts } from "./lib/ghl.mjs";

// Each contact may require several sequential GHL and HubSpot API calls.
// Keep synchronous requests comfortably below Netlify's function timeout.
const MAX_PER_REQUEST = 5;
const STAGE_BY_NAME = [
  ["new registration", DEAL_STAGES.NEW_REGISTRATION],
  ["new inquiry", DEAL_STAGES.NEW_REGISTRATION],
  ["consultation scheduled", DEAL_STAGES.CONSULTATION_SCHEDULED],
  ["reviewing opportunities", DEAL_STAGES.REVIEWING_OPPORTUNITIES],
  ["committed", DEAL_STAGES.COMMITTED],
  ["closed funded", DEAL_STAGES.CLOSED_FUNDED],
  ["closed won", DEAL_STAGES.CLOSED_FUNDED],
  ["closed lost", DEAL_STAGES.CLOSED_LOST]
];

export default async (req) => {
  if (!requireSecret(req, "HS_SETUP_SECRET")) return json({ error: "unauthorized" }, 401);
  if (!process.env.GHL_TOKEN || !process.env.GHL_LOCATION_ID || !process.env.HUBSPOT_TOKEN) {
    return json({ error: "GHL_TOKEN, GHL_LOCATION_ID, and HUBSPOT_TOKEN are required" }, 503);
  }
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "dry-run";
  const limit = Math.min(MAX_PER_REQUEST, Math.max(1, Number(url.searchParams.get("limit") || 25)));
  let startAfterId = url.searchParams.get("startAfterId") || undefined;
  let startAfter = url.searchParams.get("startAfter") || undefined;
  if (mode === "write" && (req.method !== "POST" || url.searchParams.get("confirm") !== "IMPORT_GHL_TO_HUBSPOT")) {
    return json({ error: "write mode requires POST and confirm=IMPORT_GHL_TO_HUBSPOT" }, 400);
  }
  if (mode === "write" && process.env.HUBSPOT_MIGRATION_ENABLED !== "true") {
    return json({ error: "HUBSPOT_MIGRATION_ENABLED is not true" }, 403);
  }

  const fieldMap = await getContactFieldMap();
  const stats = { mode, scannedContacts: 0, contactsCreatedOrUpdated: 0, opportunitiesCreatedOrUpdated: 0, tasksCreated: 0, notesCreated: 0, skipped: 0, errors: [] };
  const seen = new Set();

  do {
    const page = await listContacts({ limit, startAfterId, startAfter });
    const contacts = page.contacts || [];
    for (const contact of contacts) {
      if (stats.scannedContacts >= limit || seen.has(contact.id)) break;
      seen.add(contact.id);
      stats.scannedContacts++;
      try {
        await migrateContact(contact, fieldMap, mode, stats);
      } catch (error) {
        stats.errors.push({ kind: "contact", id: contact.id, message: String(error.message || error).slice(0, 180) });
      }
    }
    const meta = page.meta || {};
    startAfterId = meta.startAfterId;
    startAfter = meta.startAfter;
  } while (stats.scannedContacts < limit && (startAfterId || startAfter));

  return json({ ok: true, ...stats, nextStartAfterId: startAfterId || null, nextStartAfter: startAfter || null });
};

async function migrateContact(contact, fieldMap, mode, stats) {
  const values = readCustomFields(contact, fieldMap);
  const { lead_status: ghlLeadStatus, ...contactValues } = values;
  const accreditation = assessAccreditation(values.accreditation_check);
  const properties = clean({
    ghl_contact_id: contact.id,
    firstname: contact.firstName,
    lastname: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    company: contact.companyName,
    address: contact.address1,
    city: contact.city,
    state: contact.state || values.state_of_residence,
    zip: contact.postalCode,
    website: contact.website,
    contact_source: contact.source,
    contact_type: contact.type,
    ...contactValues,
    hs_lead_status: mapLeadStatus(ghlLeadStatus, accreditation.leadStatus),
    lifecyclestage: mapLifecycle(ghlLeadStatus)
  });
  if (mode === "dry-run") {
    stats.contactsCreatedOrUpdated++;
  } else {
    const contactRecord = await upsertContact(contact.email, properties);
    if (!contactRecord?.id) throw new Error("HubSpot contact upsert failed");
    stats.contactsCreatedOrUpdated++;
    await migrateContactActivities(contact, contactRecord.id, mode, stats);
    return;
  }

  // Dry-run still checks that the GHL activity endpoints are readable, but does
  // not write CRM data.
  await listContactOpportunities(contact.id);
  await listContactTasks(contact.id);
  await listContactNotes(contact.id);
}

async function migrateContactActivities(contact, hubspotContactId, mode, stats) {
  const opportunities = await listContactOpportunities(contact.id);
  const dealId = await migrateOpportunities(opportunities, hubspotContactId, stats);
  const notes = await listContactNotes(contact.id);
  for (const note of notes) {
    const marker = `[GHL note:${note.id || "unknown"}]`;
    if (note.id && (await searchNotesByMarker(marker)).length) continue;
    await createNote({
      body: noteBody(note),
      contactId: hubspotContactId,
      dealId,
      timestamp: note.dateAdded || note.createdAt
    });
    stats.notesCreated++;
  }
  const tasks = await listContactTasks(contact.id);
  for (const task of tasks) {
    const marker = `[GHL task:${task.id}]`;
    const existing = await searchTasksByMarker(marker);
    if (existing.length) continue;
    await createTask({
      title: task.title || task.name || "GHL task",
      body: task.body || task.description || "",
      dueDate: task.dueDate || task.due_date,
      startDate: task.startDate || task.start_date,
      completed: Boolean(task.completed),
      priority: task.priority,
      contactId: hubspotContactId,
      dealId,
      marker
    });
    stats.tasksCreated++;
  }
}

async function migrateOpportunities(opportunities, contactId, stats) {
  let firstDealId = null;
  for (const opportunity of opportunities) {
    const properties = clean({
      dealname: opportunity.name || "GHL Opportunity",
      amount: number(opportunity.monetaryValue),
      pipeline: "default",
      dealstage: stageFor(opportunity),
      closedate: opportunity.forecastExpectedCloseDate || opportunity.forecastExpectedCloseDate,
      ghl_opportunity_id: opportunity.id,
      ghl_pipeline_id: opportunity.pipelineId,
      ghl_stage_name: stageName(opportunity),
      ghl_status: opportunity.status,
      ghl_source: opportunity.source,
      situation: opportunity.customFields?.situation,
      closing_date: opportunity.customFields?.closing_date,
      equity: number(opportunity.customFields?.equity),
      debt: number(opportunity.customFields?.debt),
      anticipated_investment: number(opportunity.customFields?.anticipated_investment),
      in_place_ltv: number(opportunity.customFields?.in_place_ltv),
      total_investment_size: number(opportunity.customFields?.total_investment_size),
      deadline_45: opportunity.customFields?.deadline_45,
      deadline_180: opportunity.customFields?.deadline_180,
      routed_to: opportunity.customFields?.routed_to
    });
    const existing = await findDealByGhlId(opportunity.id) || (isOpen(opportunity) ? await findOpenDealForContact(contactId) : null);
    const deal = existing
      ? await updateDeal(existing.id, properties)
      : await createDeal(properties, contactId);
    if (deal?.id) { firstDealId ||= deal.id; stats.opportunitiesCreatedOrUpdated++; }
  }
  return firstDealId;
}

function readCustomFields(contact, fieldMap) {
  const byId = new Map((contact.customFields || []).map((field) => [field.id, field.value ?? field.field_value ?? field.fieldValue]));
  const get = (name) => {
    const id = fieldMap[String(name).trim().toLowerCase()];
    return id ? byId.get(id) : undefined;
  };
  const role = normalizeRole(get("Role"));
  const dstFamiliarity = normalizeDstFamiliarity(get("DST Familiarity"));
  return clean({
    preferred_name: get("Preferred Name"),
    state_of_residence: get("State of Residence"),
    ...role,
    marital_status: get("Marital Status"),
    household_income: get("Household Income"),
    net_worth: get("Net Worth"),
    ...dstFamiliarity,
    current_plan: get("Current Plan (Where DSTs Fit)"),
    us_check: get("US Check"),
    accreditation_check: get("Accreditation Check"),
    portal_access: get("Portal Access"),
    sms_consent: get("SMS Consent"),
    situation: get("Situation"),
    closing_date: get("Closing Date"),
    equity: number(get("Equity")),
    debt: number(get("Debt")),
    anticipated_investment: number(get("Anticipated Investment")),
    in_place_ltv: number(get("In-Place LTV %")),
    total_investment_size: number(get("Total Investment Size")),
    deadline_45: get("45-Day Deadline"),
    deadline_180: get("180-Day Deadline"),
    routed_to: get("Routed To"),
    crs_delivery_date: get("CRS Delivery Date"),
    lead_status: get("Lead Status")
  });
}

async function listContactOpportunities(contactId) {
  const result = await ghl(`/opportunities/search`, { query: { location_id: process.env.GHL_LOCATION_ID, contact_id: contactId, page: 1, limit: 100 } });
  return result.data?.opportunities || [];
}

async function listContactTasks(contactId) {
  const result = await ghl(`/contacts/${encodeURIComponent(contactId)}/tasks`);
  const tasks = result.data?.tasks || result.data?.data || result.data || [];
  return Array.isArray(tasks) ? tasks : [];
}

async function listContactNotes(contactId) {
  const result = await ghl(`/contacts/${encodeURIComponent(contactId)}/notes`);
  const notes = result.data?.notes || result.data?.data || result.data || [];
  return Array.isArray(notes) ? notes : [];
}

async function ghl(path, { method = "GET", body, query } = {}) {
  const url = new URL("https://services.leadconnectorhq.com" + path);
  if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${process.env.GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await response.json(); } catch { /* empty */ }
  if (!response.ok) throw new Error(`GHL ${method} ${path} returned ${response.status}`);
  return { data };
}

function stageName(opportunity) {
  return opportunity.pipelineStageName || opportunity.stageName || opportunity.pipelineStageId || "";
}
function stageFor(opportunity) {
  const name = String(stageName(opportunity)).trim().toLowerCase();
  return STAGE_BY_NAME.find(([label]) => name === label)?.[1] || (String(opportunity.status).toLowerCase() === "won" ? DEAL_STAGES.CLOSED_FUNDED : String(opportunity.status).toLowerCase() === "lost" ? DEAL_STAGES.CLOSED_LOST : DEAL_STAGES.NEW_REGISTRATION);
}
function isOpen(opportunity) { return !["won", "lost", "abandoned"].includes(String(opportunity.status || "open").toLowerCase()); }
function mapLeadStatus(value, fallback) {
  const v = String(value || "").toLowerCase();
  if (v.includes("scheduled")) return "OPEN";
  if (v.includes("no-show")) return "IN_PROGRESS";
  if (v.includes("approved")) return "OPEN_DEAL";
  if (v.includes("unqualified")) return "UNQUALIFIED";
  return fallback;
}
function mapLifecycle(value) { return /approved|scheduled/i.test(String(value || "")) ? "salesqualifiedlead" : "lead"; }
function noteBody(note) { return `[GHL note:${note.id || "unknown"}]\n${note.body || note.content || note.note || ""}`; }
function normalizeRole(value) {
  const raw = String(value || "").trim();
  if (!raw) return {};
  const allowed = new Set(["Investor", "Broker", "Financial Advisor", "CPA", "Attorney", "Qualified Intermediary", "Real Estate Agent", "Family Member / Assisting an Investor", "Other"]);
  if (allowed.has(raw)) return { investor_role: raw };
  const parts = raw.split(/\s+—\s+/);
  const base = parts[0].trim();
  if (allowed.has(base)) return { investor_role: base, role_other: parts.slice(1).join(" — ") || undefined };
  return { investor_role: "Other", role_other: raw };
}
function normalizeDstFamiliarity(value) {
  const raw = String(value || "").trim();
  if (!raw) return {};
  const allowed = new Set(["New to DSTs", "Somewhat familiar", "Very familiar", "Experienced DST investor"]);
  if (allowed.has(raw)) return { dst_familiarity: raw };
  const lower = raw.toLowerCase();
  const mapped = /new to|new with|not familiar|unfamiliar/.test(lower)
    ? "New to DSTs"
    : /experienced|sophisticated/.test(lower)
      ? "Experienced DST investor"
      : /very familiar|highly familiar|knowledgeable/.test(lower)
        ? "Very familiar"
        : "Somewhat familiar";
  return { dst_familiarity: mapped, dst_familiarity_details: raw };
}
function number(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") value = value.value ?? value.field_value ?? value.fieldValue;
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}
function clean(values) { return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")); }
