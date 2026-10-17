"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { searchMeta, computeUsage, summarizeAccounts } = require("../lib/usage");

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ago = (days) => new Date(NOW - days * 86400000).toISOString();
const vocab = {
  countries: new Set(["Germany", "Finland"]),
  fields: new Set(["Medicine", "Computer Science & IT"]),
  degrees: new Set(["Bachelor", "Master"]),
  languages: new Set(["English"]),
};

test("searchMeta: a bare page load is not a search", () => {
  assert.equal(searchMeta({}, vocab), null);
  assert.equal(
    searchMeta({ offset: "0", sort: "name", region: "EU" }, vocab),
    null,
  );
  assert.equal(searchMeta({ q: "ab" }, vocab), null); // half-typed word
});

test("searchMeta: records the filters used and drops values outside the vocabulary", () => {
  const m = searchMeta(
    {
      country: "Germany",
      field: "Medicine",
      degree: "Master",
      maxTuition: "6000",
      bogus: "x",
    },
    vocab,
  );
  assert.deepEqual(m, {
    country: "Germany",
    field: "Medicine",
    degree: "Master",
    budget: 6000,
  });
  assert.equal(searchMeta({ country: "Atlantis" }, vocab), null); // junk can't pollute the log
});

test("searchMeta: quick-match (fit*) params count, with up to 3 fields", () => {
  const m = searchMeta(
    {
      fitFields: "Medicine,Computer Science & IT",
      fitCountry: "Finland",
      fitBudget: "5000",
    },
    vocab,
  );
  assert.deepEqual(m, {
    country: "Finland",
    field: "Medicine|Computer Science & IT",
    budget: 5000,
  });
});

test("computeUsage: counts per rolling 7-day window, newest last", () => {
  const ev = [
    { ts: ago(1), type: "signup", anon: "a" },
    { ts: ago(2), type: "signup", anon: "b" },
    { ts: ago(9), type: "signup", anon: "c" },
    { ts: ago(1), type: "pageview", anon: "a" },
    { ts: ago(1), type: "pageview", anon: "a" }, // same visitor twice = one
    { ts: ago(3), type: "profile_view", anon: "b", uni: "tum" },
    { ts: ago(1), type: "save", anon: "a", uni: "tum" },
    { ts: ago(1), type: "email_verified", anon: "a" },
  ];
  const u = computeUsage(ev, { now: NOW, weeks: 4 });
  assert.equal(u.current.accounts, 2);
  assert.equal(u.previous.accounts, 1);
  assert.equal(u.current.visitors, 2);
  assert.equal(u.current.saves, 1);
  assert.equal(u.current.verified, 1);
  assert.deepEqual(u.series.accounts, [0, 0, 1, 2]);
});

test("computeUsage: ranks demand and flags unmet demand (few/no results)", () => {
  const s = (extra) => ({ ts: ago(2), type: "search", anon: "a", ...extra });
  const ev = [
    s({ field: "Computer Science & IT", country: "Germany", results: 40 }),
    s({ field: "Computer Science & IT", country: "Finland", results: 12 }),
    s({ field: "Medicine", country: "Finland", budget: 4000, results: 0 }),
    s({ field: "Medicine", country: "Finland", budget: 4000, results: 0 }),
    s({ q: "veterinary denmark", results: 1 }),
    { ts: ago(2), type: "filter_used", filter: "country", value: "Germany" }, // legacy event still counted
  ];
  const u = computeUsage(ev, { now: NOW });
  assert.equal(u.lists.fields[0].name, "Computer Science & IT");
  assert.equal(u.lists.fields[0].count, 2);
  assert.equal(u.lists.countries.find((c) => c.name === "Germany").count, 2); // 1 search + 1 legacy
  assert.equal(u.lists.budgets.find((b) => b.name === "€3k – €6k").count, 2);
  assert.equal(u.searchQuality.total, 5);
  assert.equal(u.searchQuality.zero, 2);
  assert.equal(u.gaps[0].field, "Medicine"); // seen twice → first
  assert.equal(u.gaps[0].budget, 4000); // "Finland under €4,000" is its own gap
  assert.equal(u.gaps[0].count, 2);
  assert.equal(u.gaps[0].results, 0);
  assert.ok(u.gaps.some((g) => g.q === "veterinary denmark"));
});

test("computeUsage: top universities and old events outside the list window are handled", () => {
  const ev = [
    { ts: ago(3), type: "save", anon: "a", uni: "tum" },
    { ts: ago(4), type: "save", anon: "b", uni: "tum" },
    { ts: ago(4), type: "save", anon: "c", uni: "helsinki" },
    { ts: ago(60), type: "save", anon: "d", uni: "old" }, // beyond 30 days
    { ts: "not-a-date", type: "save", anon: "e", uni: "bad" }, // ignored, never throws
  ];
  const u = computeUsage(ev, { now: NOW });
  assert.deepEqual(u.lists.savedUnis, [
    { id: "tum", count: 2 },
    { id: "helsinki", count: 1 },
  ]);
});

test("summarizeAccounts: counts only, groups home countries case-insensitively", () => {
  const students = [
    {
      email_verified: true,
      home_country: "Mongolia",
      signup_date: ago(1),
      saved_universities: ["a"],
      fields_of_interest: ["x"],
    },
    {
      email_verified: false,
      country_of_origin: "mongolia",
      signup_date: ago(20),
      applications: { a: "applied" },
    },
    { email_verified: false, signup_date: ago(2) },
  ];
  const a = summarizeAccounts(students, NOW);
  assert.equal(a.total, 3);
  assert.equal(a.verified, 1);
  assert.equal(a.profiled, 1);
  assert.equal(a.saved, 1);
  assert.equal(a.planning, 1);
  assert.equal(a.last7, 2);
  assert.equal(a.last7Unverified, 1); // the 20-day-old account doesn't count; the verified one doesn't either
  assert.deepEqual(a.homeCountries, [{ name: "Mongolia", count: 2 }]);
  assert.equal(a.homeNotGiven, 1);
});
