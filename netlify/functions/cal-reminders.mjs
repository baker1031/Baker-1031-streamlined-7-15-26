/* Scheduled Loops reminders for Cal.com phone appointments. */

import { getStore } from "@netlify/blobs";
import { sendLoopsEvent } from "./lib/loops.mjs";

const STORE = "cal-appointments";

export default async () => {
  const store = getStore(STORE);
  const listed = await store.list({ prefix: "booking/" });
  const now = Date.now();
  let scanned = 0;
  let sent = 0;
  const errors = [];

  for (const blob of listed.blobs || []) {
    const appointment = await store.get(blob.key, { type: "json" });
    if (!appointment || appointment.cancelled || !appointment.email || !appointment.startTime) continue;
    const start = Date.parse(appointment.startTime);
    if (!Number.isFinite(start) || start <= now) continue;
    scanned++;

    const reminder = now >= start - 24 * 60 * 60 * 1000 && now < start - 30 * 60 * 1000 && !appointment.sent24h
      ? { key: "sent24h", event: "appointment_reminder_24h", label: "24-hour" }
      : now >= start - 60 * 60 * 1000 && now < start - 5 * 60 * 1000 && !appointment.sent1h
        ? { key: "sent1h", event: "appointment_reminder_1h", label: "1-hour" }
        : null;
    if (!reminder) continue;

    try {
      const result = await sendLoopsEvent(appointment.email, reminder.event, {
        appointmentId: appointment.bookingId,
        title: appointment.title || "Introductory Phone Call",
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        phone: appointment.phone,
        bookingUrl: appointment.bookingUrl
      });
      if (result.sent) {
        await store.setJSON(blob.key, { ...appointment, [reminder.key]: true, updatedAt: new Date().toISOString() });
        sent++;
      }
    } catch (error) {
      errors.push({ bookingId: appointment.bookingId, reminder: reminder.label, message: String(error?.message || error).slice(0, 500) });
    }
  }

  console.log(JSON.stringify({ scanned, sent, errors }));
};

export const config = { schedule: "*/5 * * * *" };
