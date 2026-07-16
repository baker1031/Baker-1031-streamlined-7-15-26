/* ============================================================
   Auto-provision a Kinde account after the request-access form
   is completed AND a meeting is booked through Cal.com.

   Called from the site (POST JSON: { email, given_name, family_name }).
   Uses the Kinde Management API via an M2M application.

   Required Netlify environment variables:
     KINDE_DOMAIN            e.g. https://baker1031investments.kinde.com
     KINDE_M2M_CLIENT_ID     from a Kinde "Machine to machine" app
     KINDE_M2M_CLIENT_SECRET with Management API scope: create:users
   ============================================================ */

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }

  const email = String(body.email || "").trim().toLowerCase();
  const given = String(body.given_name || "").trim().slice(0, 100);
  const family = String(body.family_name || "").trim().slice(0, 100);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "invalid email" }, 400);
  }

  const domain = process.env.KINDE_DOMAIN;
  const clientId = process.env.KINDE_M2M_CLIENT_ID;
  const clientSecret = process.env.KINDE_M2M_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) {
    return json({ error: "provisioning not configured" }, 503);
  }

  // 1) M2M token for the Management API
  const tokenRes = await fetch(domain + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: domain + "/api"
    })
  });
  if (!tokenRes.ok) return json({ error: "kinde auth failed" }, 502);
  const { access_token } = await tokenRes.json();

  // 2) Create the user (idempotent: an existing user is a success)
  const createRes = await fetch(domain + "/api/v1/user", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + access_token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      profile: { given_name: given, family_name: family },
      identities: [{ type: "email", details: { email } }]
    })
  });

  if (createRes.ok) return json({ ok: true, created: true });

  const errText = await createRes.text();
  if (createRes.status === 400 && /exist|duplicate|already/i.test(errText)) {
    return json({ ok: true, created: false });
  }
  console.error("Kinde user create failed:", createRes.status, errText);
  return json({ error: "create failed" }, 502);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
