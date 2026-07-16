/* ============================================================
   Nightly rebuild — republishes the site so offering pages and
   listing cards pick up the day's edits to the Master Listings
   Google Sheet (scripts/build-offerings.mjs runs on every build).

   Fires at 09:00 UTC = 2:00 AM Pacific, daily.
   Env: BUILD_HOOK_URL (a Netlify build hook for this site).
   ============================================================ */

export default async () => {
  const hook = process.env.BUILD_HOOK_URL;
  if (!hook) {
    return new Response(JSON.stringify({ ok: false, note: "BUILD_HOOK_URL not set" }), { status: 200 });
  }
  const res = await fetch(hook, { method: "POST" });
  return new Response(JSON.stringify({ ok: res.ok, status: res.status }), { status: 200 });
};

export const config = { schedule: "0 9 * * *" };
