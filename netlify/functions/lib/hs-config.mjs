/* HubSpot mapping for the Baker 1031 GHL mirror. */

export const PIPELINE = "default";

// HubSpot's default deal pipeline stages are used as the stable target IDs.
// GHL's display labels remain in the mirrored custom properties.
export const DEAL_STAGES = {
  NEW_REGISTRATION: "appointmentscheduled",
  CONSULTATION_SCHEDULED: "qualifiedtobuy",
  REVIEWING_OPPORTUNITIES: "presentationscheduled",
  COMMITTED: "decisionmakerboughtin",
  CLOSED_FUNDED: "closedwon",
  CLOSED_LOST: "closedlost"
};

export const LEAD_STATUS = {
  APPROVAL_PENDING: "NEW",
  INTRO_CALL_SCHEDULED: "OPEN",
  NO_SHOW: "IN_PROGRESS",
  APPROVED: "OPEN_DEAL",
  UNQUALIFIED: "UNQUALIFIED",
  COLD: "ATTEMPTED_TO_CONTACT"
};

export const LIFECYCLE = {
  LEAD: "lead",
  SQL: "salesqualifiedlead",
  CUSTOMER: "customer"
};

export function assessAccreditation(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return { leadStatus: LEAD_STATUS.APPROVAL_PENDING, lifecycle: LIFECYCLE.LEAD };
  if (/\b(not|no|none|unqualified|non-?accredited|false)\b/.test(v)) {
    return { leadStatus: LEAD_STATUS.UNQUALIFIED, lifecycle: LIFECYCLE.LEAD };
  }
  if (/\b(accredited|qualified|yes|true|confirm)\b/.test(v)) {
    return { leadStatus: LEAD_STATUS.APPROVED, lifecycle: LIFECYCLE.SQL };
  }
  return { leadStatus: LEAD_STATUS.APPROVAL_PENDING, lifecycle: LIFECYCLE.LEAD };
}

export const CONTACT_PROPERTY_DEFINITIONS = [
  string("ghl_contact_id", "GHL Contact ID"),
  string("ghl_tags", "GHL Tags"),
  string("ghl_assigned_to", "GHL Assigned User"),
  string("preferred_name", "Preferred Name"),
  string("state_of_residence", "State of Residence"),
  enumeration("investor_role", "Role", ["Investor", "Broker", "Financial Advisor", "CPA", "Attorney", "Qualified Intermediary", "Real Estate Agent", "Family Member / Assisting an Investor", "Other"]),
  string("role_other", "Role — details"),
  string("marital_status", "Marital Status"),
  enumeration("household_income", "Household Income", ["Under $200,000", "$200,000 – $300,000", "$300,000 – $500,000", "$500,000 – $1,000,000", "Over $1,000,000"]),
  enumeration("net_worth", "Net Worth", ["Under $1,000,000", "$1,000,000 – $2,500,000", "$2,500,000 – $5,000,000", "$5,000,000 – $10,000,000", "Over $10,000,000"]),
  enumeration("dst_familiarity", "DST Familiarity", ["New to DSTs", "Somewhat familiar", "Very familiar", "Experienced DST investor"]),
  string("dst_familiarity_details", "DST Familiarity — details"),
  enumeration("current_plan", "Current Plan (Where DSTs Fit)", ["DSTs are my main focus", "Exploring DSTs alongside other options", "Not really interested in DSTs"]),
  string("current_plan_details", "Current Plan — details"),
  string("us_check", "US Check"),
  string("accreditation_check", "Accreditation Check"),
  enumeration("portal_access", "Portal Access", ["Yes", "No"]),
  enumeration("sms_consent", "SMS Consent", ["Yes", "No"]),
  string("situation", "Situation"),
  string("contact_type", "Contact Type"),
  string("contact_source", "Contact Source"),
  date("crs_delivery_date", "CRS Delivery Date"),
  date("closing_date", "Closing Date"),
  number("equity", "Equity"),
  number("debt", "Debt"),
  number("anticipated_investment", "Anticipated Investment"),
  number("in_place_ltv", "In-Place LTV %"),
  number("total_investment_size", "Total Investment Size"),
  date("deadline_45", "45-Day Deadline"),
  date("deadline_180", "180-Day Deadline"),
  string("routed_to", "Routed To")
];

export const DEAL_PROPERTY_DEFINITIONS = [
  string("ghl_opportunity_id", "GHL Opportunity ID"),
  string("ghl_pipeline_id", "GHL Pipeline ID"),
  string("ghl_stage_name", "GHL Stage"),
  string("ghl_status", "GHL Status"),
  string("ghl_source", "GHL Source"),
  string("situation", "Situation"),
  date("closing_date", "Closing Date"),
  number("equity", "Equity"),
  number("debt", "Debt"),
  number("anticipated_investment", "Anticipated Investment"),
  number("in_place_ltv", "In-Place LTV %"),
  number("total_investment_size", "Total Investment Size"),
  date("deadline_45", "45-Day Deadline"),
  date("deadline_180", "180-Day Deadline"),
  string("routed_to", "Routed To")
];

function string(name, label) { return { name, label, type: "string", fieldType: "text" }; }
function number(name, label) { return { name, label, type: "number", fieldType: "number" }; }
function date(name, label) { return { name, label, type: "date", fieldType: "date" }; }
function enumeration(name, label, values) {
  return {
    name, label, type: "enumeration", fieldType: "select",
    options: values.map((value, displayOrder) => ({ label: value, value, displayOrder, hidden: false }))
  };
}
