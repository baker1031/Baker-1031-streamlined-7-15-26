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
  const grant = now === yes || /^yes$/i.test(now);

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
    const res = await fetch(process.env.KINDE_DOMAIN + "/api/v1/user", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: { given_name: given, family_name: family },
        identities: [{ type: "email", details: { email } }]
      })
    });
    if (res.ok) return json({ ok: true, action: "created", email });
    const t = await res.text();
    if (res.status === 400 && /exist|duplicate|already/i.test(t)) return json({ ok: true, action: "already exists", email });
    console.error("Kinde create failed:", res.status, t);
    return json({ error: "create failed" }, 502);
  } else {
    // Revoke: find the Kinde user by email, then delete
    const lookup = await fetch(process.env.KINDE_DOMAIN + "/api/v1/users?email=" + encodeURIComponent(email), {
      headers: { Authorization: "Bearer " + token }
    });
    if (!lookup.ok) return json({ error: "lookup failed" }, 502);
    const found = await lookup.json();
    const user = (found.users || [])[0];
    if (!user) return json({ ok: true, action: "no kinde user to revoke", email });
    const del = await fetch(process.env.KINDE_DOMAIN + "/api/v1/user?id=" + encodeURIComponent(user.id), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + token }
    });
    if (del.ok) return json({ ok: true, action: "revoked", email });
    console.error("Kinde delete failed:", del.status, await del.text());
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
