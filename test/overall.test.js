"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeOverall } = require("../lib/overall");

const NOW = Date.parse("2026-11-25T10:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const students = [
  {
    student_id: "s1",
    signup_date: ago(40),
    last_active_date: ago(0),
    anon_ids: ["a", "a2"],
    email_verified: true,
    saved_universities: ["u1", "u2", "u3"],
    applications: { u1: { status: "submitted" } },
  },
  {
    student_id: "s2", // no events kept at all
    signup_date: ago(3),
    last_active_date: ago(3),
    saved_universities: [],
    applications: { u1: { status: "planning" } },
    email: "secret@x.y",
    full_name: "Secret",
  },
];
const events = [
  { ts: ago(41), type: "pageview", anon: "a" },
  { ts: ago(40), type: "save", anon: "a2" }, // same person, second device
  { ts: ago(5), type: "pageview", anon: "bot" }, // one page, nothing else
  { ts: ago(2), type: "pageview", anon: "v" },
  { ts: ago(2), type: "profile_view", anon: "v" },
  { ts: ago(45), type: "search", anon: "v2" },
];
const o = computeOverall({ events, students, now: NOW });

test("people: two devices are one person, single-page openers are not 'real'", () => {
  assert.equal(o.visitors, 4); // s1, bot, v, v2
  assert.equal(o.engaged, 4); // s1, v, v2 + s2 (an account without events)
});
test("students: totals, activity, came back, shortlist average", () => {
  assert.equal(o.students.total, 2);
  assert.equal(o.students.active1, 1);
  assert.equal(o.students.active7, 2);
  assert.equal(o.students.cameBack, 1);
  assert.equal(o.students.savedPerStudent, 3);
  assert.equal(o.students.started, 1, "planning is not started");
});
test("usage: all time, last 30 days and the 30 before", () => {
  assert.equal(o.usage.total.saves, 1);
  assert.equal(o.usage.last30.profileViews, 1);
  assert.equal(o.usage.prev30.searches, 1);
});
test("funnel never shows more accounts than people; growth adds up", () => {
  assert.ok(o.funnel[0].count >= o.funnel[1].count);
  assert.equal(o.growth.at(-1).totalStudents, 2);
  assert.equal(
    o.growth.reduce((n, g) => n + g.students, 0),
    2,
  );
});
test("empty data and privacy", () => {
  assert.equal(
    computeOverall({ events: [], students: [], now: NOW }).growth.length,
    0,
  );
  assert.ok(!/secret/i.test(JSON.stringify(o)));
});
