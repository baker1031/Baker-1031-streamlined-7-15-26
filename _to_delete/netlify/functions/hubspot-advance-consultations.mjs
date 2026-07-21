/* ============================================================
   Consultation auto-advance (scheduled).

   Cal.com has no reliable "meeting ended" webhook, so this poller does #6:
   once a booked consultation's end time has passed (plus a short grace window
   to allow a late no-show marking) and it was NOT marked a no-show, it advances
   that contact's deal from "Consultation Scheduled" → "Reviewing Opportunities".

   Queue is written by cal-booking.mjs into the "hs-consultations" Netlify Blobs
   store on BOOKING_CREATED/RESCHEDULED; no-shows and cancellations remove/flag
   their entry there, so this poller only ever advances the ones that happened.

   Guardrails:
     - only advances a deal that is STILL in "Consultation Scheduled" (so a deal
       you moved forward manually is left alone — just dropped from the queue)
     - GRACE_MS delay after end time before advancing (default 20 min)

   Env: HUBSPOT_TOKEN
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { hs, updateDeal } from "./lib/hubspot.mjs";
import { DEAL_STAGES, PIPELINE } from "./lib/hs-config.mjs";

const GRACE_MS = Number(process.env.HS_CONSULT_GRACE_MIN || 20) * 60000;

export default async () => {
  if (!process.env.HUBSPOT_TOKEN) { console.log("hs-advance: not configured"); return; }

  const store = getStore("hs-consultations");
  const now = Date.now();
  let advanced = 0, pending = 0, dropped = 0;

  let cursor;
  do {
    const page = await store.list({ cursor }).catch(() => null);
    if (!page) break;
    cursor = page.cursor;

    for (const b of page.blobs || []) {
      const rec = await store.get(b.key, { type: "json" }).catch(() => null);
      if (!rec) { await store.delete(b.key).catch(() => {}); dropped++; continue; }
      if (rec.noShow) { await store.delete(b.key).catch(() => {}); dropped++; continue; } // handled at webhook
      if (!rec.endTime) { pending++; continue; }                                          // open-ended booking
      if (new Date(rec.endTime).getTime() + GRACE_MS > now) { pending++; continue; }      // not over (yet)

      // Only advance if the deal is STILL sitting in Consultation Scheduled.
      let advance = true;
      if (rec.dealId) {
        const d = await hs(`/crm/v3/objects/deals/${rec.dealId}?properties=dealstage`);
        const stage = d.data && d.data.properties && d.data.properties.dealstage;
        advance = stage === DEAL_STAGES.CONSULTATION_SCHEDULED;
        if (advance) await updateDeal(rec.dealId, { dealstage: DEAL_STAGES.REVIEWING, pipeline: PIPELINE });
      }
      await store.delete(b.key).catch(() => {});
      if (advance) advanced++; else dropped++;
    }
  } while (cursor);

  console.log(`hs-advance: advanced ${advanced}, still pending ${pending}, dropped ${dropped}`);
};

/* Every 15 minutes (matches the other pollers' cadence). */
export const config = { schedule: "*/15 * * * *" };
