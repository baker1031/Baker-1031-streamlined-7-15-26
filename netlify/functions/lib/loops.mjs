/* Minimal Loops API client. The API key is read only inside Netlify Functions. */

const BASE = "https://app.loops.so/api/v1";

export async function syncRegistrationToLoops(data = {}) {
  const apiKey = process.env.LOOPS_API_KEY;
  const email = String(data.email || "").trim().toLowerCase();
  if (!apiKey) return { skipped: true, reason: "LOOPS_API_KEY not configured" };
  if (!email) return { skipped: true, reason: "email missing" };

  const properties = clean({
    email,
    firstName: String(data.first_name || "").trim() || undefined,
    lastName: String(data.last_name || "").trim() || undefined,
    source: "Baker 1031 website"
  });

  const response = await fetch(`${BASE}/contacts/update`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(properties)
  });

  let body = {};
  try { body = await response.json(); } catch { /* empty response */ }
  if (!response.ok) {
    const detail = body?.message || body?.error || `HTTP ${response.status}`;
    throw new Error(`Loops contact sync failed: ${detail}`);
  }
  return { synced: true, email };
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}
