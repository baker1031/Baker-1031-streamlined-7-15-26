/* ============================================================
   ONE-TIME GoHighLevel setup (run once, then idempotent — safe to re-hit).
   Creates all CONTACT custom fields (see lib/ghl-config.mjs) so the
   submission-created dual-write + booking webhook have somewhere to land.

   Call:  GET /.netlify/functions/ghl-setup?secret=<GHL_SETUP_SECRET>
   Env:   GHL_TOKEN, GHL_LOCATION_ID, GHL_SETUP_SECRET

   Reports per-field created/exists/FAIL so we can confirm the whole set
   landed (mirrors hs-setup.mjs). The pipeline + stages are built in the
   GHL UI — this only creates fields.
   ============================================================ */

import { json, requireSecret } from "./lib/http.mjs";
import { CONTACT_FIELDS } from "./lib/ghl-config.mjs";

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

export default async (req) => {
  if (!requireSecret(req, "GHL_SETUP_SECRET")) return json({ error: "unauthorized" }, 401);
  if (!process.env.GHL_TOKEN || !process.env.GHL_LOCATION_ID) return json({ error: "GHL env not set" }, 503);

  const existing = await listFields();
  const byName = {};
  for (const f of existing) byName[String(f.name || "").trim().toLowerCase()] = f;

  const out = [];
  for (const f of CONTACT_FIELDS) {
    if (byName[f.name.trim().toLowerCase()]) { out.push(`${f.name}: exists`); continue; }
    const res = await createField(f);
    out.push(res.ok ? `${f.name}: created` : `${f.name}: FAIL ${res.status} ${res.msg}`);
  }
  return json({ location: process.env.GHL_LOCATION_ID, fields: out });
};

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
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
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
}

async function listFields() {
  const res = await api("GET", `/locations/${process.env.GHL_LOCATION_ID}/customFields?model=contact`);
  return (res.data && res.data.customFields) || [];
}

async function createField(f) {
  const body = clean({ name: f.name, dataType: f.dataType, model: "contact", options: f.options });
  const res = await api("POST", `/locations/${process.env.GHL_LOCATION_ID}/customFields`, body);
  const msg = JSON.stringify((res.data && (res.data.message || res.data.msg)) || "").slice(0, 160);
  return { ok: res.ok, status: res.status, msg };
}

function clean(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") out[k] = obj[k];
  }
  return out;
}
