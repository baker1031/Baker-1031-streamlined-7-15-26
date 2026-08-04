/* HubSpot -> GHL/Kinde portal-access sync (POLLER).

   HubSpot is allowed to be the operator-facing control surface.  When the
   Portal Access contact property changes, this function provisions or
   suspends the Kinde user and writes the same value back to GHL.  The separate
   GHL poller remains active, so either CRM can be used without a write loop.

   Env: HUBSPOT_TOKEN, GHL_TOKEN, GHL_LOCATION_ID,
        KINDE_DOMAIN, KINDE_M2M_CLIENT_ID, KINDE_M2M_CLIENT_SECRET
*/

import { getStore } from "@netlify/blobs";
import { searchPage } from "./lib/hubspot.mjs";
import { buildContactFields, PORTAL_FIELD_NAME } from "./lib/ghl-config.mjs";
import { getContactFieldMap, upsertContact as upsertGhlContact } from "./lib/ghl.mjs";
import { kindeToken, createUser, findUserByEmail, suspendUser, unsuspendUser } from "./lib/kinde.mjs";
import { properName } from "./lib/name.mjs";

export default async () => {
  if (!process.env.HUBSPOT_TOKEN) { console.log("hubspot-portal-sync: no HUBSPOT_TOKEN"); return; }
  if (!process.env.KINDE_DOMAIN || !process.env.KINDE_M2M_CLIENT_ID || !process.env.KINDE_M2M_CLIENT_SECRET) {
    console.log("hubspot-portal-sync: Kinde credentials not configured");
    return;
  }

  const token = await kindeToken();
  if (!token) { console.error("hubspot-portal-sync: Kinde auth failed"); return; }
  const fieldMap = process.env.GHL_TOKEN ? await getContactFieldMap() : null;
  const store = getStore("hubspot-portal");
  let after;
  let scanned = 0, acted = 0, errors = 0;

  do {
    const page = await searchPage("contacts", [{ propertyName: "portal_access", operator: "HAS_PROPERTY" }], [
      "email", "firstname", "lastname", "phone", "portal_access", "ghl_contact_id", "hs_lastmodifieddate"
    ], after);
    for (const contact of page.results || []) {
      scanned++;
      const email = String(contact.properties?.email || "").trim().toLowerCase();
      const value = String(contact.properties?.portal_access || "").trim();
      if (!email || !/^(yes|no)$/i.test(value)) continue;
      const key = `pa:${contact.id}`;
      const previous = await store.get(key).catch(() => null);
      if (previous === value) continue;

      try {
        const first = properName(contact.properties?.firstname);
        const last = properName(contact.properties?.lastname);
        if (/^yes$/i.test(value)) {
          const result = await createUser(token, { email, given: first, family: last });
          if (result.ok && !result.created) {
            const user = await findUserByEmail(token, email);
            if (user?.is_suspended) await unsuspendUser(token, user.id);
          }
        } else {
          const user = await findUserByEmail(token, email);
          if (user) await suspendUser(token, user.id);
        }

        if (process.env.GHL_TOKEN && fieldMap) {
          const customFields = buildContactFields(fieldMap, { portal_access: /^yes$/i.test(value) ? "Yes" : "No" });
          await upsertGhlContact({
            email,
            firstName: first,
            lastName: last,
            phone: contact.properties?.phone,
            customFields
          });
        }

        await store.set(key, value);
        acted++;
      } catch (error) {
        errors++;
        console.error(`hubspot-portal-sync: ${contact.id} failed`, String(error?.message || error).slice(0, 240));
      }
    }
    after = page.paging?.next?.after;
  } while (after && scanned < 500);

  console.log(`hubspot-portal-sync: ${acted} change(s), ${errors} error(s), ${scanned} scanned`);
};

export const config = { schedule: "*/5 * * * *" };
