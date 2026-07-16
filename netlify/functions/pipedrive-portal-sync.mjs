/* ============================================================
   Pipedrive → Kinde portal-access sync.

   Receives Pipedrive webhooks (person.updated / person.added).
   When the "Portal Access" custom field flips to Yes → create a
   Kinde login for the person. Flips to No → delete the Kinde user
   (revoking portal access).

   Required Netlify env vars:
     KINDE_DOMAIN, KINDE_M2M_CLIENT_ID, KINDE_M2M_CLIENT_SECRET
       (M2M app needs scopes: create:users, read:users, delete:users)
     PD_WEBHOOK_SECRET        shared secret; webhook URL must include ?secret=...
     PD_FIELD_PORTAL_ACCESS   Pipedrive custom-field key (hash) for "Portal Access"
     PD_PORTAL_YES            option ID (or label) meaning Yes
   ============================================================ */

import { createUser, findUserByEmail, suspendUser, unsuspendUser } from "./lib/kinde.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  if (!process.env.PD_WEBHOOK_SECRET || url.searchParams.get("secret") !== process.env.PD_WEBHOOK_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad request" }, 400); }

  const person = payload.data || payload.current;
  const previous = payload.previous || {};
  if (!person) return json({ ok: true, note: "no person data" });

  const fieldKey = process.env.PD_FIELD_PORTAL_ACCESS;
  if (!fieldKey) return json({ error: "not configured" }, 503);

  const readField = (obj) => {
    if (!obj) return undefined;
    if (obj.custom_fields && fieldKey in obj.custom_fields) {
      const v = obj.custom_fields[fieldKey];
      return v && typeof v === "object" ? (v.id ?? v.value) : v;
    }
    return obj[fieldKey];
  };

  const now = String(readField(person) ?? "");
  const before = String(readField(previous) ?? "");
  if (now === before) return json({ ok: true, note: "portal access unchanged" });

  const yes = String(process.env.PD_PORTAL_YES || "").trim();
  if (!yes) return json({ error: "not configured" }, 503);
  // Only act on an explicit Yes/No; a cleared field is not a grant OR a revoke
  const grant = now === yes || /^yes$/i.test(now);
  if (!grant && now === "") return json({ ok: true, note: "field cleared — no action" });

  // Person's primary email + name
  const emails = person.emails || person.email || [];
  const primary = Array.isArray(emails)
    ? (emails.find((e) => e.primary) || emails[0])
    : { value: emails };
  const email = String((primary && (primary.value || primary)) || "").trim().toLowerCase();
  if (!email) return json({ ok: true, note: "person has no email" });

  const name = String(person.name || "").trim();
  const given = person.first_name || name.split(" ")[0] || "";
  const family = person.last_name || name.split(" ").slice(1).join(" ") || "";

  const token = await kindeToken();
  if (!token) return json({ error: "kinde auth failed" }, 502);

  if (grant) {
    const res = await createUser(token, { email, given, family });
    if (res.ok && !res.created) {
      // pre-existing (possibly suspended) user: reinstate
      const user = await findUserByEmail(token, email);
      if (user && user.is_suspended) await unsuspendUser(token, user.id);
      return json({ ok: true, action: "already exists (unsuspended if needed)", email });
    }
    if (res.ok) return json({ ok: true, action: "created", email });
    return json({ error: "create failed" }, 502);
  } else {
    // Revoke: suspend (preserves the record; falls back to delete if the
    // M2M app lacks update:users)
    const user = await findUserByEmail(token, email);
    if (!user) return json({ ok: true, action: "no kinde user to revoke", email });
    const res = await suspendUser(token, user.id);
    if (res.ok) return json({ ok: true, action: res.action, email });
    return json({ error: "revoke failed" }, 502);
  }
};

async function kindeToken() {
  const res = await fetch(process.env.KINDE_DOMAIN + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.KINDE_M2M_CLIENT_ID,
      client_secret: process.env.KINDE_M2M_CLIENT_SECRET,
      audience: process.env.KINDE_DOMAIN + "/api"
    })
  });
  if (!res.ok) return null;
  return (await res.json()).access_token;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
