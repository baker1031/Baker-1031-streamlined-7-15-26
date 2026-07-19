/* ============================================================
   HubSpot → Kinde portal-access sync (POLLER).

   The HubSpot equivalent of pipedrive-portal-sync.mjs. Because the
   account is on a Free/Starter tier (no Workflows to fire a webhook on a
   property change), this runs on a schedule and diffs the "Portal Access"
   contact property against the last value we saw:
     Portal Access = Yes  → create (or unsuspend) the Kinde login
     Portal Access = No   → suspend the Kinde login (revoke access)
   A cleared field drops out of the search and is left untouched — same
   "cleared = no action" rule as the Pipedrive version.

   State: Netlify Blobs ("hubspot-portal") — per-contact last-seen value.

   Env: HUBSPOT_TOKEN
        KINDE_DOMAIN, KINDE_M2M_CLIENT_ID, KINDE_M2M_CLIENT_SECRET
          (M2M scopes: create:users, read:users, update:users, delete:users)
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { hs } from "./lib/hubspot.mjs";
import { kindeToken, createUser, findUserByEmail, suspendUser, unsuspendUser } from "./lib/kinde.mjs";

export default async () => {
  if (!process.env.HUBSPOT_TOKEN) { console.log("hs-portal-sync: no HUBSPOT_TOKEN"); return; }

  const contacts = await searchPortalContacts();
  if (!contacts.length) { console.log("hs-portal-sync: no contacts with Portal Access set"); return; }

  const store = getStore("hubspot-portal");
  const token = await kindeToken();
  if (!token) { console.error("hs-portal-sync: kinde auth failed"); return; }

  let acted = 0;
  for (const c of contacts) {
    const now = String((c.properties && c.properties.portal_access) || "").trim();
    const prev = (await store.get(`pa:${c.id}`).catch(() => null)) || "";
    if (now === prev) continue; // unchanged since last run

    const email = String((c.properties && c.properties.email) || "").trim().toLowerCase();
    if (!email) continue;
    const given = (c.properties && c.properties.firstname) || "";
    const family = (c.properties && c.properties.lastname) || "";

    if (/^yes$/i.test(now)) {
      const res = await createUser(token, { email, given, family });
      if (res.ok && !res.created) {
        // pre-existing (maybe suspended) login → reinstate
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

  console.log(`hs-portal-sync: ${acted} change(s) across ${contacts.length} contact(s) with Portal Access set`);
};

/* All contacts whose Portal Access is explicitly Yes or No (OR filter). */
async function searchPortalContacts() {
  const out = [];
  let after;
  do {
    const body = {
      filterGroups: [
        { filters: [{ propertyName: "portal_access", operator: "EQ", value: "Yes" }] },
        { filters: [{ propertyName: "portal_access", operator: "EQ", value: "No" }] }
      ],
      properties: ["email", "firstname", "lastname", "portal_access"],
      sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
      limit: 100,
      ...(after ? { after } : {})
    };
    const res = await hs(`/crm/v3/objects/contacts/search`, { method: "POST", body });
    out.push(...((res.data && res.data.results) || []));
    after = res.data && res.data.paging && res.data.paging.next && res.data.paging.next.after;
  } while (after && out.length < 1000);
  return out;
}

/* Poll every 5 minutes — revoke should take effect quickly. */
export const config = { schedule: "*/5 * * * *" };
