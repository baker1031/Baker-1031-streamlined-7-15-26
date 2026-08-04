/* Ongoing Gmail -> HubSpot activity sync.

   The protected gmail-hubspot-backfill function handles the historical sweep.
   This scheduled companion handles two cases afterward:
     1. a newly-created HubSpot contact gets recent and historical matching
        Gmail messages imported automatically;
     2. new Gmail messages involving recently active HubSpot contacts are
        logged without changing Gmail.

   State is held in Netlify Blobs.  Gmail message IDs are never returned to
   callers and are used only for idempotency.
*/

import { getStore } from "@netlify/blobs";
import { createEmail, searchEmailsByMarker } from "./lib/hubspot.mjs";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const HUBSPOT_BASE = "https://api.hubapi.com";
const STORE = "gmail-hubspot-live";
const MAX_NEW_CONTACTS = 4;
const MAX_MESSAGES_PER_CONTACT = 20;
const MAX_GLOBAL_MESSAGES = 15;
let accessTokenCache = null;

export default async () => {
  if (String(process.env.GMAIL_SYNC_ENABLED).toLowerCase() !== "true") {
    console.log("gmail-hubspot-sync: disabled");
    return;
  }
  if (!process.env.HUBSPOT_TOKEN || !process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    console.log("gmail-hubspot-sync: HubSpot and Gmail OAuth credentials are required");
    return;
  }

  const store = getStore(STORE);
  const state = (await store.get("state", { type: "json" })) || { lastRunAt: 0, processed: [], contactWork: {} };
  const processed = new Set(state.processed || []);
  const contacts = await listRecentHubSpotContacts();
  const contactWork = state.contactWork || {};
  for (const contact of contacts) contactWork[contact.email] = { id: contact.id, pageToken: contactWork[contact.email]?.pageToken || null };
  let scanned = 0, created = 0, skipped = 0, errors = 0;

  // New/updated contacts get an address-specific search.  The per-contact
  // Gmail page token is retained so older correspondence continues importing
  // across runs instead of repeatedly returning only the newest messages.
  for (const [email, work] of Object.entries(contactWork).slice(0, MAX_NEW_CONTACTS)) {
    const contact = { id: work.id, email };
    try {
      const page = await gmailList(contactQuery(contact.email), work.pageToken, MAX_MESSAGES_PER_CONTACT);
      for (const message of page.messages || []) {
        const result = await importMessage(message.id, [contact.id], processed);
        scanned += result.scanned; created += result.created; skipped += result.skipped; errors += result.errors;
      }
      if (page.nextPageToken) work.pageToken = page.nextPageToken;
      else delete contactWork[email];
    } catch (error) {
      errors++;
      console.error(`gmail-hubspot-sync: contact ${contact.id} failed`, String(error?.message || error).slice(0, 240));
    }
  }

  // Catch new mail for recently active contacts, including messages that do
  // not have the contact as the direct sender/recipient (CC/BCC included).
  const recentMap = new Map([...contacts, ...Object.entries(contactWork).map(([email, value]) => ({ email, id: value.id }))].map((contact) => [contact.email, contact.id]));
  const after = Math.max(0, Math.floor(Number(state.lastRunAt || (Date.now() - 15 * 60 * 1000)) / 1000) - 120);
  const global = await gmailList(`after:${after} in:anywhere -in:spam -in:trash`, null, MAX_GLOBAL_MESSAGES);
  for (const message of global.messages || []) {
    try {
      const detail = await gmailGet(message.id);
      const ids = matchingContactIds(detail, recentMap);
      if (!ids.length) continue;
      const result = await importNormalized(detail, ids, processed);
      scanned += result.scanned; created += result.created; skipped += result.skipped; errors += result.errors;
    } catch (error) {
      errors++;
      console.error(`gmail-hubspot-sync: message failed`, String(error?.message || error).slice(0, 240));
    }
  }

  const processedList = [...processed].slice(-5000);
  await store.setJSON("state", { lastRunAt: Date.now(), processed: processedList, contactWork });
  console.log(`gmail-hubspot-sync: ${created} email(s) created, ${skipped} duplicate(s), ${errors} error(s), ${scanned} scanned`);
};

async function importMessage(messageId, contactIds, processed) {
  if (processed.has(messageId)) return { scanned: 1, created: 0, skipped: 1, errors: 0 };
  const detail = await gmailGet(messageId);
  return importNormalized(detail, contactIds, processed);
}

async function importNormalized(message, contactIds, processed) {
  if (processed.has(message.id)) return { scanned: 1, created: 0, skipped: 1, errors: 0 };
  const marker = `[Gmail message:${message.id}]`;
  const existing = await searchEmailsByMarker(marker).catch(() => []);
  if (existing.length) {
    processed.add(message.id);
    return { scanned: 1, created: 0, skipped: 1, errors: 0 };
  }
  const created = await createEmail({
    subject: message.subject,
    text: `${message.text || message.html || ""}\n\n${marker}`,
    html: message.html,
    timestamp: message.timestamp,
    contactId: contactIds[0],
    marker
  });
  if (!created?.id) return { scanned: 1, created: 0, skipped: 0, errors: 1 };
  processed.add(message.id);
  return { scanned: 1, created: 1, skipped: 0, errors: 0 };
}

async function listRecentHubSpotContacts() {
  const cutoff = String(Date.now() - 7 * 86400000);
  const response = await hubspotRequest("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: {
      filterGroups: [
        { filters: [{ propertyName: "createdate", operator: "GT", value: cutoff }] },
        { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GT", value: cutoff }] }
      ],
      properties: ["email", "createdate", "hs_lastmodifieddate"],
      limit: 100
    }
  });
  const seen = new Set();
  return (response.results || []).map((contact) => ({ id: contact.id, email: cleanEmail(contact.properties?.email) }))
    .filter((contact) => contact.email && !seen.has(contact.email) && (seen.add(contact.email), true));
}

async function getGmailAccessToken() {
  if (accessTokenCache) return accessTokenCache;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`Gmail OAuth token request failed (${response.status})`);
  accessTokenCache = data.access_token;
  return accessTokenCache;
}

async function gmailList(query, pageToken, limit) {
  const url = new URL(`${GMAIL_BASE}/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(limit));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return gmailRequest(url);
}

async function gmailGet(messageId) {
  const token = await getGmailAccessToken();
  const url = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "full");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gmail message request failed (${response.status})`);
  return normalizeGmailMessage(data);
}

async function gmailRequest(url) {
  const token = await getGmailAccessToken();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gmail list request failed (${response.status})`);
  return data;
}

async function hubspotRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(HUBSPOT_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HubSpot request failed (${response.status})`);
  return data;
}

function contactQuery(email) { return `{from:${email} to:${email} cc:${email} bcc:${email}} in:anywhere -in:spam -in:trash`; }
function cleanEmail(value) { return String(value || "").trim().toLowerCase(); }
function matchingContactIds(message, map) {
  const ids = new Set();
  for (const address of [...addresses(message.from), ...addresses(message.to), ...addresses(message.cc), ...addresses(message.bcc)]) {
    const id = map.get(address);
    if (id) ids.add(id);
  }
  return [...ids];
}
function addresses(value) { return [...String(value || "").matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => cleanEmail(match[0])); }
function normalizeGmailMessage(data) {
  const headers = Object.fromEntries((data.payload?.headers || []).map((header) => [String(header.name).toLowerCase(), header.value || ""]));
  const bodies = { text: "", html: "" };
  collectBodies(data.payload, bodies);
  return { id: data.id, subject: headers.subject || "(No subject)", timestamp: new Date(Number(data.internalDate || Date.now())).toISOString(), text: bodies.text, html: bodies.html, from: headers.from, to: headers.to, cc: headers.cc, bcc: headers.bcc };
}
function collectBodies(part, bodies) {
  if (!part) return;
  const data = part.body?.data ? Buffer.from(String(part.body.data).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
  if (data && part.mimeType === "text/plain" && !bodies.text) bodies.text = data;
  if (data && part.mimeType === "text/html" && !bodies.html) bodies.html = data;
  for (const child of part.parts || []) collectBodies(child, bodies);
}

export const config = { schedule: "*/15 * * * *" };
