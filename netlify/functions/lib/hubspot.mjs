/* Minimal HubSpot CRM client. The token is read only on the server. */

const BASE = "https://api.hubapi.com";

export async function hs(path, { method = "GET", body, query } = {}) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return { ok: false, status: 503, data: { message: "HUBSPOT_TOKEN not configured" } };
  const url = new URL(BASE + path);
  if (query) for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await response.json(); } catch { /* empty response */ }
  if (!response.ok) console.error(`HubSpot ${method} ${path} -> ${response.status}`, JSON.stringify(data).slice(0, 400));
  return { ok: response.ok, status: response.status, data };
}

export async function findContactByEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!value) return null;
  const result = await search("contacts", [{ propertyName: "email", operator: "EQ", value }]);
  return result[0] || null;
}

export async function findContactByGhlId(ghlId) {
  if (!ghlId) return null;
  const result = await search("contacts", [{ propertyName: "ghl_contact_id", operator: "EQ", value: String(ghlId) }]);
  return result[0] || null;
}

export async function upsertContact(email, properties = {}) {
  const cleanProps = clean({ ...properties, ...(email ? { email: String(email).trim().toLowerCase() } : {}) });
  let existing = email ? await findContactByEmail(email) : null;
  if (!existing && cleanProps.ghl_contact_id) existing = await findContactByGhlId(cleanProps.ghl_contact_id);
  if (existing) {
    const updated = await hs(`/crm/v3/objects/contacts/${existing.id}`, { method: "PATCH", body: { properties: cleanProps } });
    if (!updated.ok) throw hubspotError("contact update", updated);
    return { ...existing, ...updated.data };
  }
  const created = await hs("/crm/v3/objects/contacts", { method: "POST", body: { properties: cleanProps } });
  if (!created.ok && created.status === 409) {
    const existingId = String(created.data?.message || "").match(/existing id[:\\s]+(\\d+)/i)?.[1];
    if (existingId) {
      const recovered = await hs(`/crm/v3/objects/contacts/${existingId}`, { method: "PATCH", body: { properties: cleanProps } });
      if (recovered.ok) return { id: existingId, ...recovered.data };
    }
  }
  if (!created.ok) throw hubspotError("contact create", created);
  return created.data;
}

export async function findContactById(id) {
  if (!id) return null;
  const result = await hs(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { query: { properties: "email,firstname,lastname" } });
  return result.ok ? result.data : null;
}

export async function findDealByGhlId(ghlId) {
  if (!ghlId) return null;
  const result = await search("deals", [{ propertyName: "ghl_opportunity_id", operator: "EQ", value: String(ghlId) }]);
  return result[0] || null;
}

export async function findOpenDealForContact(contactId) {
  if (!contactId) return null;
  const associations = await hs(`/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/deals`);
  const ids = (associations.data?.results || []).map((x) => x.toObjectId || x.id).filter(Boolean);
  if (!ids.length) return null;
  const deals = [];
  for (const id of ids) {
    const result = await hs(`/crm/v3/objects/deals/${id}`, { query: { properties: "dealname,dealstage,pipeline,ghl_opportunity_id,amount" } });
    if (result.ok) deals.push(result.data);
  }
  return deals
    .filter((deal) => !["closedwon", "closedlost"].includes(String(deal.properties?.dealstage || "").toLowerCase()))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
}

export async function createDeal(properties, contactId) {
  const associations = contactId ? [{ to: { id: String(contactId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }] : undefined;
  const result = await hs("/crm/v3/objects/deals", { method: "POST", body: { properties: clean(properties), ...(associations ? { associations } : {}) } });
  return result.ok ? result.data : null;
}

export async function updateDeal(id, properties) {
  if (!id) return null;
  const result = await hs(`/crm/v3/objects/deals/${encodeURIComponent(id)}`, { method: "PATCH", body: { properties: clean(properties) } });
  return result.ok ? result.data : null;
}

export async function createNote({ body, contactId, dealId, timestamp } = {}) {
  if (!body) return null;
  const associations = [];
  if (contactId) associations.push(association(contactId, 202));
  if (dealId) associations.push(association(dealId, 214));
  const result = await hs("/crm/v3/objects/notes", {
    method: "POST",
    body: {
      properties: { hs_timestamp: timestamp || new Date().toISOString(), hs_note_body: String(body).slice(0, 65536) },
      ...(associations.length ? { associations } : {})
    }
  });
  return result.ok ? result.data : null;
}

export async function createTask({ title, body, dueDate, startDate, completed, priority, contactId, dealId, marker } = {}) {
  if (!title) return null;
  const taskBody = [body, marker].filter(Boolean).join("\n\n");
  const properties = clean({
    hs_task_subject: String(title).slice(0, 255),
    hs_task_body: taskBody.slice(0, 65536),
    hs_timestamp: dueDate || new Date().toISOString(),
    hs_start_date: startDate,
    hs_task_status: completed ? "COMPLETED" : "NOT_STARTED",
    hs_task_priority: mapPriority(priority)
  });
  const associations = [];
  if (contactId) associations.push(association(contactId, 204));
  if (dealId) associations.push(association(dealId, 216));
  const result = await hs("/crm/v3/objects/tasks", { method: "POST", body: { properties, ...(associations.length ? { associations } : {}) } });
  return result.ok ? result.data : null;
}

export async function searchTasksByMarker(marker) {
  if (!marker) return [];
  return search("tasks", [{ propertyName: "hs_task_body", operator: "CONTAINS_TOKEN", value: marker }], ["hs_task_subject", "hs_task_body"], false);
}

export async function searchNotesByMarker(marker) {
  if (!marker) return [];
  return search("notes", [{ propertyName: "hs_note_body", operator: "CONTAINS_TOKEN", value: marker }], ["hs_note_body"], false);
}

export async function search(objectType, filters, properties = [], sort = true) {
  const result = await hs(`/crm/v3/objects/${objectType}/search`, {
    method: "POST",
    body: { filterGroups: [{ filters }], properties, limit: 100, ...(sort ? { sorts: [{ propertyName: "createdate", direction: "DESCENDING" }] } : {}) }
  });
  return result.ok ? (result.data.results || []) : [];
}

export function mapPriority(value) {
  const v = String(value || "").toLowerCase();
  if (v.includes("high")) return "HIGH";
  if (v.includes("low")) return "LOW";
  return "MEDIUM";
}

function association(id, associationTypeId) {
  return { to: { id: String(id) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }] };
}

function clean(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function hubspotError(action, result) {
  const data = result?.data || {};
  const propertyErrors = Array.isArray(data.errors)
    ? data.errors.map((error) => error.propertyName || error.code).filter(Boolean).join(",")
    : "";
  const detail = [data.message, propertyErrors ? `properties=${propertyErrors}` : ""].filter(Boolean).join("; ");
  return new Error(`HubSpot ${action} failed (${result?.status || "unknown"})${detail ? `: ${detail}` : ""}`);
}
