/* ============================================================
   GoHighLevel config — single source of truth for the GHL CRM
   automation (form dual-write, booking webhook, portal-access poller).

   DESIGN NOTE: GHL opportunity custom fields are unreliable via the API,
   so ALL investor + deal data is stored as CONTACT custom fields. The
   GHL opportunity stays lightweight: name + monetary value + pipeline
   stage. This mirrors the HubSpot/Pipedrive data but on one object.

   Fields are created by ghl-setup.mjs. Option/pick-list fields are TEXT
   (so an unlisted answer is never rejected) EXCEPT Portal Access and
   Lead Status, which are SINGLE_OPTIONS because we set/read known values.
   Money fields are NUMERICAL for reliable creation; switch to monetary
   in the GHL UI later if you want the currency symbol (no data loss).
   ============================================================ */

export const PIPELINE_NAME = "1031 / DST Placement";

// Stage display names (resolved to stage IDs at runtime by lib/ghl.mjs).
export const STAGES = {
  ENTRY:        "New Registration",        // form submit lands here
  CONSULTATION: "Consultation Scheduled",  // booking moves here
  REVIEWING:    "Reviewing Opportunities"  // post-consult (native GHL workflow)
};

// Lead Status option values (the SINGLE_OPTIONS field "Lead Status").
export const LEAD_STATUS = {
  APPROVAL_PENDING:     "Approval Pending",
  INTRO_CALL_SCHEDULED: "Intro Call Scheduled",
  NO_SHOW:              "No-Show",
  APPROVED:             "Approved",
  UNQUALIFIED:          "Unqualified",
  COLD:                 "Cold"
};

export const PORTAL_FIELD_NAME = "Portal Access"; // drives the Kinde sync

// Contact custom fields. `key` is the logical name used in code; `name`
// is the GHL display name (also how we resolve the field id at runtime).
const T = (key, name) => ({ key, name, dataType: "TEXT" });
const D = (key, name) => ({ key, name, dataType: "DATE" });
const N = (key, name) => ({ key, name, dataType: "NUMERICAL" });

export const CONTACT_FIELDS = [
  // --- person ---
  T("preferred_name",        "Preferred Name"),
  T("state_of_residence",    "State of Residence"),
  T("investor_role",         "Role"),
  T("marital_status",        "Marital Status"),
  T("household_income",      "Household Income"),
  T("net_worth",             "Net Worth"),
  T("dst_familiarity",       "DST Familiarity"),
  T("current_plan",          "Current Plan (Where DSTs Fit)"),
  T("us_check",              "US Check"),
  T("accreditation_check",   "Accreditation Check"),
  D("crs_delivery_date",     "CRS Delivery Date"),
  { key: "portal_access", name: PORTAL_FIELD_NAME, dataType: "SINGLE_OPTIONS", options: ["Yes", "No"] },
  { key: "lead_status",   name: "Lead Status",     dataType: "SINGLE_OPTIONS",
    options: Object.values(LEAD_STATUS) },
  { key: "sms_consent",   name: "SMS Consent",     dataType: "SINGLE_OPTIONS", options: ["Yes", "No"] },
  // --- deal (kept on the contact) ---
  T("situation",             "Situation"),
  D("closing_date",          "Closing Date"),
  N("equity",                "Equity"),
  N("debt",                  "Debt"),
  N("anticipated_investment","Anticipated Investment"),
  N("in_place_ltv",          "In-Place LTV %"),
  N("total_investment_size", "Total Investment Size"),
  D("deadline_45",           "45-Day Deadline"),
  D("deadline_180",          "180-Day Deadline"),
  T("routed_to",             "Routed To")
];

/* Build the GHL customFields array [{ id, field_value }] from a
   { logicalKey: value } object, using a runtime name→id map. Skips
   empty/undefined values and any field whose id we couldn't resolve. */
export function buildContactFields(fieldMap, values) {
  const out = [];
  for (const f of CONTACT_FIELDS) {
    const v = values[f.key];
    if (v === undefined || v === null || v === "") continue;
    const id = fieldMap[f.name.trim().toLowerCase()];
    if (!id) continue;
    out.push({ id, field_value: v });
  }
  return out;
}

/* Opening lead status from the accreditation answer (mirrors the
   HubSpot assessAccreditation, minus the lifecycle stage GHL lacks). */
export function assessAccreditation(accreditationCheck) {
  const v = String(accreditationCheck || "").trim().toLowerCase();
  if (!v) return { leadStatus: LEAD_STATUS.APPROVAL_PENDING };
  // Check negation FIRST, so "not accredited" / "does not appear accredited"
  // isn't misread as Approved just because it contains the word "accredited".
  if (/\b(not|no|none|unqualified|non-?accredited|false)\b/.test(v)) return { leadStatus: LEAD_STATUS.UNQUALIFIED };
  if (/\b(accredited|qualified|yes|true|confirm)\b/.test(v))         return { leadStatus: LEAD_STATUS.APPROVED };
  return { leadStatus: LEAD_STATUS.APPROVAL_PENDING };
}
