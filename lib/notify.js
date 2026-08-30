"use strict";

/**
 * Retention delivery — the missing "trigger" half of the loop. Decides WHO is
 * due for a weekly digest or a deadline reminder, purely from the student's own
 * real state (deadlines, missing requirements, funding). No invented data, no
 * manufactured urgency. Sending, template building and persistence are injected
 * so this whole module is unit-testable with a fake `send` and a fixed `now`,
 * and works identically whether email is live or dormant.
 *
 * server.js wires `buildData` to the same journey assembly `/me/journey` uses,
 * `send` to lib/email.js, and runs it on an in-process daily timer.
 */

const NOTIFICATION_CATEGORIES = [
  "weekly_digest",
  "deadline_reminders",
  "application_updates",
  "scholarship_updates",
];
// Deadline-driven categories default ON (they're the student's own real
// deadlines, with one-click unsubscribe); flip here to go strictly opt-in.
const DEFAULT_NOTIFICATIONS = {
  weekly_digest: true,
  deadline_reminders: true,
  application_updates: true,
  scholarship_updates: true,
};

// Remind as each of these day-marks is crossed (once each, deduped). Reminders
// are only for applications the student is still preparing — never ones already
// submitted/decided.
const REMINDER_THRESHOLDS = [7, 3, 1];
const ACTIVE_STATUSES = new Set(["planning", "preparing", "ready"]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolve a student's notification prefs against the defaults. */
function notifPrefs(student) {
  const n =
    student && student.notifications && typeof student.notifications === "object"
      ? student.notifications
      : {};
  const out = {};
  for (const k of NOTIFICATION_CATEGORIES)
    out[k] = k in n ? n[k] === true : DEFAULT_NOTIFICATIONS[k];
  return out;
}

/** The reminder key (threshold or "overdue") an application is due for, or null. */
function dueReminderKey(a) {
  if (!a || a.days_left == null || !ACTIVE_STATUSES.has(a.status)) return null;
  if (a.days_left < 0) return "overdue";
  const crossed = REMINDER_THRESHOLDS.filter((t) => a.days_left <= t);
  return crossed.length ? String(Math.min(...crossed)) : null;
}

function digestDue(student, now) {
  const last = student && student.last_digest_sent;
  if (!last) return true;
  const t = new Date(last).getTime();
  if (isNaN(t)) return true;
  return now.getTime() - t >= WEEK_MS;
}

function hasDigestContent(data) {
  return !!(
    data &&
    ((data.action_plan && data.action_plan.length) ||
      (data.agenda && data.agenda.length) ||
      (data.applications && data.applications.length))
  );
}

/**
 * Run one delivery pass. Mutates dedup fields on the student objects and calls
 * `persist` once if anything was sent. Only marks a send as done when the
 * injected `send` reports sent:true, so a dormant/ failed send retries later.
 *
 * @param {object} o
 * @param {object[]} o.students
 * @param {Date} [o.now]
 * @param {(student:object)=>object} o.buildData   journey data for one student
 * @param {(kind:'digest'|'reminder', student:object, payload:object)=>Promise<{sent:boolean}>} o.send
 * @param {()=>void} [o.persist]
 * @returns {Promise<{digests:number, reminders:number}>}
 */
async function runDueEmails({ students, now = new Date(), buildData, send, persist }) {
  const nowIso = now.toISOString();
  let digests = 0;
  let reminders = 0;

  for (const s of students || []) {
    const prefs = notifPrefs(s);
    if (!prefs.weekly_digest && !prefs.deadline_reminders) continue;

    let data;
    try {
      data = buildData(s);
    } catch {
      continue; // one bad student never stops the batch
    }
    const apps = (data && data.applications) || [];

    if (prefs.deadline_reminders) {
      if (!s.reminders_sent || typeof s.reminders_sent !== "object")
        s.reminders_sent = {};
      for (const a of apps) {
        const key = dueReminderKey(a);
        if (!key) continue;
        const sent = s.reminders_sent[a.uni_id] || (s.reminders_sent[a.uni_id] = {});
        if (sent[key]) continue;
        const res = await send("reminder", s, { application: a });
        if (res && res.sent === true) {
          sent[key] = nowIso;
          reminders++;
        }
      }
    }

    if (prefs.weekly_digest && digestDue(s, now) && hasDigestContent(data)) {
      const res = await send("digest", s, {
        agenda: data.agenda,
        actionPlan: data.action_plan,
        funding: data.funding,
      });
      if (res && res.sent === true) {
        s.last_digest_sent = nowIso;
        digests++;
      }
    }
  }

  if (persist && (digests || reminders)) persist();
  return { digests, reminders };
}

module.exports = {
  NOTIFICATION_CATEGORIES,
  DEFAULT_NOTIFICATIONS,
  REMINDER_THRESHOLDS,
  notifPrefs,
  dueReminderKey,
  digestDue,
  hasDigestContent,
  runDueEmails,
};
