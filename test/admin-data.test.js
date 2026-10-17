"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  interestIndex,
  universityFlags,
  scholarshipFlags,
  listRecords,
  datasetOverview,
} = require("../lib/admin-data");

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();

const unis = [
  {
    id: "a",
    name: "Alpha Uni",
    country: "Finland",
    verified: true,
    tuition_source: "country_estimate",
    application_deadline: "",
    fields_of_study: ["Medicine"],
  },
  {
    id: "b",
    name: "Beta Uni",
    country: "Germany",
    verified: true,
    tuition_source: "curated_research",
    tuition_range: { min: 0, max: 100 },
    application_deadline: "May 31",
    fields_of_study: ["Engineering"],
  },
  {
    id: "c",
    name: "Gamma College",
    country: "Finland",
    verified: false,
    tuition_source: "country_estimate",
    application_deadline: "",
  },
];
const schs = [
  { key: "s1", name: "Old Grant", application: { deadline: "2025-01-01" } },
  { key: "s2", name: "Open Grant", application: { deadline_note: "Rolling" } },
];
const verifiedMap = {
  "university:b": "2026-09-01",
  "scholarship:s2": "2026-08-01",
};
const verifiedAt = (t, id) => verifiedMap[`${t}:${id}`] || "";

test("interestIndex: weights saves and apply clicks above views, ignores old events", () => {
  const m = interestIndex(
    [
      { ts: ago(1), type: "profile_view", uni: "a" },
      { ts: ago(1), type: "save", uni: "a" },
      { ts: ago(1), type: "apply_click", uni: "a" },
      { ts: ago(200), type: "save", uni: "a" }, // outside 90 days
      { ts: ago(1), type: "pageview" }, // no uni → ignored
    ],
    NOW,
  );
  assert.deepEqual(m.get("a"), { views: 1, saves: 1, clicks: 1, score: 6 });
});

test("universityFlags: a register record is incomplete; a fresh curated one is clean", () => {
  const a = universityFlags(unis[0], "", NOW);
  assert.equal(a.missingDeadline, true);
  assert.equal(a.estimatedTuition, true);
  assert.equal(a.neverVerified, true);
  const b = universityFlags(unis[1], "2026-09-01", NOW);
  assert.equal(b.missingDeadline, false);
  assert.equal(b.estimatedTuition, false);
  assert.equal(b.stale, false);
});

test("universityFlags: verified more than 6 months ago is stale", () => {
  assert.equal(universityFlags(unis[1], "2026-01-01", NOW).stale, true);
  assert.equal(universityFlags(unis[1], "2026-08-01", NOW).stale, false);
});

test("scholarshipFlags: passed deadline, rolling note and missing are told apart", () => {
  assert.equal(scholarshipFlags(schs[0], "", NOW).deadlinePassed, true);
  assert.equal(
    scholarshipFlags(schs[1], "2026-08-01", NOW).missingDeadline,
    false,
  );
  assert.equal(
    scholarshipFlags({ key: "x", application: {} }, "", NOW).missingDeadline,
    true,
  );
});

const run = (query) =>
  listRecords({
    universities: unis,
    scholarships: schs,
    verifiedAt,
    interest: new Map([
      ["a", { score: 9 }],
      ["b", { score: 2 }],
    ]),
    query,
    now: NOW,
  });

test("listRecords: default scope is the featured work queue, most-wanted first", () => {
  const r = run({});
  assert.deepEqual(
    r.items.map((i) => i.id),
    ["a", "b"],
  ); // c is not featured
  assert.equal(r.total, 2);
  assert.ok(r.items[0].pills.some((p) => p.t === "no deadline"));
  assert.ok(r.items[1].pills.some((p) => p.k === "ok"));
});

test("listRecords: 'all' includes non-featured universities and scholarships", () => {
  const ids = run({ scope: "all" }).items.map((i) => i.id);
  assert.ok(ids.includes("c") && ids.includes("s1"));
});

test("listRecords: filters, search and country narrow the list", () => {
  assert.deepEqual(
    run({ filter: "missing_deadline" }).items.map((i) => i.id),
    ["a"],
  );
  assert.deepEqual(
    run({ q: "beta" }).items.map((i) => i.id),
    ["b"],
  );
  assert.deepEqual(
    run({ scope: "all", country: "Finland" }).items.map((i) => i.id),
    ["a", "c"],
  );
  assert.deepEqual(
    run({ scope: "all", field: "Medicine" }).items.map((i) => i.id),
    ["a"],
  );
});

test("listRecords: scholarships scope lists only scholarships; pagination works", () => {
  const s = run({ scope: "scholarships" });
  assert.deepEqual(
    s.items.map((i) => i.type),
    ["scholarship", "scholarship"],
  );
  const p = run({ limit: 1, offset: 1 });
  assert.equal(p.items.length, 1);
  assert.equal(p.total, 2);
});

test("datasetOverview: counts the featured queue, not the whole register", () => {
  const o = datasetOverview({
    universities: unis,
    scholarships: schs,
    verifiedAt,
    audit: { average_score: 90, distribution: { Excellent: 1 } },
    now: NOW,
  });
  assert.equal(o.total, 3);
  assert.equal(o.featured, 2);
  assert.equal(o.featuredVerified, 1); // only b was confirmed by a person
  assert.equal(o.missingDeadline, 1);
  assert.equal(o.estimatedTuition, 1);
  assert.equal(o.researchedTuition, 1);
  assert.equal(o.scholarships.needCheck, 1); // s1: passed deadline + never verified
  assert.equal(o.completeness.avg, 90);
});
