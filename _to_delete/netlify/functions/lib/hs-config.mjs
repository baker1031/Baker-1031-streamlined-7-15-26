/* ============================================================
   HubSpot pipeline + status configuration — single source of truth
   for the CRM automation (form-submit, Cal booking, no-show, and the
   consultation auto-advance poller).

   WHY THIS FILE: the automation writes internal IDs, not display labels.
   Deal-stage internal IDs are the HubSpot defaults and DON'T change when
   you rename a stage, so the DEAL_STAGES below are already correct for
   Jerry's renamed pipeline (New Inquiry, Consultation Scheduled, ...).

   LEAD_STATUS below now holds the ACTUAL internal values from Jerry's
   HubSpot "Lead status" property (confirmed 2026-07-19). They're HubSpot's
   built-in internal names sitting under his new labels. This file is the
   only place they're referenced — if the property ever changes, update here.
   ============================================================ */

export const PIPELINE = "default"; // Jerry's single deal pipeline

// Deal-stage internal IDs (unchanged by renaming the stage labels)
export const DEAL_STAGES = {
  NEW_INQUIRY:           "appointmentscheduled",   // "New Inquiry"
  CONSULTATION_SCHEDULED:"qualifiedtobuy",         // "Consultation Scheduled"
  REVIEWING:             "presentationscheduled",  // "Reviewing Opportunities"
  COMMITTED:             "decisionmakerboughtin",  // "Committed"
  CLOSED_FUNDED:         "closedwon",              // "Closed-Funded" (won)
  CLOSED_LOST:           "closedlost"              // "Closed-Lost" (lost)
};

// Contact "Lead status" (hs_lead_status) internal values.
// CONFIRMED from Jerry's HubSpot setup (2026-07-19): he relabeled HubSpot's
// built-in options, so the INTERNAL values below are the HubSpot defaults, not
// the labels. (e.g. the option shown as "No-Show" has internal value IN_PROGRESS.)
export const LEAD_STATUS = {
  APPROVAL_PENDING:     "NEW",                   // label: "Approval Pending" (default)
  INTRO_CALL_SCHEDULED: "OPEN",                  // label: "Intro Call Scheduled"
  NO_SHOW:              "IN_PROGRESS",           // label: "No-Show"
  APPROVED:             "OPEN_DEAL",             // label: "Approved"
  UNQUALIFIED:          "UNQUALIFIED",           // label: "Unqualified"
  COLD:                 "ATTEMPTED_TO_CONTACT"   // label: "Cold"
};

// Contact "Lifecycle stage" (lifecyclestage) — HubSpot built-in internal values
export const LIFECYCLE = {
  LEAD:     "lead",
  MQL:      "marketingqualifiedlead",
  SQL:      "salesqualifiedlead",
  CUSTOMER: "customer"
};

/* Read a form's accreditation answer and decide the lead's opening state.
   Tweak the truthy/negative matching to whatever your form actually sends. */
export function assessAccreditation(accreditationCheck) {
  const v = String(accreditationCheck || "").trim().toLowerCase();
  if (!v) return { leadStatus: LEAD_STATUS.APPROVAL_PENDING, lifecycle: LIFECYCLE.LEAD };
  const accredited = /(^|\b)(yes|accredited|qualified|true|confirm)/.test(v);
  const notAccredited = /(^|\b)(no|not|none|unqualified|false)/.test(v);
  if (accredited)   return { leadStatus: LEAD_STATUS.APPROVED,       lifecycle: LIFECYCLE.SQL };
  if (notAccredited) return { leadStatus: LEAD_STATUS.UNQUALIFIED,   lifecycle: LIFECYCLE.LEAD };
  return { leadStatus: LEAD_STATUS.APPROVAL_PENDING, lifecycle: LIFECYCLE.LEAD };
}
