/* ============================================================
   Pipedrive ⇄ TickTick task sync (scheduled, every 15 min).

   Direction rules (per Jerry):
   - Pipedrive activities (not done) → tasks in the TickTick
     "Pipedrive" project. Subject/due-date changes sync over.
   - Completing a task in TickTick → marks the Pipedrive activity
     done. Notes typed on the TickTick task are appended to the
     Pipedrive activity's note.
   - Tasks Jerry creates himself in TickTick are IGNORED — only
     tasks this sync created (tracked in the mapping) flow back.
   - Activity completed/deleted in Pipedrive → TickTick task is
     completed/removed.

   State: mapping stored in Netlify Blobs (store "ticktick-sync").
   Env: TICKTICK_TOKEN, TICKTICK_PROJECT_ID, PIPEDRIVE_API_TOKEN,
        optional PD_COMPANY_DOMAIN for deep links.
   ============================================================ */

import { getStore } from "@netlify/blobs";

const TT = "https://api.ticktick.com/open/v1";
const PD = "https://api.pipedrive.com/v1";

export default async () => {
  const ttToken = process.env.TICKTICK_TOKEN;
  const pdToken = process.env.PIPEDRIVE_API_TOKEN;
  const projectId = process.env.TICKTICK_PROJECT_ID;
  if (!ttToken || !pdToken || !projectId) return json({ ok: false, note: "not configured" });

  const store = getStore("ticktick-sync");
  const map = (await store.get("map", { type: "json" })) || {}; // pdActivityId -> {ttId, subject, due, lastContent}

  // ---------- Pipedrive: open activities ----------
  const open = [];
  let start = 0;
  for (;;) {
    const res = await pd(`/activities?done=0&limit=250&start=${start}`, pdToken);
    (res.data || []).forEach((a) => open.push(a));
    const more = res.additional_data?.pagination?.more_items_in_collection;
    if (!more) break;
    start = res.additional_data.pagination.next_start;
  }
  const openById = Object.fromEntries(open.map((a) => [String(a.id), a]));
  const summary = { completedInPd: 0, notesSynced: 0, created: 0, updated: 0, closedInTt: 0 };

  // ---------- Pass 1: TickTick → Pipedrive (completions + notes) ----------
  for (const [pdId, m] of Object.entries(map)) {
    const task = await tt(`/project/${projectId}/task/${m.ttId}`, ttToken).catch(() => null);
    if (!task) {
      // Task deleted in TickTick: forget the mapping, do NOT touch Pipedrive.
      if (!openById[pdId]) delete map[pdId];
      continue;
    }
    // Notes typed on the task flow to the activity note (append-once per change)
    const content = (task.content || "").replace(m.marker || "", "").trim();
    if (content && content !== (m.lastContent || "") && openById[pdId]) {
      const existing = openById[pdId].note || "";
      await pd(`/activities/${pdId}`, pdToken, "PUT", {
        note: `${existing ? existing + "<br>" : ""}<b>TickTick note:</b> ${esc(content)}`
      });
      m.lastContent = content;
      summary.notesSynced++;
    }
    // Completed in TickTick → mark done in Pipedrive
    if (task.status === 2 && openById[pdId]) {
      await pd(`/activities/${pdId}`, pdToken, "PUT", { done: 1 });
      delete openById[pdId];
      delete map[pdId];
      summary.completedInPd++;
    }
  }

  // ---------- Pass 2: Pipedrive → TickTick (create / update / close) ----------
  for (const [pdId, a] of Object.entries(openById)) {
    const due = ttDue(a.due_date, a.due_time);
    const title = a.subject || "(no subject)";
    const who = [a.person_name, a.org_name, a.deal_title].filter(Boolean).join(" · ");
    const marker = `PD#${pdId}`;
    const content = [who, `Type: ${a.type || "task"}`, marker].filter(Boolean).join("\n");

    if (!map[pdId]) {
      const created = await tt(`/task`, ttToken, "POST", {
        title, projectId, content,
        ...(due ? { dueDate: due, isAllDay: !a.due_time } : {})
      });
      if (created && created.id) {
        map[pdId] = { ttId: created.id, subject: title, due: due || "", marker, lastContent: "" };
        summary.created++;
      }
    } else if (map[pdId].subject !== title || (map[pdId].due || "") !== (due || "")) {
      await tt(`/task/${map[pdId].ttId}`, ttToken, "POST", {
        id: map[pdId].ttId, projectId, title,
        ...(due ? { dueDate: due, isAllDay: !a.due_time } : {})
      }).catch(() => {});
      map[pdId].subject = title;
      map[pdId].due = due || "";
      summary.updated++;
    }
  }

  // Activities done/deleted in Pipedrive → complete the TickTick task
  for (const [pdId, m] of Object.entries(map)) {
    if (openById[pdId]) continue;
    await tt(`/project/${projectId}/task/${m.ttId}/complete`, ttToken, "POST").catch(() => {});
    delete map[pdId];
    summary.closedInTt++;
  }

  await store.setJSON("map", map);
  return json({ ok: true, openActivities: open.length, ...summary });
};

export const config = { schedule: "*/15 * * * *" };

async function pd(path, token, method = "GET", body) {
  const res = await fetch(`${PD}${path}`, {
    method,
    headers: { "x-api-token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json().catch(() => ({}));
}

async function tt(path, token, method = "GET", body) {
  const res = await fetch(`${TT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return {}; }
}

function ttDue(dueDate, dueTime) {
  if (!dueDate) return null;
  if (dueTime) return `${dueDate}T${dueTime}:00+0000`;
  return `${dueDate}T00:00:00+0000`;
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}
