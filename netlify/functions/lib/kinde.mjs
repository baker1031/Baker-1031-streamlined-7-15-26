/* Shared Kinde Management API helpers.
   Env: KINDE_DOMAIN, KINDE_M2M_CLIENT_ID, KINDE_M2M_CLIENT_SECRET
   M2M scopes: create:users, read:users, update:users, delete:users */

export async function kindeToken() {
  const domain = process.env.KINDE_DOMAIN;
  const res = await fetch(domain + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.KINDE_M2M_CLIENT_ID,
      client_secret: process.env.KINDE_M2M_CLIENT_SECRET,
      audience: domain + "/api"
    })
  });
  if (!res.ok) return null;
  return (await res.json()).access_token;
}

export async function findUserByEmail(token, email) {
  const res = await fetch(
    process.env.KINDE_DOMAIN + "/api/v1/users?email=" + encodeURIComponent(email),
    { headers: { Authorization: "Bearer " + token } }
  );
  if (!res.ok) return null;
  const found = await res.json();
  return (found.users || [])[0] || null;
}

/* Create a user; treats "already exists" as success.
   Returns { ok, created } or { ok: false, error }. */
export async function createUser(token, { email, given, family }) {
  const res = await fetch(process.env.KINDE_DOMAIN + "/api/v1/user", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: { given_name: given || "", family_name: family || "" },
      identities: [{ type: "email", details: { email } }]
    })
  });
  if (res.ok) return { ok: true, created: true };
  const t = await res.text();
  if (res.status === 400 && /exist|duplicate|already/i.test(t)) return { ok: true, created: false };
  console.error("Kinde create failed:", res.status, t.slice(0, 300));
  return { ok: false, error: t };
}

/* Suspend (preferred — preserves the user record) with delete as fallback
   for tenants whose M2M app lacks update:users. */
export async function suspendUser(token, userId) {
  const patch = await fetch(
    process.env.KINDE_DOMAIN + "/api/v1/user?id=" + encodeURIComponent(userId),
    {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ is_suspended: true })
    }
  );
  if (patch.ok) return { ok: true, action: "suspended" };
  const del = await fetch(
    process.env.KINDE_DOMAIN + "/api/v1/user?id=" + encodeURIComponent(userId),
    { method: "DELETE", headers: { Authorization: "Bearer " + token } }
  );
  if (del.ok) return { ok: true, action: "deleted" };
  console.error("Kinde suspend+delete both failed:", patch.status, del.status);
  return { ok: false };
}

export async function unsuspendUser(token, userId) {
  const res = await fetch(
    process.env.KINDE_DOMAIN + "/api/v1/user?id=" + encodeURIComponent(userId),
    {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ is_suspended: false })
    }
  );
  return res.ok;
}
