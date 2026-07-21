/* ============================================================
   TEMPORARY GHL write self-test (delete before cutover).
   Exercises the exact GHL write path the form handler uses, with
   fixed sample data across every field type (text/date/number/option),
   then reads the contact back so we can confirm which value formats
   GHL actually stored. Isolates the GHL code from the form + Pipedrive.

   Call: GET /.netlify/functions/ghl-selftest?secret=<GHL_SETUP_SECRET>
   Env:  GHL_TOKEN, GHL_LOCATION_ID, GHL_SETUP_SECRET
   Creates/updates one contact: ghl-selftest@baker1031.com (delete after).
   ============================================================ */

import { json, requireSecret } from "./lib/http.mjs";
import { ghl, upsertContact, getContactFieldMap, resolvePipeline, findOpenOpportunity, createOpportunity, stageId } from "./lib/ghl.mjs";
import { PIPELINE_NAME, STAGES, LEAD_STATUS, buildContactFields } from "./lib/ghl-config.mjs";

const EMAIL = "ghl-selftest@baker1031.com";

export default async (req) => {
  if (!requireSecret(req, "GHL_SETUP_SECRET")) return json({ error: "unauthorized" }, 401);
  if (!process.env.GHL_TOKEN || !process.env.GHL_LOCATION_ID) return json({ error: "GHL env not set" }, 503);

  const out = {};
  const fieldMap = await getContactFieldMap();
  out.fieldMapCount = Object.keys(fieldMap).length;

  const values = {
    preferred_name: "Selftest", state_of_residence: "California",
    equity: 250000, debt: 100000, in_place_ltv: 28.57, total_investment_size: 350000,
    closing_date: "2027-07-01", deadline_45: "2027-08-15", deadline_180: "2027-12-28",
    crs_delivery_date: "2026-07-20", portal_access: "No", lead_status: LEAD_STATUS.APPROVAL_PENDING
  };
  const cf = buildContactFields(fieldMap, values);
  out.sentFieldCount = cf.length;

  let contact = await upsertContact({ email: EMAIL, firstName: "GHL", lastName: "Selftest", name: "GHL Selftest", customFields: cf });
  out.upsertWithFields = Boolean(contact);
  if (!contact) {
    contact = await upsertContact({ email: EMAIL, firstName: "GHL", lastName: "Selftest", name: "GHL Selftest" });
    out.upsertBare = Boolean(contact);
    out.note = "custom fields likely rejected the upsert — check value formats";
  }
  if (!contact) return json(out);
  out.contactId = contact.id;

  const pipe = await resolvePipeline(PIPELINE_NAME);
  out.pipelineResolved = Boolean(pipe);
  out.entryStageId = pipe ? stageId(pipe, STAGES.ENTRY) : null;
  const open = await findOpenOpportunity(contact.id);
  if (open) out.opportunityId = open.id;
  else if (pipe && out.entryStageId) {
    out.opportunityId = await createOpportunity({
      name: "GHL Selftest — Investment", pipelineId: pipe.id,
      pipelineStageId: out.entryStageId, monetaryValue: 11250, contactId: contact.id
    });
  }

  const idToName = {};
  for (const [n, id] of Object.entries(fieldMap)) idToName[id] = n;
  const rb = await ghl(`/contacts/${contact.id}`);
  const c = rb.data && (rb.data.contact || rb.data);
  out.storedFields = ((c && c.customFields) || []).map((f) => ({ field: idToName[f.id] || f.id, value: f.value ?? f.field_value }));
  return json(out);
};
