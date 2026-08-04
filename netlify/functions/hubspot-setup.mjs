/* One-time, idempotent HubSpot schema setup.
   Call with ?secret=<HS_SETUP_SECRET>. It creates only missing properties. */

import { json, requireSecret } from "./lib/http.mjs";
import { hs } from "./lib/hubspot.mjs";
import { CONTACT_PROPERTY_DEFINITIONS, DEAL_PROPERTY_DEFINITIONS } from "./lib/hs-config.mjs";

export default async (req) => {
  if (!requireSecret(req, "HS_SETUP_SECRET")) return json({ error: "unauthorized" }, 401);
  if (!process.env.HUBSPOT_TOKEN) return json({ error: "HUBSPOT_TOKEN not configured" }, 503);

  const results = [];
  for (const [objectType, definitions] of [["contacts", CONTACT_PROPERTY_DEFINITIONS], ["deals", DEAL_PROPERTY_DEFINITIONS]]) {
    const existing = await hs(`/crm/v3/properties/${objectType}`);
    if (!existing.ok) return json({ error: `could not read ${objectType} properties`, status: existing.status }, 502);
    const names = new Set((existing.data.results || []).map((property) => property.name));
    for (const definition of definitions) {
      if (names.has(definition.name)) {
        results.push({ objectType, name: definition.name, status: "exists" });
        continue;
      }
      const created = await hs(`/crm/v3/properties/${objectType}`, {
        method: "POST",
        body: {
          ...definition,
          groupName: objectType === "contacts" ? "contactinformation" : "dealinformation",
          hidden: false
        }
      });
      results.push({ objectType, name: definition.name, status: created.ok ? "created" : "failed", httpStatus: created.status });
    }
  }
  return json({ ok: true, results });
};
