/* Protected Gmail -> HubSpot email-history backfill.

   Dry run:
     GET /.netlify/functions/gmail-hubspot-backfill?secret=...&mode=dry-run&limit=5

   Write run:
     POST /.netlify/functions/gmail-hubspot-backfill?secret=...&mode=write&confirm=IMPORT_GMAIL_TO_HUBSPOT&limit=10

   The importer searches Gmail in small contact batches, stores its cursor in
   Netlify Blobs, and uses gmail_message_id in HubSpot for idempotency. It
   imports message bodies and associates each activity with matching HubSpot
   contacts. Gmail messages are never modified.
*/

import { getStore } from "@netlify/blobs";
import { json } from "./lib/http.mjs";

const STORE_NAME = "gmail-hubspot-backfill";
const STATE_KEY = "state.json";
const MAX_PER_REQUEST = 10;
const CONTACT_BATCH_SIZE = 8;
const MAX_BODY_LENGTH = 65536;
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const HUBSPOT_BASE = "https://api.hubapi.com";

export default async (req) => {
  const url = new URL(req.url);
  if (!isAuthorized(url)) return json({ error: "unauthorized" }, 401);

  const mode = url.searchParams.get("mode") || "dry-run";
  const limit = Math.min(MAX_PER_REQUEST, Math.max(1, Number(url.searchParams.get("limit") || 5)));
  const confirm = url.searchParams.get("confirm");
  if (!["dry-run", "write", "state"].includes(mode)) return json({ error: "mode must be dry-run, write, or state" }, 400);
  if (mode === "write" && (req.method !== "POST" || confirm !== "IMPORT_GMAIL_TO_HUBSPOT")) {
    return json({ error: "write mode requires POST and confirm=IMPORT_GMAIL_TO_HUBSPOT" }, 400);
  }
  if (mode === "write" && env("HUBSPOT_MIGRATION_ENABLED") !== "true") {
    return json({ error: "HUBSPOT_MIGRATION_ENABLED is not true" }, 403);
  }
  if (!env("HUBSPOT_TOKEN")) return json({ error: "HUBSPOT_TOKEN is required" }, 503);
  if (!env("GMAIL_CLIENT_ID") || !env("GMAIL_CLIENT_SECRET") || !env("GMAIL_REFRESH_TOKEN")) {
    return json({ error: "GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN are required" }, 503);
  }

  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  if (url.searchParams.get("reset") === "true") {
    if (mode !== "write" || confirm !== "IMPORT_GMAIL_TO_HUBSPOT") {
      return json({ error: "reset requires write mode and confirm=IMPORT_GMAIL_TO_HUBSPOT" }, 400);
    }
    await store.delete(STATE_KEY);
  }

  const state = (await store.get(STATE_KEY, { type: "json" })) || newState();
  if (mode === "state") return json({ ok: true, state: publicState(state) });

  const accessToken = await getGmailAccessToken();
  const contacts = await listHubSpotContacts();
  if (!contacts.length) return json({ error: "No HubSpot contacts with email addresses were found" }, 502);
  const chunks = chunk(contacts, CONTACT_BATCH_SIZE);
  if (state.chunkIndex >= chunks.length) state.complete = true;

  const stats = {
    ok: true,
    mode,
    scannedMessages: 0,
    emailsCreated: 0,
    duplicateMessages: 0,
    messagesWithoutContact: 0,
    errors: []
  };

  if (!state.complete) {
    if (mode === "write") await ensureGmailMessageProperty();
    const chunkContacts = chunks[state.chunkIndex] || [];
    const query = gmailQuery(chunkContacts.map((contact) => contact.email));
    const page = await gmailList(query, state.pageToken, limit);
    const messages = page.messages || [];

    if (!messages.length) {
      state.chunkIndex += 1;
      state.pageToken = null;
      if (state.chunkIndex >= chunks.length) state.complete = true;
    } else {
      for (const message of messages.slice(0, limit)) {
        stats.scannedMessages++;
        if (state.processedMessageIds.includes(message.id)) {
          stats.duplicateMessages++;
          continue;
        }
        try {
          const detail = await gmailGet(message.id, accessToken);
          const contactIds = matchingContactIds(detail, contacts);
          if (!contactIds.length) {
            stats.messagesWithoutContact++;
            state.processedMessageIds.push(message.id);
            continue;
          }
          if (mode === "dry-run") {
            stats.emailsCreated++;
            continue;
          }
          const existing = await findEmailByGmailId(message.id);
          if (existing) {
            stats.duplicateMessages++;
          } else {
            await createHubSpotEmail(detail, contactIds);
            stats.emailsCreated++;
          }
          state.processedMessageIds.push(message.id);
        } catch (error) {
          stats.errors.push({ id: message.id, message: String(error?.message || error).slice(0, 240) });
        }
      }

      if (mode === "write") {
        state.pageToken = page.nextPageToken || null;
        if (!page.nextPageToken) {
          state.chunkIndex += 1;
          state.pageToken = null;
          if (state.chunkIndex >= chunks.length) state.complete = true;
        }
      }
    }
  }

  state.lastRunAt = new Date().toISOString();
  state.totalScannedMessages += stats.scannedMessages;
  state.totalEmailsCreated += stats.emailsCreated;
  state.totalDuplicates += stats.duplicateMessages;
  state.totalMessagesWithoutContact += stats.messagesWithoutContact;
  state.lastErrors = stats.errors.slice(-20);
  if (mode === "write") await store.setJSON(STATE_KEY, state);

  return json({ ...stats, state: publicState(state), nextChunk: state.chunkIndex, nextPageToken: state.pageToken });
};

function newState() {
  return {
    version: 1,
    chunkIndex: 0,
    pageToken: null,
    complete: false,
    processedMessageIds: [],
    totalScannedMessages: 0,
    totalEmailsCreated: 0,
    totalDuplicates: 0,
    totalMessagesWithoutContact: 0,
    lastErrors: [],
    lastRunAt: null
  };
}

function publicState(state) {
  return {
    version: state.version,
    chunkIndex: state.chunkIndex,
    complete: Boolean(state.complete),
    processedMessageCount: state.processedMessageIds.length,
    totalScannedMessages: state.totalScannedMessages,
    totalEmailsCreated: state.totalEmailsCreated,
    totalDuplicates: state.totalDuplicates,
    totalMessagesWithoutContact: state.totalMessagesWithoutContact,
    lastErrors: state.lastErrors,
    lastRunAt: state.lastRunAt
  };
}

function isAuthorized(url) {
  const secret = env("HS_SETUP_SECRET");
  return Boolean(secret && url.searchParams.get("secret") === secret);
}

function env(name) {
  return globalThis.Netlify?.env?.get(name);
}

function chunk(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function gmailQuery(emails) {
  return `{${emails.map((email) => `from:${email} to:${email}`).join(" ")}} in:anywhere -in:spam -in:trash`;
}

async function getGmailAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GMAIL_CLIENT_ID"),
      client_secret: env("GMAIL_CLIENT_SECRET"),
      refresh_token: env("GMAIL_REFRESH_TOKEN"),
      grant_type: "refresh_token"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`Gmail OAuth token request failed (${response.status})`);
  return data.access_token;
}

async function gmailList(query, pageToken, limit) {
  const url = new URL(`${GMAIL_BASE}/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(limit));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return gmailRequest(url);
}

async function gmailGet(messageId, accessToken) {
  const url = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "full");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gmail message ${messageId} failed (${response.status})`);
  return normalizeGmailMessage(data);
}

async function gmailRequest(url) {
  const accessToken = await getGmailAccessToken();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gmail request failed (${response.status})`);
  return data;
}

async function listHubSpotContacts() {
  const contacts = [];
  let after;
  do {
    const response = await hubspotRequest("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: {
        filterGroups: [],
        properties: ["email"],
        limit: 100,
        ...(after ? { after } : {})
      }
    });
    for (const result of response.results || []) {
      const email = cleanEmail(result.properties?.email);
      if (email) contacts.push({ id: result.id, email });
    }
    after = response.paging?.next?.after;
  } while (after);
  return contacts;
}

async function ensureGmailMessageProperty() {
  const existing = await hubspotRequest("/crm/v3/properties/emails/gmail_message_id", { allow404: true });
  if (existing?.name === "gmail_message_id") return;
  const response = await hubspotRequest("/crm/v3/properties/emails", {
    method: "POST",
    body: {
      name: "gmail_message_id",
      label: "Gmail Message ID",
      type: "string",
      fieldType: "text",
      groupName: "emailinformation",
      hidden: false
    },
    allow409: true
  });
  if (!response && !existing) throw new Error("Could not create or find gmail_message_id property");
}

async function findEmailByGmailId(messageId) {
  const result = await hubspotRequest("/crm/v3/objects/emails/search", {
    method: "POST",
    body: {
      filterGroups: [{ filters: [{ propertyName: "gmail_message_id", operator: "EQ", value: messageId }] }],
      properties: ["gmail_message_id"],
      limit: 1
    }
  });
  return result.results?.[0] || null;
}

async function createHubSpotEmail(message, contactIds) {
  const properties = {
    gmail_message_id: message.id,
    hs_email_subject: message.subject || "(No subject)",
    hs_timestamp: message.timestamp,
    hs_email_direction: "EMAIL",
    hs_email_text: String(message.text || message.html || "").slice(0, MAX_BODY_LENGTH),
    ...(message.html ? { hs_email_html: message.html.slice(0, MAX_BODY_LENGTH) } : {})
  };
  const associations = contactIds.map((id) => ({
    to: { id: String(id) },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 198 }]
  }));
  const result = await hubspotRequest("/crm/v3/objects/emails", {
    method: "POST",
    body: { properties, associations }
  });
  if (!result?.id) throw new Error("HubSpot email create returned no ID");
  return result;
}

async function hubspotRequest(path, { method = "GET", body, allow404 = false, allow409 = false } = {}) {
  const response = await fetch(HUBSPOT_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${env("HUBSPOT_TOKEN")}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 404 && allow404) return null;
  if (response.status === 409 && allow409) return null;
  if (!response.ok) throw new Error(`HubSpot ${method} ${path} failed (${response.status}): ${String(data.message || "request error").slice(0, 180)}`);
  return data;
}

function normalizeGmailMessage(data) {
  const headers = Object.fromEntries((data.payload?.headers || []).map((header) => [String(header.name).toLowerCase(), header.value || ""]));
  const bodies = { text: "", html: "" };
  collectBodies(data.payload, bodies);
  const timestamp = new Date(Number(data.internalDate || Date.now())).toISOString();
  return {
    id: data.id,
    subject: headers.subject || "(No subject)",
    timestamp,
    text: bodies.text,
    html: bodies.html,
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    bcc: headers.bcc
  };
}

function collectBodies(part, bodies) {
  if (!part) return;
  const data = part.body?.data ? decodeBase64Url(part.body.data) : "";
  if (data && part.mimeType === "text/plain" && !bodies.text) bodies.text = data;
  if (data && part.mimeType === "text/html" && !bodies.html) bodies.html = data;
  for (const child of part.parts || []) collectBodies(child, bodies);
}

function decodeBase64Url(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function addresses(value) {
  return [...String(value || "").matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => cleanEmail(match[0]));
}

function matchingContactIds(message, contacts) {
  const byEmail = new Map(contacts.map((contact) => [contact.email, contact.id]));
  const ids = new Set();
  for (const address of [...addresses(message.from), ...addresses(message.to), ...addresses(message.cc), ...addresses(message.bcc)]) {
    const id = byEmail.get(address);
    if (id) ids.add(id);
  }
  return [...ids];
}
