/* Shared HTTP helpers for Netlify functions. */

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function ok(note) {
  return json({ ok: true, note });
}

/* Fail-closed shared-secret check: the env var must exist AND match ?secret=. */
export function requireSecret(req, envName) {
  const secret = process.env[envName];
  const url = new URL(req.url);
  return Boolean(secret && url.searchParams.get("secret") === secret);
}

/* Cal.com HMAC verification: X-Cal-Signature-256 = HMAC-SHA256(rawBody, secret).
   Returns true when the header is present and matches. */
export async function verifyCalSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === String(signatureHeader).trim().toLowerCase();
}
