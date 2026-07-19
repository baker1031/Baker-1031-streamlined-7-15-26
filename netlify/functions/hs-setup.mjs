/* ============================================================
   ONE-TIME HubSpot setup (run once, then idempotent — safe to re-hit).
   Creates the "Baker 1031" property group + all custom Contact and
   Deal properties that mirror the Pipedrive fields (see pd-setup.mjs),
   so the submission-created dual-write has somewhere to land.

   Call:  GET /.netlify/functions/hs-setup?secret=<HS_SETUP_SECRET>
   Env:   HUBSPOT_TOKEN     (pat-na2-… private app token; schemas write)
          HS_SETUP_SECRET   (shared secret; URL must include ?secret=...)

   Pick-list fields are created as TEXT for now so no submission is ever
   rejected for an unlisted option; upgrade to dropdowns once we extract
   the full option sets from Pipedrive. Portal Access is the exception:
   a Yes/No enum, because the Kinde sync keys off it.
   ============================================================ */

import { json, requireSecret } from "./lib/http.mjs";

const BASE = "https://api.hubapi.com";
const GROUP = { name: "baker1031", label: "Baker 1031" };

const T = (name, label) => ({ name, label, type: "string", fieldType: "text" });
const D = (name, label) => ({ name, label, type: "date", fieldType: "date" });
const N = (name, label, currency = false) =>
  ({ name, label, type: "number", fieldType: "number", ...(currency ? { showCurrencySymbol: true } : {}) });

// Contact — mirrors pd-setup PERSON_FIELDS (12)
const CONTACT_PROPS = [
  T("preferred_name", "Preferred name"),
  T("state_of_residence", "State of residence"),
  T("investor_role", "Role"),
  T("marital_status", "Marital status"),
  T("household_income", "Household income"),
  T("net_worth", "Net worth"),
  T("dst_familiarity", "DST familiarity"),
  T("current_plan", "Current plan (where DSTs fit)"),
  T("us_check", "US check"),
  T("accreditation_check", "Accreditation check"),
  { name: "portal_access", label: "Portal Access", type: "enumeration", fieldType: "select",
    options: [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }] },
  D("crs_delivery_date", "CRS delivery date")
];

// Deal — mirrors pd-setup DEAL_FIELDS (10)
const DEAL_PROPS = [
  T("situation", "Situation"),
  D("closing_date", "Closing date"),
  N("equity", "Equity", true),
  N("debt", "Debt", true),
  N("anticipated_investment", "Anticipated investment", true),
  N("in_place_ltv", "In-place LTV %"),
  N("total_investment_size", "Total investment size", true),
  D("deadline_45", "45-day deadline"),
  D("deadline_180", "180-day deadline"),
  T("routed_to", "Routed to")
];

export default async (req) => {
  if (!requireSecret(req, "HS_SETUP_SECRET")) return json({ error: "unauthorized" }, 401);
  if (!process.env.HUBSPOT_TOKEN) return json({ error: "HUBSPOT_TOKEN not set" }, 503);

  const out = { group: {}, contacts: [], deals: [] };
  out.group.contacts = await ensureGroup("contacts");
  for (const p of CONTACT_PROPS) out.contacts.push(await ensureProp("contacts", p));
  out.group.deals = await ensureGroup("deals");
  for (const p of DEAL_PROPS) out.deals.push(await ensureProp("deals", p));
  return json(out);
};

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {}; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function ensureGroup(objectType) {
  const res = await api("POST", `/crm/v3/properties/${objectType}/groups`, GROUP);
  return res.status === 201 ? "created" : res.status === 409 ? "exists" : `err ${res.status}`;
}

async function ensureProp(objectType, prop) {
  const check = await api("GET", `/crm/v3/properties/${objectType}/${prop.name}`);
  if (check.status === 200) return `${prop.name}: exists`;
  const res = await api("POST", `/crm/v3/properties/${objectType}`, { ...prop, groupName: GROUP.name });
  if (res.status === 201) return `${prop.name}: created`;
  return `${prop.name}: FAIL ${res.status} ${JSON.stringify((res.data && res.data.message) || "")}`;
}
