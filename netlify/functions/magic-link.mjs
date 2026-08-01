/* ============================================================
   Magic-link redemption — GET /portal-access?t=<token>
   (netlify.toml rewrites /portal-access → this function)

   Special-situation portal entry that bypasses the Kinde login:
   verifies the HMAC-signed token (see lib/magic.mjs), records the
   use in Netlify Blobs for Jerry's records, drops the token in a
   cookie js/auth.js recognizes as a session, and redirects into
   the portal. Links are multi-use until their expiry (default 7
   days) — deliberately, so corporate email scanners that pre-click
   links don't burn them before the client sees the portal.

   Env: MAGIC_LINK_SECRET
   ============================================================ */

import { getStore } from "@netlify/blobs";
import { verifyToken, safeDest } from "./lib/magic.mjs";

const COOKIE = "b1031_magic";

function expiredPage(reason) {
  const msg = reason === "expired"
    ? "This access link has expired."
    : "This access link isn&rsquo;t valid.";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Link expired &middot; Baker 1031</title>
<style>body{font-family:Georgia,serif;background:#f7f5f1;color:#22302c;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border:1px solid #e2ddd3;border-radius:10px;padding:2.2rem 2.6rem;max-width:26rem;text-align:center;box-shadow:0 2px 14px rgba(0,0,0,.06)}
h1{font-size:1.25rem;margin:0 0 .6rem}p{font-size:.95rem;line-height:1.6;color:#5a6560;margin:0 0 1.2rem}
a{display:inline-block;background:#22302c;color:#fff;text-decoration:none;padding:.6rem 1.2rem;border-radius:6px;font-size:.9rem}</style></head>
<body><div class="card"><h1>${msg}</h1>
<p>For your security, portal access links only work for a limited time. Reach out and we&rsquo;ll send you a fresh one, or sign in as usual.</p>
<a href="/">Back to baker1031.com</a></div></body></html>`,
    { status: 410, headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" } }
  );
}

export default async (req) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const t = url.searchParams.get("t") || "";
  const v = verifyToken(t, process.env.MAGIC_LINK_SECRET);
  if (!v.ok) return expiredPage(v.reason);

  const p = v.payload;

  // Audit trail (best-effort — never block the client on logging)
  try {
    const store = getStore("magic-links");
    await store.setJSON(`use:${p.j || "nojti"}:${Date.now()}`, {
      email: p.e || "",
      jti: p.j || "",
      at: new Date().toISOString(),
      ua: req.headers.get("user-agent") || "",
      ip: req.headers.get("x-nf-client-connection-ip") || ""
    });
  } catch { /* logging is optional */ }

  // Cookie lives exactly as long as the token. Not HttpOnly on purpose:
  // js/auth.js reads it to render the signed-in portal nav.
  const maxAge = Math.max(60, p.x - Math.floor(Date.now() / 1000));
  return new Response(null, {
    status: 302,
    headers: {
      Location: safeDest(p.d),
      "Set-Cookie": `${COOKIE}=${encodeURIComponent(t)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
};
