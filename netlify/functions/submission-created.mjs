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

   Env: PIPEDRIVE_API_TOKEN, PD_FIELDS_JSON (output of pd-setup),
        optional PD_PIPELINE_ID (default 2), PD_STAGE_ID (default 6)
   ============================================================ */

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
