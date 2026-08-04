/* Shared live GHL -> HubSpot mapping.  GHL remains the workflow source;
   HubSpot receives the same contact fields, ownership metadata, tags, and
   normalized enum values so free CRM records remain valid and searchable. */

import { upsertContact as upsertHubSpotContact } from "./hubspot.mjs";
import { getContactFieldCatalog } from "./ghl.mjs";
import { assessAccreditation } from "./hs-config.mjs";
import { properName } from "./name.mjs";

export async function mirrorGhlContact(contact, overrides = {}) {
  if (!contact) return null;
  const catalog = await getContactFieldCatalog();
  const values = readCustomFields(contact, catalog);
  const accreditation = assessAccreditation(values.accreditation_check);
  const email = cleanEmail(contact.email);
  const properties = clean({
    ghl_contact_id: contact.id,
    firstname: properName(contact.firstName || contact.first_name),
    lastname: properName(contact.lastName || contact.last_name),
    email,
    phone: contact.phone,
    company: contact.companyName || contact.company,
    address: contact.address1 || contact.address,
    city: contact.city,
    state: contact.state || values.state_of_residence,
    zip: contact.postalCode || contact.zip,
    website: contact.website,
    contact_source: contact.source,
    contact_type: contact.type,
    ghl_tags: Array.isArray(contact.tags) ? contact.tags.join(", ") : contact.tags,
    ghl_assigned_to: contact.assignedTo || contact.assigned_to,
    ...values,
    hs_lead_status: accreditation.leadStatus,
    lifecyclestage: /approved|scheduled/i.test(String(values.lead_status || "")) ? "salesqualifiedlead" : "lead",
    ...overrides
  });
  if (!email && !properties.phone) return null;
  return upsertHubSpotContact(email || null, properties);
}

export function readCustomFields(contact, catalog) {
  const fields = Array.isArray(contact.customFields)
    ? contact.customFields
    : Array.isArray(contact.customField) ? contact.customField : [];
  const byId = new Map(fields.map((field) => [String(field.id), field.value ?? field.field_value ?? field.fieldValue]));
  const get = (name) => {
    const id = catalog.byName[String(name).trim().toLowerCase()];
    return id ? byId.get(String(id)) : undefined;
  };
  const role = normalizeRole(get("Role"));
  const familiarity = normalizeDstFamiliarity(get("DST Familiarity"));
  const plan = normalizeCurrentPlan(get("Current Plan (Where DSTs Fit)"));
  return clean({
    preferred_name: get("Preferred Name"),
    state_of_residence: get("State of Residence"),
    ...role,
    marital_status: get("Marital Status"),
    household_income: get("Household Income"),
    net_worth: get("Net Worth"),
    ...familiarity,
    ...plan,
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

function normalizeRole(value) {
  const raw = String(value || "").trim();
  if (!raw) return {};
  const allowed = new Set(["Investor", "Broker", "Financial Advisor", "CPA", "Attorney", "Qualified Intermediary", "Real Estate Agent", "Family Member / Assisting an Investor", "Other"]);
  if (allowed.has(raw)) return { investor_role: raw };
  const parts = raw.split(/\s+—\s+/);
  const base = parts[0].trim();
  return allowed.has(base)
    ? { investor_role: base, role_other: parts.slice(1).join(" — ") || undefined }
    : { investor_role: "Other", role_other: raw };
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

function normalizeCurrentPlan(value) {
  const raw = String(value || "").trim();
  if (!raw) return {};
  const allowed = new Set(["DSTs are my main focus", "Exploring DSTs alongside other options", "Not really interested in DSTs"]);
  if (allowed.has(raw)) return { current_plan: raw };
  const lower = raw.toLowerCase();
  const mapped = /not interested|no dst|without dst|avoid dst/.test(lower)
    ? "Not really interested in DSTs"
    : /main focus|primarily dst|only dst/.test(lower)
      ? "DSTs are my main focus"
      : "Exploring DSTs alongside other options";
  return { current_plan: mapped, current_plan_details: raw };
}

function number(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}
function cleanEmail(value) { return String(value || "").trim().toLowerCase(); }
function clean(values) { return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")); }
