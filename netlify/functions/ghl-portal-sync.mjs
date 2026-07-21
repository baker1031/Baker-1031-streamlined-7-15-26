/* ============================================================
   GoHighLevel → Kinde portal-access sync (POLLER).

   The GHL equivalent of hubspot-portal-sync.mjs. Runs on a schedule and
   diffs each contact's "Portal Access" field against the last value we
   saw (Netlify Blobs), driving the Kinde login:
     Portal Access = Yes  → create (or unsuspend) the Kinde login
     Portal Access = No   → suspend the Kinde login (revoke access)
   A cleared/blank field is left untouched (same "cleared = no action"
   rule as the Pipedrive/HubSpot versions).

   Poller (not a webhook) so it needs ZERO GHL workflow/trigger wiring and
   catches both manual grants/revokes and the Yes set by ghl-booking.

   State: Netlify Blobs ("ghl-portal") — per-contact last-seen value.

   Env: GHL_TOKEN, GHL_LOCATION_ID
        KINDE_DOMAIN, KINDE_M2M_CLIENT_ID, KINDE_M2M_CLIENT_SECRET
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { getContactFieldMap, listContacts } from "./lib/ghl.mjs";
import { kindeToken, createUser, findUserByEmail, suspendUser, unsuspendUser } from "./lib/kinde.mjs";
import { PORTAL_FIELD_NAME } from "./lib/ghl-config.mjs";

export default async () => {
  if (!process.env.GHL_TOKEN) { console.log("ghl-portal-sync: no GHL_TOKEN"); return; }

  const fieldMap = await getContactFieldMap();
  const portalId = fieldMap[PORTAL_FIELD_NAME.trim().toLowerCase()];
  if (!portalId) { console.log("ghl-portal-sync: Portal Access field not found (run ghl-setup?)"); return; }

  const token = await kindeToken();
  if (!token) { console.error("ghl-portal-sync: kinde auth failed"); return; }

  const store = getStore("ghl-portal");
  let acted = 0, scanned = 0, pages = 0, startAfterId, startAfter;

  do {
    const page = await listContacts({ limit: 100, startAfterId, startAfter });
    const contacts = page.contacts || [];
    for (const c of contacts) {
      scanned++;
      const cf = (c.customFields || c.customField || []).find((f) => f.id === portalId);
      const now = String((cf && (cf.value ?? cf.field_value)) || "").trim();
      if (!now) continue; // unset/cleared → no action

      const prev = (await store.get(`pa:${c.id}`).catch(() => null)) || "";
      if (now === prev) continue; // unchanged since last run

      const email = String(c.email || "").trim().toLowerCase();
      if (!email) continue;

      if (/^yes$/i.test(now)) {
        const res = await createUser(token, { email, given: c.firstName || "", family: c.lastName || "" });
        if (res.ok && !res.created) {
          const user = await findUserByEmail(token, email);
          if (user && user.is_suspended) await unsuspendUser(token, user.id);
        }
      } else if (/^no$/i.test(now)) {
        const user = await findUserByEmail(token, email);
        if (user) await suspendUser(token, user.id);
      }

      await store.set(`pa:${c.id}`, now).catch(() => {});
      acted++;
    }
    const meta = page.meta || {};
    startAfterId = meta.startAfterId;
    startAfter = meta.startAfter;
    pages++;
  } while ((startAfterId || startAfter) && pages < 50);

  console.log(`ghl-portal-sync: ${acted} change(s) across ${scanned} contact(s)`);
};

/* Poll every 5 minutes — revoke should take effect quickly. */
export const config = { schedule: "*/5 * * * *" };
