/* ============================================================
   GoHighLevel booking → Kinde + pipeline webhook receiver.

   Wire in GHL: Automation → Workflow
     Trigger : "Customer Booked Appointment" (calendar = 25-Minute Consultation)
     Action  : Webhook (POST) →
       https://baker1031.com/.netlify/functions/ghl-booking?secret=<GHL_WEBHOOK_SECRET>

   On a booking:
     - upsert the contact; set Lead Status = Intro Call Scheduled and
       Portal Access = Yes
     - move (or create) their open opportunity → "Consultation Scheduled"
     - PROVISION the investor portal login server-side (Kinde). The
       portal-access poller also sees the Yes and is idempotent.

   Auth: shared secret in ?secret= (fails closed). Guarded by GHL_TOKEN.

   Env: GHL_TOKEN, GHL_LOCATION_ID, GHL_WEBHOOK_SECRET,
        KINDE_DOMAIN, KINDE_M2M_CLIENT_ID, KINDE_M2M_CLIENT_SECRET
   ============================================================ */

import { ok } from "./lib/http.mjs";
import { kindeToken, createUser, findUserByEmail, unsuspendUser } from "./lib/kinde.mjs";
import {
  upsertContact, getContactFieldMap, resolvePipeline,
  findOpenOpportunity, createOpportunity, updateOpportunity, stageId
} from "./lib/ghl.mjs";
import { PIPELINE_NAME, STAGES, LEAD_STATUS, buildContactFields } from "./lib/ghl-config.mjs";

export default async (req) => {
  if (req.method !== "POST") return ok("method ignored");

  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) return new Response("forbidden", { status: 403 }); // fail closed
  if (new URL(req.url).searchParams.get("secret") !== secret) return new Response("forbidden", { status: 403 });

  if (!process.env.GHL_TOKEN) return ok("ghl not configured");

  let body;
  try { body = await req.json(); } catch { return ok("bad payload"); }

  // GHL custom-webhook payloads vary; read the contact from the common shapes.
  const c = body.contact || body.customData || body;
  const email = String(c.email || body.email || "").trim().toLowerCase();
  const first = c.first_name || c.firstName || body.first_name || "";
  const last  = c.last_name  || c.lastName  || body.last_name  || "";
  const fullName = c.full_name || c.name || body.full_name || [first, last].filter(Boolean).join(" ") || email;
  if (!email) return ok("no attendee email in payload");

  /* ---------- CRM: lead status, portal flag, opportunity stage ---------- */
  try {
    const fieldMap = await getContactFieldMap();
    const cf = buildContactFields(fieldMap, {
      lead_status: LEAD_STATUS.INTRO_CALL_SCHEDULED,
      portal_access: "Yes"
    });
    const contact = await upsertContact({ email, firstName: first, lastName: last, name: fullName, customFields: cf });
    if (contact) {
      const pipe = await resolvePipeline(PIPELINE_NAME);
      if (pipe) {
        const open = await findOpenOpportunity(contact.id);
        if (open) {
          await updateOpportunity(open.id, { pipelineId: pipe.id, pipelineStageId: stageId(pipe, STAGES.CONSULTATION) });
        } else {
          await createOpportunity({
            name: `${fullName} — Consultation`,
            pipelineId: pipe.id,
            pipelineStageId: stageId(pipe, STAGES.CONSULTATION),
            contactId: contact.id
          });
        }
      }
    }
  } catch (e) {
    console.error("ghl-booking crm update failed:", e);
  }

  /* ---------- Server-side portal provisioning (Kinde) ---------- */
  try {
    const kt = await kindeToken();
    if (kt) {
      const parts = String(fullName || "").trim().split(/\s+/);
      const res = await createUser(kt, {
        email,
        given: first || parts[0] || "",
        family: last || parts.slice(1).join(" ") || ""
      });
      if (res.ok && !res.created) {
        const u = await findUserByEmail(kt, email);
        if (u && u.is_suspended) await unsuspendUser(kt, u.id);
      }
    }
  } catch (e) {
    console.error("ghl-booking provisioning failed:", e);
  }

  return ok("booking processed");
};
