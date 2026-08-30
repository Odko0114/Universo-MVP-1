"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const notify = require("../lib/notify");
const app = require("../server");
const store = require("../lib/store");
const email = require("../lib/email");

test("notifPrefs: empty → defaults; explicit false wins", () => {
  const def = notify.notifPrefs({ notifications: {} });
  assert.equal(def.weekly_digest, true);
  assert.equal(def.deadline_reminders, true);
  const off = notify.notifPrefs({ notifications: { weekly_digest: false } });
  assert.equal(off.weekly_digest, false);
  assert.equal(off.deadline_reminders, true, "other categories keep their default");
  // Missing object also resolves to defaults.
  assert.equal(notify.notifPrefs({}).deadline_reminders, true);
});

test("dueReminderKey: active app crossing a threshold; not for submitted/complete", () => {
  const mk = (over) => ({ status: "preparing", days_left: over, missing_required: ["x"] });
  assert.equal(notify.dueReminderKey(mk(10)), null, "10 days out → not yet");
  assert.equal(notify.dueReminderKey(mk(6)), "7", "6 days crosses only the 7-mark");
  assert.equal(notify.dueReminderKey(mk(2)), "3", "2 days crosses 7 and 3 → the 3-mark");
  assert.equal(notify.dueReminderKey(mk(1)), "1");
  assert.equal(notify.dueReminderKey({ ...mk(2), status: "submitted" }), null, "submitted apps aren't reminded");
  assert.equal(notify.dueReminderKey({ status: "preparing", days_left: -1 }), "overdue");
  assert.equal(notify.dueReminderKey({ status: "preparing", days_left: null }), null);
});

test("digestDue: never sent → due; <7 days → not; >=7 days → due", () => {
  const now = new Date("2026-02-08T00:00:00Z");
  assert.equal(notify.digestDue({}, now), true);
  assert.equal(notify.digestDue({ last_digest_sent: "2026-02-05T00:00:00Z" }, now), false);
  assert.equal(notify.digestDue({ last_digest_sent: "2026-02-01T00:00:00Z" }, now), true);
});

test("runDueEmails: sends a reminder + digest, dedups, respects opt-out, marks state", async () => {
  const now = new Date("2026-02-08T00:00:00Z");
  const sent = [];
  const send = async (kind, student, payload) => {
    sent.push({ kind, to: student.student_id, payload });
    return { sent: true };
  };
  const student = {
    student_id: "s1",
    notifications: {},
    saved_universities: ["u1"],
  };
  // buildData returns one near-deadline application + an agenda item.
  const buildData = () => ({
    applications: [
      {
        uni_id: "u1",
        name: "Helsinki",
        status: "preparing",
        days_left: 1,
        missing_required: ["Diploma"],
      },
    ],
    agenda: [{ label: "Helsinki — application deadline", days_left: 1 }],
    action_plan: [{ label: "Finish Helsinki", detail: "Missing: Diploma" }],
    funding: null,
  });

  const r1 = await notify.runDueEmails({ students: [student], now, buildData, send });
  assert.equal(r1.reminders, 1, "one deadline reminder");
  assert.equal(r1.digests, 1, "one weekly digest");
  assert.ok(student.reminders_sent.u1["1"], "reminder deduped at the 1-day mark");
  assert.equal(student.last_digest_sent, now.toISOString());

  // Second pass same day → nothing new (deduped).
  sent.length = 0;
  const r2 = await notify.runDueEmails({ students: [student], now, buildData, send });
  assert.equal(r2.reminders, 0);
  assert.equal(r2.digests, 0);
  assert.equal(sent.length, 0);

  // Opt-out → no sends even when due.
  const off = { student_id: "s2", notifications: { weekly_digest: false, deadline_reminders: false }, saved_universities: ["u1"] };
  const r3 = await notify.runDueEmails({ students: [off], now, buildData, send });
  assert.equal(r3.reminders + r3.digests, 0);
});

test("runDueEmails: no application data → no digest; failed send is not marked", async () => {
  const now = new Date("2026-02-08T00:00:00Z");
  // Empty applications → nothing to say.
  const empty = { student_id: "s3", notifications: {} };
  const r = await notify.runDueEmails({
    students: [empty],
    now,
    buildData: () => ({ applications: [], agenda: [], action_plan: [] }),
    send: async () => ({ sent: true }),
  });
  assert.equal(r.digests, 0);

  // A failed send must NOT stamp dedup state (so it retries next tick).
  const s = { student_id: "s4", notifications: {}, saved_universities: ["u1"] };
  await notify.runDueEmails({
    students: [s],
    now,
    buildData: () => ({
      applications: [{ uni_id: "u1", name: "X", status: "preparing", days_left: 1, missing_required: ["a"] }],
      agenda: [],
      action_plan: [],
    }),
    send: async () => ({ sent: false, dormant: true }),
  });
  assert.ok(!s.reminders_sent || !s.reminders_sent.u1 || !s.reminders_sent.u1["1"], "dormant send is not deduped");
  assert.ok(!s.last_digest_sent, "dormant digest is not stamped");
});

test("integration: real buildJourneyData → digest/reminder pipeline with a live send", async () => {
  // A real university id from the seeded dataset, with a near deadline entered.
  const soon = new Date();
  soon.setDate(soon.getDate() + 2);
  const student = {
    student_id: "int1",
    full_name: "Integration Student",
    email: "int@example.com",
    notifications: {},
    saved_universities: ["tum"],
    applications: { tum: { status: "preparing", deadline: soon.toISOString().slice(0, 10) } },
    documents: {},
  };
  // buildJourneyData resolves the real uni record + computes days_left/missing.
  const data = app.buildJourneyData(student);
  assert.ok(Array.isArray(data.applications) && data.applications.length === 1);
  assert.equal(data.applications[0].uni_id, "tum");
  assert.equal(typeof data.applications[0].days_left, "number");

  // Drive the notify pipeline with the real assembly + real email templates
  // (through a capturing send so no network is touched).
  const outbox = [];
  const send = async (kind, s, payload) => {
    const built =
      kind === "digest"
        ? email.weeklyDigestTemplate({ name: s.full_name, ...payload })
        : email.deadlineReminderTemplate({ name: s.full_name, ...payload });
    outbox.push({ kind, subject: built.subject, html: built.html });
    return { sent: true };
  };
  const r = await notify.runDueEmails({
    students: [student],
    now: new Date(),
    buildData: app.buildJourneyData,
    send: (kind, s, payload) =>
      send(kind, s, { origin: "https://x.test", unsubscribeUrl: "https://x.test/unsubscribe?token=int1.x", ...payload }),
  });
  assert.equal(r.reminders, 1, "a real near-deadline application triggers a reminder");
  assert.equal(r.digests, 1);
  const reminder = outbox.find((o) => o.kind === "reminder");
  assert.match(reminder.html, /journey#app-tum/, "reminder deep-links to the real application");
});
