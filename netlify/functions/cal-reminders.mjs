/* Cal.com appointment reminders — INERT as of 2026-08-06.
 *
 * This function existed only to fire Loops reminder events (24-hour and
 * 1-hour) for Cal.com phone appointments. Loops has been removed from the
 * stack and appointment reminders are handled by the GoHighLevel workflows
 * again, so there is no provider left for it to call.
 *
 * The file is kept — rather than deleted — because the rest of the Cal.com
 * integration (cal-webhook.mjs) is still deployed but dormant. If Cal.com is
 * ever reinstated with an email provider, restore the reminder logic from
 * commit 30260205 and re-add the schedule export at the bottom.
 *
 * The `export const config` schedule has been REMOVED so this no longer burns
 * a scheduled invocation every 5 minutes. Re-adding it is a one-line change:
 *   export const config = { schedule: "*\/5 * * * *" };
 */

export default async () => {
  console.log(JSON.stringify({
    status: "inert",
    reason: "Loops removed 2026-08-06; appointment reminders handled by GoHighLevel"
  }));
};
