"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeAudience } = require("../lib/audience");

const NOW = Date.parse("2026-10-19T10:00:00Z");
const ago = (d, h = 0) =>
  new Date(NOW - d * 86400000 - h * 3600000).toISOString();

const students = [
  {
    signup_date: ago(0, 1),
    last_active_date: ago(0),
    country_of_origin: "Mongolia",
    field_of_interest: "Computer Science",
  },
  {
    signup_date: ago(0, 2),
    last_active_date: ago(0),
    country_of_origin: "Mongolia",
    field_of_interest: "Medicine",
  },
  {
    signup_date: ago(10),
    last_active_date: ago(0),
    country_of_origin: "India",
    field_of_interest: "Computer Science",
  },
  {
    signup_date: ago(10),
    last_active_date: ago(5),
    country_of_origin: "India",
  },
  { signup_date: ago(3), last_active_date: ago(3), country_of_origin: "Nepal" },
];
const events = [
  { ts: ago(0, 1), anon: "a" }, // first seen today → new
  { ts: ago(0, 2), anon: "b" },
  { ts: ago(4), anon: "b" }, // b came before → returning today
  { ts: ago(0, 3), anon: "c" },
  { ts: ago(2), anon: "d" },
  { ts: ago(0), type: "pageview" }, // no anon → ignored
];

test("today: new vs returning accounts and visitors", () => {
  const a = computeAudience({ students, events, now: NOW, range: "today" });
  assert.deepEqual(a.accounts, { new: 2, returning: 1, total: 3 });
  assert.deepEqual(a.visitors, { new: 2, returning: 1, total: 3 });
  assert.equal(a.totalAccounts, 5);
});

test("7 days includes the account from 3 days ago; 30 days includes all", () => {
  assert.equal(
    computeAudience({ students, events, now: NOW, range: "7d" }).accounts.new,
    3,
  );
  const m = computeAudience({ students, events, now: NOW, range: "30d" });
  assert.equal(m.accounts.new, 5);
  assert.equal(m.accounts.returning, 0);
});

test("the filter narrows the breakdown to new or returning accounts", () => {
  const all = computeAudience({ students, events, now: NOW, range: "today" });
  assert.deepEqual(
    all.breakdown.countries.rows,
    [
      { label: "India", count: 1 },
      { label: "Mongolia", count: 2 },
    ].sort((a, b) => b.count - a.count),
  );
  const ret = computeAudience({
    students,
    events,
    now: NOW,
    range: "today",
    who: "returning",
  });
  assert.deepEqual(ret.breakdown.countries.rows, [
    { label: "India", count: 1 },
  ]);
  const nu = computeAudience({
    students,
    events,
    now: NOW,
    range: "today",
    who: "new",
  });
  assert.deepEqual(nu.breakdown.countries.rows, [
    { label: "Mongolia", count: 2 },
  ]);
  assert.deepEqual(nu.breakdown.fields.rows.map((f) => f.label).sort(), [
    "Computer Science",
    "Medicine",
  ]);
});

test("daily series covers 7 days ending today; bad input falls back safely", () => {
  const a = computeAudience({
    students,
    events,
    now: NOW,
    range: "nonsense",
    who: "x",
  });
  assert.equal(a.range, "today");
  assert.equal(a.who, "all");
  assert.equal(a.daily.length, 7);
  assert.equal(a.daily[6].newAccounts, 2);
  assert.equal(a.daily[6].visitors, 3);
});

test("no names or emails ever leave this function", () => {
  const out = JSON.stringify(
    computeAudience({
      students: [{ ...students[0], email: "x@y.z", full_name: "Secret Name" }],
      events,
      now: NOW,
    }),
  );
  assert.ok(!/x@y\.z|Secret Name/.test(out));
});

test("every number comes with the same-length window just before it", () => {
  const a = computeAudience({ students, events, now: NOW, range: "today" });
  // yesterday: nobody signed up; visitors seen = none
  assert.equal(a.previous.accounts.new, 0);
  assert.equal(a.previous.visitors.total, 0);
  // 7 days: the window before it holds the two signups from 10 days ago
  const w = computeAudience({ students, events, now: NOW, range: "7d" });
  assert.equal(w.previous.accounts.new, 2);
  assert.equal(w.previous.visitors.total, 0);
});

test("a person with two devices counts once; blank profile fields are counted, not hidden", () => {
  const two = [
    {
      student_id: "s1",
      signup_date: ago(0, 1),
      last_active_date: ago(0),
      anon_ids: ["x", "y"],
    },
  ];
  const ev = [
    { ts: ago(0, 1), anon: "x" },
    { ts: ago(0, 2), anon: "y" },
  ];
  const a = computeAudience({
    students: two,
    events: ev,
    now: NOW,
    range: "today",
  });
  assert.equal(a.visitors.total, 1);
  assert.equal(a.breakdown.countries.unknown, 1);
  assert.deepEqual(a.breakdown.countries.rows, []);
});

test("the people list exists only when asked for, and never carries an email", () => {
  const withEmail = [
    {
      ...students[0],
      full_name: "Bat",
      email: "bat@example.com",
      saved_universities: ["u1"],
    },
  ];
  assert.equal(
    computeAudience({ students: withEmail, events, now: NOW }).people,
    undefined,
  );
  const a = computeAudience({
    students: withEmail,
    events,
    now: NOW,
    withPeople: true,
  });
  assert.equal(a.people.length, 1);
  assert.equal(a.people[0].name, "Bat");
  assert.equal(a.people[0].status, "new");
  assert.equal(a.people[0].saved, 1);
  assert.ok(!JSON.stringify(a).includes("bat@example.com"));
});

test("a picked day shows exactly that day, compared with the day before; future days are ignored", () => {
  const a = computeAudience({
    students,
    events,
    now: NOW,
    day: "2026-10-16",
    withPeople: true,
  });
  assert.equal(a.day, "2026-10-16");
  assert.equal(a.accounts.new, 1); // the Nepal signup from 3 days ago
  assert.equal(a.people[0].country, "Nepal");
  const b = computeAudience({ students, events, now: NOW, day: "2026-10-19" });
  assert.deepEqual(b.accounts, { new: 2, returning: 1, total: 3 }); // same as "today"
  assert.equal(
    computeAudience({ students, events, now: NOW, day: "2099-01-01" }).day,
    "",
  );
  assert.equal(
    computeAudience({ students, events, now: NOW, day: "nonsense" }).day,
    "",
  );
  const old = computeAudience({
    students,
    events,
    now: NOW,
    day: "2026-10-09",
  });
  assert.equal(old.accounts.new, 2); // the two signups from 10 days ago
  assert.equal(old.previous.accounts.new, 0);
});

test("a student who came back on a past day is found from the daily log, even if they visited since", () => {
  const log = [
    {
      student_id: "z",
      signup_date: ago(20),
      last_active_date: ago(0), // visited again today
      active_days: ["2026-10-14", "2026-10-19"],
    },
  ];
  const sat = computeAudience({
    students: log,
    events: [],
    now: NOW,
    day: "2026-10-14",
  });
  assert.deepEqual(sat.accounts, { new: 0, returning: 1, total: 1 });
  const other = computeAudience({
    students: log,
    events: [],
    now: NOW,
    day: "2026-10-15",
  });
  assert.equal(other.accounts.returning, 0);
  assert.equal(sat.trackedSince, "2026-10-14");
});
