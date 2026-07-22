/* ============================================================
   Netlify event function: runs on EVERY verified form submission.
   GoHighLevel-only (Pipedrive + HubSpot were retired at cutover).

   - request-investment-access -> upsert Contact + create/update the
     open Opportunity in GHL with the 1031/investment fields and calcs:
       LTV %            = debt / (equity + debt) * 100
       Total Investment = equity + debt (or anticipated amount)
       45-Day Deadline  = closing date + 45 days
       180-Day Deadline = closing date + 180 days
       Opportunity value= (equity || anticipated) * 0.05 * 0.9
     SMS consent (opt-in checkbox) -> "SMS Consent" field + "sms-opt-in" tag,
     with the consent recorded in the submission note for the A2P audit trail.
   - crs-receipts -> stamp CRS Delivery Date on the Contact.

   Env: GHL_TOKEN, GHL_LOCATION_ID
   ============================================================ */

import {
  upsertContact, getContactFieldMap, resolvePipeline,
  findOpenOpportunity, createOpportunity, updateOpportunity, createNote, stageId
} from "./lib/ghl.mjs";
import { PIPELINE_NAME, STAGES, buildContactFields, assessAccreditation } from "./lib/ghl-config.mjs";

export default async (req) => {
  if (!process.env.GHL_TOKEN) return ok("ghl not configured");

  let body;
  try { body = await req.json(); } catch { return ok("bad payload"); }
  const payload = body.payload || {};
  const data = payload.data || {};
  const formName = payload.form_name || data["form-name"] || "";

  if (formName === "crs-receipts") {
    if (!data.email) return ok("crs: no email");
    try {
      const fieldMap = await getContactFieldMap();
      const cf = buildContactFields(fieldMap, { crs_delivery_date: toDate(data.crs_accepted_at) });
      await upsertContact({ email: data.email, customFields: cf });
    } catch (e) { console.error("ghl crs write failed:", e); }
    return ok("crs recorded");
  }

  if (formName !== "request-investment-access") return ok("ignored");

  // ---------- spam / empty-submission guard ----------
  // Bots POST directly to the Netlify endpoint, skip the multi-step modal
  // (and its per-step validation), and send only an email — or nothing.
  // A genuine completion always carries these fields; drop anything missing
  // them before any GoHighLevel write.
  const required = ["first_name", "last_name", "email", "phone", "state"];
  const missing = required.filter((k) => !data[k] || String(data[k]).trim() === "");
  if (missing.length) {
    console.warn(`skipping incomplete/spam submission — missing: ${missing.join(", ")} — email=${data.email || "(none)"}`);
    return ok(`skipped: missing ${missing.join(", ")}`);
  }

  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.email;

  // ---------- calculations ----------
  const equity = money(data.equity_amount);
  const debt = money(data.debt_amount);
  const anticipated = money(data.investment_amount);
  const base = equity || anticipated;
  const total = equity || debt ? equity + debt : anticipated;
  const ltv = equity + debt > 0 ? +(100 * debt / (equity + debt)).toFixed(2) : 0;
  const dealValue = Math.round(base * 0.05 * 0.9);
  const day45 = addDays(data.closing_date, 45);
  const day180 = addDays(data.closing_date, 180);

  try {
    await syncToGHL({ data, name, equity, debt, anticipated, total, ltv, dealValue, day45, day180 });
  } catch (e) {
    console.error("ghl write failed:", e);
    return ok("ghl error");
  }

  return ok("synced");
};

/* GHL write: upsert the Contact (by email) with all investor + deal fields
   as CONTACT custom fields, update-or-create their open Opportunity (New
   Registration stage, value = dealValue), tag + record SMS consent, and
   attach the full submission as a note. */
async function syncToGHL({ data, name, equity, debt, anticipated, total, ltv, dealValue, day45, day180 }) {
  if (!data.email) return;
  const { leadStatus } = assessAccreditation(data.accreditation_check);
  const smsOptIn = String(data.sms_consent || "").trim().toLowerCase() === "yes";

  const fieldMap = await getContactFieldMap();
  const cf = buildContactFields(fieldMap, {
    preferred_name: data.preferred_name,
    state_of_residence: data.state,
    investor_role: data.role_other ? `${data.role} — ${data.role_other}` : data.role,
    marital_status: data.marital_status,
    household_income: data.household_income,
    net_worth: data.net_worth,
    dst_familiarity: data.dst_familiarity,
    current_plan: data.current_plan,
    us_check: data.us_check,
    accreditation_check: data.accreditation_check,
    crs_delivery_date: toDate(data.crs_accepted_at),
    lead_status: leadStatus,
    sms_consent: smsOptIn ? "Yes" : "No",
    situation: data.situation_other ? `${data.situation} — ${data.situation_other}` : data.situation,
    closing_date: toDate(data.closing_date),
    equity: equity || undefined,
    debt: (data.debt_amount !== undefined && data.debt_amount !== "") ? debt : undefined,
    anticipated_investment: anticipated || undefined,
    in_place_ltv: (equity + debt > 0) ? ltv : undefined,
    total_investment_size: total || undefined,
    deadline_45: day45,
    deadline_180: day180,
    routed_to: data.routed_to
  });

  const contact = await upsertContact({
    email: data.email,
    firstName: data.first_name,
    lastName: data.last_name,
    name,
    phone: data.phone,
    customFields: cf,
    tags: smsOptIn ? ["sms-opt-in"] : undefined
  });
  if (!contact) return;

  const pipe = await resolvePipeline(PIPELINE_NAME);
  const oppName = `${name} — ${data.situation || "Investment"}`;
  const open = await findOpenOpportunity(contact.id);
  if (open) {
    await updateOpportunity(open.id, { name: oppName, monetaryValue: dealValue || undefined });
  } else if (pipe) {
    await createOpportunity({
      name: oppName,
      pipelineId: pipe.id,
      pipelineStageId: stageId(pipe, STAGES.ENTRY),
      monetaryValue: dealValue || undefined,
      contactId: contact.id
    });
  }

  await createNote(contact.id, buildSubmissionNote(data, smsOptIn));
}

// Every submitted answer, in form order, as one readable note.
const NOTE_FIELDS = [
  ["first_name", "First Name"],
  ["last_name", "Last Name"],
  ["preferred_name", "Preferred Name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["state", "State of Residence"],
  ["role", "Role"],
  ["role_other", "Role — details"],
  ["situation", "Current Situation"],
  ["situation_other", "Situation — details"],
  ["closing_date", "Closing Date"],
  ["equity_amount", "Equity"],
  ["debt_amount", "Debt"],
  ["investment_amount", "Anticipated Investment"],
  ["dst_familiarity", "DST Familiarity"],
  ["current_plan", "Where DSTs Fit"],
  ["marital_status", "Marital Status"],
  ["household_income", "Household Income"],
  ["net_worth", "Net Worth (excl. residence)"],
  ["us_check", "US Check"],
  ["accreditation_check", "Accreditation Check"],
  ["routed_to", "Routed To"],
  ["crs_accepted_at", "CRS Accepted At"]
];

function buildSubmissionNote(data, smsOptIn) {
  const rows = NOTE_FIELDS
    .filter(([k]) => data[k] !== undefined && data[k] !== "" && data[k] !== null)
    .map(([k, label]) => `<b>${label}:</b> ${esc(String(data[k]))}`);
  rows.push(`<b>SMS Consent:</b> ${smsOptIn ? "Yes (opted in via web form)" : "No"}`);
  return `<b>Request Investment Access — full submission</b><br><br>${rows.join("<br>")}`;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function money(v) {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}
function toDate(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d) ? undefined : d.toISOString().slice(0, 10);
}
function addDays(v, days) {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d)) return undefined;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function ok(note) {
  return new Response(JSON.stringify({ ok: true, note }), { status: 200, headers: { "Content-Type": "application/json" } });
}
