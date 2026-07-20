/* ============================================================
   Shared GoHighLevel (LeadConnector) API v2 client + helpers.
   Token in Authorization: Bearer header, never the URL.

   Env: GHL_TOKEN         Private Integration token (pit-…)
        GHL_LOCATION_ID   sub-account (location) id

   Mirrors the shape of lib/hubspot.mjs / lib/pipedrive.mjs so the
   dual-write reads the same way as the others.
   ============================================================ */

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const LOC = () => process.env.GHL_LOCATION_ID;

/* ghl("/contacts/upsert", { method: "POST", body: {...} })
   ghl("/opportunities/pipelines", { query: { locationId } }) */
export async function ghl(path, { method = "GET", body, query } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GHL_TOKEN}`,
      Version: VERSION,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) console.error(`GHL ${method} ${path} -> ${res.status}`, JSON.stringify(data).slice(0, 300));
  return { ok: res.ok, status: res.status, data };
}

/* Upsert a contact by email (idempotent — GHL dedupes on email per the
   location's duplicate setting). Returns the contact object (with id) or null. */
export async function upsertContact({ email, firstName, lastName, name, phone, customFields, tags } = {}) {
  if (!email) return null;
  const body = clean({
    locationId: LOC(), email, firstName, lastName, name, phone,
    customFields: customFields && customFields.length ? customFields : undefined,
    tags: tags && tags.length ? tags : undefined
  });
  const res = await ghl(`/contacts/upsert`, { method: "POST", body });
  const c = res.data && (res.data.contact || res.data);
  return c && c.id ? c : null;
}

/* Runtime name→id map for CONTACT custom fields (cached per instance). */
let _fieldCache = null;
export async function getContactFieldMap() {
  if (_fieldCache) return _fieldCache;
  const res = await ghl(`/locations/${LOC()}/customFields`, { query: { model: "contact" } });
  const fields = (res.data && (res.data.customFields || [])) || [];
  const map = {};
  for (const f of fields) if (f && f.name) map[String(f.name).trim().toLowerCase()] = f.id;
  _fieldCache = map;
  return map;
}

/* Resolve the pipeline + its stage ids by display name (cached). */
let _pipeCache = null;
export async function resolvePipeline(pipelineName) {
  if (_pipeCache) return _pipeCache;
  const res = await ghl(`/opportunities/pipelines`, { query: { locationId: LOC() } });
  const pipelines = (res.data && res.data.pipelines) || [];
  const p = pipelines.find((x) => String(x.name).trim().toLowerCase() === pipelineName.trim().toLowerCase()) || pipelines[0];
  if (!p) return null;
  const stages = {};
  for (const s of (p.stages || [])) stages[String(s.name).trim().toLowerCase()] = s.id;
  _pipeCache = { id: p.id, stages };
  return _pipeCache;
}
export function stageId(pipe, name) {
  return pipe && pipe.stages ? pipe.stages[String(name).trim().toLowerCase()] : undefined;
}

/* Most-recent OPEN opportunity for a contact (the dedupe target). */
export async function findOpenOpportunity(contactId) {
  if (!contactId) return null;
  const res = await ghl(`/opportunities/search`, { query: { location_id: LOC(), contact_id: contactId } });
  const opps = (res.data && res.data.opportunities) || [];
  const open = opps
    .filter((o) => String(o.status || "open").toLowerCase() === "open")
    .sort((a, b) => new Date(b.createdAt || b.dateAdded || 0) - new Date(a.createdAt || a.dateAdded || 0));
  return open[0] || null;
}

export async function createOpportunity({ name, pipelineId, pipelineStageId, monetaryValue, contactId, status = "open" }) {
  const body = clean({ locationId: LOC(), name, pipelineId, pipelineStageId, monetaryValue, contactId, status });
  const res = await ghl(`/opportunities/`, { method: "POST", body });
  const o = res.data && (res.data.opportunity || res.data);
  return (o && o.id) || null;
}

export async function updateOpportunity(id, { name, pipelineId, pipelineStageId, monetaryValue, status } = {}) {
  const body = clean({ name, pipelineId, pipelineStageId, monetaryValue, status });
  return ghl(`/opportunities/${id}`, { method: "PUT", body });
}

/* Attach a note (HTML/text body) to a contact. */
export async function createNote(contactId, body) {
  if (!contactId || !body) return null;
  const res = await ghl(`/contacts/${contactId}/notes`, { method: "POST", body: { body } });
  const n = res.data && (res.data.note || res.data);
  return (n && n.id) || null;
}

/* One page of contacts for the location (used by the portal-access poller).
   Returns { contacts:[…], meta:{ startAfterId, startAfter, … } }. */
export async function listContacts({ limit = 100, startAfterId, startAfter } = {}) {
  const res = await ghl(`/contacts/`, { query: { locationId: LOC(), limit, startAfterId, startAfter } });
  return res.data || {};
}

function clean(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") out[k] = obj[k];
  }
  return out;
}
