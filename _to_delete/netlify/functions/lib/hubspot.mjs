/* Shared HubSpot CRM helpers (token in Authorization: Bearer header, never the URL).
   Env: HUBSPOT_TOKEN — private app access token (pat-na2-…).
   Mirrors the shape of lib/pipedrive.mjs so the dual-write reads the same way. */

const BASE = "https://api.hubapi.com";

/* hs("/crm/v3/objects/contacts/search", { method: "POST", body: {...} }) */
export async function hs(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    console.error(`HubSpot ${method} ${path} -> ${res.status}`, JSON.stringify(data).slice(0, 300));
  }
  return { ok: res.ok, status: res.status, data };
}

/* Upsert a contact by email (idempotent — HubSpot dedupes on email).
   Returns the contact id, or null on failure. */
export async function upsertContact(email, properties = {}) {
  if (!email) return null;
  const res = await hs(`/crm/v3/objects/contacts/batch/upsert`, {
    method: "POST",
    body: { inputs: [{ idProperty: "email", id: email, properties: { email, ...properties } }] }
  });
  const row = res.data && res.data.results && res.data.results[0];
  return row ? row.id : null;
}

export async function findContactByEmail(email) {
  if (!email) return null;
  const res = await hs(`/crm/v3/objects/contacts/search`, {
    method: "POST",
    body: {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "firstname", "lastname", "portal_access"],
      limit: 1
    }
  });
  return (res.data && res.data.results && res.data.results[0]) || null;
}

/* Most-recent OPEN deal associated with a contact (the dedupe target),
   mirroring Pipedrive's findOpenDeal. "Open" = stage name doesn't say closed. */
export async function findOpenDealForContact(contactId) {
  if (!contactId) return null;
  const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/deals?limit=100`);
  const ids = ((assoc.data && assoc.data.results) || []).map((r) => r.toObjectId);
  if (!ids.length) return null;
  const res = await hs(`/crm/v3/objects/deals/batch/read`, {
    method: "POST",
    body: { properties: ["dealstage", "createdate", "pipeline"], inputs: ids.map((id) => ({ id })) }
  });
  const deals = (res.data && res.data.results) || [];
  const open = deals
    .filter((d) => !/closed/i.test((d.properties && d.properties.dealstage) || ""))
    .sort((a, b) => new Date(b.properties.createdate) - new Date(a.properties.createdate));
  return open[0] || null;
}

export async function createDeal(properties, contactId) {
  const res = await hs(`/crm/v3/objects/deals`, { method: "POST", body: { properties } });
  const dealId = res.data && res.data.id;
  if (dealId && contactId) await associate("deals", dealId, "contacts", contactId);
  return dealId || null;
}

export async function updateDeal(dealId, properties) {
  return hs(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: { properties } });
}

/* Default (HubSpot-defined) association via v4 — avoids hardcoding typeIds. */
export async function associate(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return;
  return hs(`/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`, { method: "PUT" });
}

/* Attach a Note (HTML body) to a contact and/or deal. */
export async function createNote({ body, contactId, dealId, timestamp }) {
  const res = await hs(`/crm/v3/objects/notes`, {
    method: "POST",
    body: { properties: { hs_note_body: body, hs_timestamp: timestamp || new Date().toISOString() } }
  });
  const noteId = res.data && res.data.id;
  if (noteId && contactId) await associate("notes", noteId, "contacts", contactId);
  if (noteId && dealId) await associate("notes", noteId, "deals", dealId);
  return noteId || null;
}

/* Create a Task (used by the Granola action-item sync). dueTimestamp = ISO or epoch ms. */
export async function createTask({ subject, body, dueTimestamp, contactId, dealId }) {
  const res = await hs(`/crm/v3/objects/tasks`, {
    method: "POST",
    body: {
      properties: {
        hs_task_subject: subject,
        hs_task_body: body || "",
        hs_task_status: "NOT_STARTED",
        hs_task_priority: "NONE",
        hs_task_type: "TODO",
        hs_timestamp: dueTimestamp || new Date().toISOString()
      }
    }
  });
  const taskId = res.data && res.data.id;
  if (taskId && contactId) await associate("tasks", taskId, "contacts", contactId);
  if (taskId && dealId) await associate("tasks", taskId, "deals", dealId);
  return taskId || null;
}
