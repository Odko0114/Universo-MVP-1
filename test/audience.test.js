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
    all.breakdown.countries,
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
  assert.deepEqual(ret.breakdown.countries, [{ label: "India", count: 1 }]);
  const nu = computeAudience({
    students,
    events,
    now: NOW,
    range: "today",
    who: "new",
  });
  assert.deepEqual(nu.breakdown.countries, [{ label: "Mongolia", count: 2 }]);
  assert.deepEqual(nu.breakdown.fields.map((f) => f.label).sort(), [
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
