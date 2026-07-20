/* ============================================================
   Netlify event function: runs on EVERY verified form submission.

   - request-investment-access → upsert Person + create Deal in
     Pipedrive with the 1031/investment fields and calculations:
       LTV %              = debt / (equity + debt) * 100
       Total Investment   = equity + debt (or anticipated amount)
       45-Day Deadline    = closing date + 45 days  (also set as the
                            deal's expected close date, per Jerry)
       180-Day Deadline   = closing date + 180 days
       Deal value         = (equity || anticipated) * 0.05 * 0.9
   - crs-receipts → stamp CRS Delivery Date on the Person

   Dual-writes (parallel-run, each guarded by its own token so it's a
   safe no-op when unset): HubSpot (HUBSPOT_TOKEN), GHL (GHL_TOKEN).

   Env: PIPEDRIVE_API_TOKEN, PD_FIELDS_JSON (output of pd-setup),
        optional PD_PIPELINE_ID (default 2), PD_STAGE_ID (default 6)
   ============================================================ */

import { upsertContact, findOpenDealForContact, createDeal, updateDeal, createNote } from "./lib/hubspot.mjs";
import { DEAL_STAGES, PIPELINE, assessAccreditation } from "./lib/hs-config.mjs";
import {
  upsertContact as ghlUpsertContact, getContactFieldMap, resolvePipeline,
  findOpenOpportunity, createOpportunity, updateOpportunity, createNote as ghlCreateNote, stageId
} from "./lib/ghl.mjs";
import {
  PIPELINE_NAME as GHL_PIPELINE, STAGES as GHL_STAGES, buildContactFields,
  assessAccreditation as ghlAssessAccreditation
} from "./lib/ghl-config.mjs";

const API = "https://api.pipedrive.com/v1";

export default async (req) => {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return ok("pipedrive not configured");

  let fields = { person: {}, deal: {} };
  try { fields = JSON.parse(process.env.PD_FIELDS_JSON || "{}"); } catch {}

  let body;
  try { body = await req.json(); } catch { return ok("bad payload"); }
  const payload = body.payload || {};
  const data = payload.data || {};
  const formName = payload.form_name || data["form-name"] || "";

  if (formName === "crs-receipts") {
    const person = await findPerson(token, data.email);
    if (person && fields.person && fields.person["CRS Delivery Date"]) {
      await pd("PATCH", `/persons/${person.id}`, token, {
        custom_fields: { [fields.person["CRS Delivery Date"]]: toDate(data.crs_accepted_at) }
      }, 2);
    }
    if (process.env.HUBSPOT_TOKEN) {
      try { await upsertContact(data.email, { email: data.email, crs_delivery_date: toDate(data.crs_accepted_at) }); }
      catch (e) { console.error("hubspot crs dual-write failed:", e); }
    }
    if (process.env.GHL_TOKEN) {
      try {
        const fieldMap = await getContactFieldMap();
        const cf = buildContactFields(fieldMap, { crs_delivery_date: toDate(data.crs_accepted_at) });
        await ghlUpsertContact({ email: data.email, customFields: cf });
      } catch (e) { console.error("ghl crs dual-write failed:", e); }
    }
    return ok("crs recorded");
  }

  if (formName !== "request-investment-access") return ok("ignored");

  // ---------- Person ----------
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.email;
  const pf = fields.person || {};
  const personCustom = clean({
    [pf["Preferred Name"]]: data.preferred_name,
    [pf["State of Residence"]]: data.state,
    [pf["Role"]]: data.role_other ? `${data.role} — ${data.role_other}` : data.role,
    [pf["Marital Status"]]: data.marital_status,
    [pf["Household Income"]]: data.household_income,
    [pf["Net Worth"]]: data.net_worth,
    [pf["DST Familiarity"]]: data.dst_familiarity,
    [pf["Current Plan"]]: data.current_plan,
    [pf["US Check"]]: data.us_check,
    [pf["Accreditation Check"]]: data.accreditation_check,
    [pf["CRS Delivery Date"]]: toDate(data.crs_accepted_at)
  });

  let person = await findPerson(token, data.email);
  if (person) {
    await pd("PATCH", `/persons/${person.id}`, token, { custom_fields: personCustom }, 2);
  } else {
    const created = await pd("POST", `/persons`, token, {
      name,
      emails: [{ value: data.email, primary: true }],
      phones: data.phone ? [{ value: data.phone, primary: true }] : [],
      custom_fields: personCustom
    }, 2);
    person = created.data;
  }
  if (!person) return ok("person create failed");

  // ---------- Deal + calculations ----------
  const equity = money(data.equity_amount);
  const debt = money(data.debt_amount);
  const anticipated = money(data.investment_amount);
  const base = equity || anticipated;
  const total = equity || debt ? equity + debt : anticipated;
  const ltv = equity + debt > 0 ? +(100 * debt / (equity + debt)).toFixed(2) : 0;
  const dealValue = Math.round(base * 0.05 * 0.9);
  const day45 = addDays(data.closing_date, 45);
  const day180 = addDays(data.closing_date, 180);

  const df = fields.deal || {};
  const dealCustom = clean({
    [df["Situation"]]: data.situation_other ? `${data.situation} — ${data.situation_other}` : data.situation,
    [df["Closing Date"]]: toDate(data.closing_date),
    [df["Equity"]]: equity ? { value: equity, currency: "USD" } : undefined,
    [df["Debt"]]: data.debt_amount !== undefined && data.debt_amount !== "" ? { value: debt, currency: "USD" } : undefined,
    [df["Anticipated Investment"]]: anticipated ? { value: anticipated, currency: "USD" } : undefined,
    [df["In-Place LTV %"]]: equity + debt > 0 ? ltv : undefined,
    [df["Total Investment Size"]]: total ? { value: total, currency: "USD" } : undefined,
    [df["45-Day Deadline"]]: day45,
    [df["180-Day Deadline"]]: day180,
    [df["Routed To"]]: data.routed_to
  });

  // Re-submissions update the person's existing open deal instead of
  // creating a duplicate
  const existing = await pd("GET", `/deals&person_id=${person.id}&status=open&sort_by=add_time&sort_direction=desc&limit=1`, token, null, 2);
  const openDeal = existing && existing.data && existing.data[0];
  const dealFields = {
    title: `${name} — ${data.situation || "Investment"}`,
    person_id: person.id,
    pipeline_id: Number(process.env.PD_PIPELINE_ID || 2),
    stage_id: Number(process.env.PD_STAGE_ID || 6),
    value: dealValue || undefined,
    currency: "USD",
    expected_close_date: day45 || undefined, // 45-day deadline drives expected close
    custom_fields: dealCustom
  };
  const dealRes = openDeal
    ? await pd("PATCH", `/deals/${openDeal.id}`, token, dealFields, 2)
    : await pd("POST", `/deals`, token, dealFields, 2);
  const dealId = (dealRes && dealRes.data && dealRes.data.id) || (openDeal && openDeal.id);

  // ---------- Full submission as a note (pinned to person + deal) ----------
  const note = buildSubmissionNote(data);
  await pd("POST", `/notes`, token, clean({
    content: note,
    person_id: person.id,
    deal_id: dealId || undefined,
    pinned_to_person_flag: 1,
    pinned_to_deal_flag: dealId ? 1 : undefined
  }));

  // ---------- HubSpot dual-write (parallel-run; safe no-op if HUBSPOT_TOKEN unset) ----------
  if (process.env.HUBSPOT_TOKEN) {
    try {
      await syncToHubSpot({ data, name, equity, debt, anticipated, total, ltv, dealValue, day45, day180 });
    } catch (e) { console.error("hubspot dual-write failed:", e); }
  }

  // ---------- GHL dual-write (parallel-run; safe no-op if GHL_TOKEN unset) ----------
  if (process.env.GHL_TOKEN) {
    try {
      await syncToGHL({ data, name, equity, debt, anticipated, total, ltv, dealValue, day45, day180 });
    } catch (e) { console.error("ghl dual-write failed:", e); }
  }

  return ok("synced");
};

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

function buildSubmissionNote(data) {
  const rows = NOTE_FIELDS
    .filter(([k]) => data[k] !== undefined && data[k] !== "" && data[k] !== null)
    .map(([k, label]) => `<b>${label}:</b> ${esc(String(data[k]))}`);
  return `<b>Request Investment Access — full submission</b><br><br>${rows.join("<br>")}`;
}

/* HubSpot dual-write: upsert the Contact (by email), update-or-create their
   open Deal with the mapped custom properties, and attach the full submission
   as a Note. Property internal names match hs-setup.mjs. Runs alongside — and
   never interferes with — the Pipedrive writes above. */
async function syncToHubSpot({ data, name, equity, debt, anticipated, total, ltv, dealValue, day45, day180 }) {
  if (!data.email) return;

  // Opening lifecycle + lead status from the accreditation answer.
  const { leadStatus, lifecycle } = assessAccreditation(data.accreditation_check);

  const contactProps = clean({
    firstname: data.first_name,
    lastname: data.last_name,
    phone: data.phone,
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
    lifecyclestage: lifecycle,
    hs_lead_status: leadStatus
  });
  const contactId = await upsertContact(data.email, contactProps);
  if (!contactId) return;

  const dealProps = clean({
    dealname: `${name} — ${data.situation || "Investment"}`,
    amount: dealValue || undefined,
    closedate: day45 || undefined,                    // 45-day deadline drives close date (per Jerry)
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

  const openDeal = await findOpenDealForContact(contactId);
  let dealId;
  if (openDeal) {
    // Re-submission: update fields, but don't yank an advanced deal back a stage.
    await updateDeal(openDeal.id, dealProps);
    dealId = openDeal.id;
  } else {
    // New deal enters the pipeline at "New Inquiry".
    dealId = await createDeal({ ...dealProps, dealstage: DEAL_STAGES.NEW_INQUIRY, pipeline: PIPELINE }, contactId);
  }

  await createNote({ body: buildSubmissionNote(data), contactId, dealId });
}

/* GHL dual-write: upsert the Contact (by email) with all investor + deal
   fields as CONTACT custom fields, update-or-create their open Opportunity
   (New Registration stage, value = dealValue), and attach the submission as
   a note. Runs alongside — and never interferes with — the writes above.
   Field names match lib/ghl-config.mjs / ghl-setup.mjs. */
async function syncToGHL({ data, name, equity, debt, anticipated, total, ltv, dealValue, day45, day180 }) {
  if (!data.email) return;
  const { leadStatus } = ghlAssessAccreditation(data.accreditation_check);
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

  const contact = await ghlUpsertContact({
    email: data.email,
    firstName: data.first_name,
    lastName: data.last_name,
    name,
    phone: data.phone,
    customFields: cf
  });
  if (!contact) return;

  const pipe = await resolvePipeline(GHL_PIPELINE);
  const oppName = `${name} — ${data.situation || "Investment"}`;
  const open = await findOpenOpportunity(contact.id);
  if (open) {
    // Re-submission: refresh name + value, don't move an advanced opportunity back.
    await updateOpportunity(open.id, { name: oppName, monetaryValue: dealValue || undefined });
  } else if (pipe) {
    await createOpportunity({
      name: oppName,
      pipelineId: pipe.id,
      pipelineStageId: stageId(pipe, GHL_STAGES.ENTRY),
      monetaryValue: dealValue || undefined,
      contactId: contact.id
    });
  }

  await ghlCreateNote(contact.id, buildSubmissionNote(data));
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function findPerson(token, email) {
  if (!email) return null;
  const res = await pd("GET", `/persons/search&term=${encodeURIComponent(email)}&fields=email&exact_match=true`, token);
  const item = res && res.data && res.data.items && res.data.items[0];
  return item ? item.item : null;
}

async function pd(method, path, token, body, v) {
  const base = v === 2 ? "https://api.pipedrive.com/api/v2" : API;
  const [p, extra] = path.split("&");
  const url = `${base}${p}${extra ? "?" + extra : ""}`;
  const res = await fetch(url, {
    method,
    headers: { "x-api-token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  try { return await res.json(); } catch { return {}; }
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
function clean(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k !== "undefined" && obj[k] !== undefined && obj[k] !== "" && obj[k] !== null) out[k] = obj[k];
  }
  return out;
}
function ok(note) {
  return new Response(JSON.stringify({ ok: true, note }), { status: 200, headers: { "Content-Type": "application/json" } });
}
