/* Shared magic-link token helpers.

   Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 sig)
   Payload keys (kept short — the token rides in a URL):
     e = email (lowercase)
     n = display name (first name, for the portal welcome nav)
     x = expiry (unix seconds)
     d = destination path (default /current-offerings)
     j = jti — random id, makes every issued link unique + auditable

   Env: MAGIC_LINK_SECRET (Netlify env var — NEVER commit; repo is public).

   The signature makes tokens unforgeable without the secret. Client-side
   auth.js only *decodes* the payload (it cannot verify HMAC without the
   secret) — that is deliberate and matches the site's existing gate depth:
   the portal gate is a client-side lead wall, not a security boundary
   (full content ships in the HTML for crawlers). Server-side redemption
   in magic-link.mjs is where real verification happens.               */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function signToken(payload, secret) {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(p).digest("base64url");
  return p + "." + sig;
}

export function verifyToken(token, secret) {
  if (!secret) return { ok: false, reason: "server-not-configured" };
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let got;
  try { got = Buffer.from(parts[1], "base64url"); } catch { return { ok: false, reason: "malformed" }; }
  const expect = createHmac("sha256", secret).update(parts[0]).digest();
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) {
    return { ok: false, reason: "bad-signature" };
  }
  let p;
  try { p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!p || typeof p.x !== "number") return { ok: false, reason: "malformed" };
  if (Math.floor(Date.now() / 1000) > p.x) return { ok: false, reason: "expired", payload: p };
  return { ok: true, payload: p };
}

/* Destination must be a same-site absolute path — never a full URL, so a
   crafted token can't turn the redeem endpoint into an open redirect. */
export function safeDest(d) {
  const s = String(d || "");
  if (s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") && !/[\r\n]/.test(s)) return s;
  return "/current-offerings";
}

export const newJti = () => randomBytes(8).toString("hex");
