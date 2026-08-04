/* ============================================================
   Magic-link generator — POST /.netlify/functions/magic-link-admin

   Called by the "Portal magic link" card on /employee.html. Guarded by
   MAGIC_ADMIN_KEY (a real server-side check — the employee page's own
   client-side password is cosmetic and must NOT be trusted here, since
   this endpoint mints tokens that bypass the Kinde login).

   Body (JSON): { key, email, name?, days?, dest? }
   Returns:     { url, expires } or { error }

   Env: MAGIC_LINK_SECRET, MAGIC_ADMIN_KEY
   ============================================================ */

import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { signToken, safeDest, newJti } from "./lib/magic.mjs";

const sha = (s) => createHash("sha256").update(String(s)).digest();
const keysMatch = (a, b) => timingSafeEqual(sha(a), sha(b)); // constant-time, any lengths

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const adminKey = process.env.MAGIC_ADMIN_KEY;
  const secret = process.env.MAGIC_LINK_SECRET;
  if (!adminKey || !secret) {
    return Response.json({ error: "Server not configured (set MAGIC_ADMIN_KEY and MAGIC_LINK_SECRET in Netlify env vars)." }, { status: 500 });
  }

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Bad request" }, { status: 400 }); }

  if (!body || !keysMatch(body.key || "", adminKey)) {
    return Response.json({ error: "Wrong admin key." }, { status: 401 });
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const name = String(body.name || "").trim().slice(0, 60);
  const days = Math.min(30, Math.max(1, Number(body.days) || 7));
  const dest = safeDest(body.dest);

  const payload = {
    e: email,
    n: name,
    x: Math.floor(Date.now() / 1000) + days * 86400,
    d: dest,
    j: newJti()
  };
  const token = signToken(payload, secret);

  // Issue on the canonical host regardless of which host served this call.
  const link = `https://baker1031.com/portal-access?t=${token}`;

  // Audit trail (best-effort)
  try {
    const store = getStore("magic-links");
    await store.setJSON(`issued:${payload.j}`, {
      email, name, dest, days,
      expires: new Date(payload.x * 1000).toISOString(),
      issuedAt: new Date().toISOString()
    });
  } catch { /* logging is optional */ }

  return Response.json(
    { url: link, expires: new Date(payload.x * 1000).toISOString() },
    { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } }
  );
};
