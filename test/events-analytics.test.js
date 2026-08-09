"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const events = require("../lib/events");
const {
  computeFunnel,
  computeRetention,
  computeTraffic,
  computeTopSearches,
  computeTopByUni,
} = events;

const now = () => new Date().toISOString();

test("computeFunnel counts distinct anon reach per stage with conversion %", () => {
  // Stages are Visitor -> Register -> Dream -> Save -> Compare -> Apply.
  const evs = [
    { type: "pageview", anon: "a", ts: now() },
    { type: "pageview", anon: "b", ts: now() },
    { type: "pageview", anon: "c", ts: now() },
    { type: "signup", anon: "a", ts: now() },
    { type: "signup", anon: "b", ts: now() },
    { type: "dream_update", anon: "a", ts: now() },
    { type: "save", anon: "a", ts: now() },
  ];
  const byKey = Object.fromEntries(
    computeFunnel(evs, {}).map((s) => [s.key, s]),
  );
  assert.equal(byKey.visit.count, 3);
  assert.equal(byKey.register.count, 2);
  assert.equal(byKey.dream.count, 1);
  assert.equal(byKey.save.count, 1);
  assert.equal(byKey.compare.count, 0);
  assert.equal(byKey.apply.count, 0);
  assert.equal(byKey.register.pct_of_first, Math.round((2 / 3) * 1000) / 10);
});

test("computeFunnel ignores events with no anon id", () => {
  const evs = [{ type: "pageview", ts: now() }]; // no anon
  const byKey = Object.fromEntries(
    computeFunnel(evs, {}).map((s) => [s.key, s]),
  );
  assert.equal(byKey.visit.count, 0);
});

test("computeRetention: a returning client shows up in the next week, a one-timer does not", () => {
  const base = Date.now() - 14 * 86_400_000; // 2 weeks ago, safely in the past
  const evs = [
    { ts: new Date(base).toISOString(), type: "pageview", anon: "a" },
    { ts: new Date(base).toISOString(), type: "pageview", anon: "b" },
    {
      ts: new Date(base + 7 * 86_400_000).toISOString(),
      type: "pageview",
      anon: "b",
    }, // b returns a week later
  ];
  const { cohorts, weeks } = computeRetention(evs, { weeks: 4 });
  assert.equal(weeks, 4);
  const cohort0 = cohorts.find((c) => c.size === 2);
  assert.ok(
    cohort0,
    "a and b are first seen together, forming one cohort of 2",
  );
  assert.equal(cohort0.retention[0], 100); // everyone counts in their own first week
  assert.equal(cohort0.retention[1], 50); // only b returned the following week
});

test("computeRetention returns an empty cohort list for no events", () => {
  assert.deepEqual(computeRetention([], {}).cohorts, []);
});

test("computeTraffic aggregates pageviews, unique visitors, top paths and device split", () => {
  const evs = [
    {
      ts: now(),
      type: "pageview",
      anon: "a",
      path: "/",
      ref: "google.com",
      device: "mobile",
    },
    {
      ts: now(),
      type: "pageview",
      anon: "b",
      path: "/",
      ref: "",
      device: "desktop",
    },
    {
      ts: now(),
      type: "profile_view",
      anon: "a",
      path: "/university/x",
      uni: "x",
      device: "mobile",
    },
    { ts: now(), type: "search", anon: "a", q: "mit" }, // not a "view" — excluded from pageviews/paths
  ];
  const t = computeTraffic(evs, {});
  assert.equal(t.pageviews, 3);
  assert.equal(t.unique_visitors, 2); // a, b — across all event types
  assert.equal(t.top_paths[0].key, "/");
  assert.equal(t.top_paths[0].count, 2);
  assert.equal(t.device_split.mobile, 2);
  assert.equal(t.device_split.desktop, 1);
  assert.ok(
    t.top_referrers.some((r) => r.key === "google.com" && r.count === 1),
  );
});

test("computeTopSearches ranks by frequency, case-insensitive", () => {
  const evs = [
    { type: "search", q: "MIT", ts: now() },
    { type: "search", q: "mit", ts: now() },
    { type: "search", q: "Oxford", ts: now() },
  ];
  const top = computeTopSearches(evs, {});
  assert.equal(top[0].q, "mit");
  assert.equal(top[0].count, 2);
});

test("computeTopByUni ranks universities by event count and reports unique clients", () => {
  const evs = [
    { type: "apply_click", uni: "x", anon: "a", ts: now() },
    { type: "apply_click", uni: "x", anon: "a", ts: now() }, // same client twice
    { type: "apply_click", uni: "x", anon: "b", ts: now() },
    { type: "apply_click", uni: "y", anon: "c", ts: now() },
  ];
  const top = computeTopByUni(evs, "apply_click", 5);
  assert.equal(top[0].id, "x");
  assert.equal(top[0].count, 3);
  assert.equal(top[0].unique, 2);
});

test("purgeAnon removes only events tied to the targeted anonymous ids", async () => {
  const marker = `test-anon-${Date.now()}`;
  const other = `test-anon-other-${Date.now()}`;
  events.record("pageview", { anon: marker, path: "/x" });
  events.record("pageview", { anon: other, path: "/y" });
  await events.flush();

  let all = events.readAll();
  assert.ok(all.some((e) => e.anon === marker));
  assert.ok(all.some((e) => e.anon === other));

  const removed = await events.purgeAnon([marker]);
  assert.ok(removed >= 1);

  all = events.readAll();
  assert.ok(!all.some((e) => e.anon === marker), "targeted events were purged");
  assert.ok(
    all.some((e) => e.anon === other),
    "untargeted events were left alone",
  );

  await events.purgeAnon([other]); // self-clean so this test leaves no residue
});

// --- Overview: DAU/WAU/MAU + new vs returning (Task 6) -----------------------

const H = 3600_000;
const D = 86_400_000;
const at = (now, agoMs) => new Date(now - agoMs).toISOString();

test("computeOverview counts distinct visitors, not events", () => {
  const now = Date.now();
  const ev = [
    { ts: at(now, H), type: "pageview", anon: "a" },
    { ts: at(now, H), type: "pageview", anon: "a" },
    { ts: at(now, H), type: "pageview", anon: "a" },
    { ts: at(now, H), type: "pageview", anon: "b" },
  ];
  const o = events.computeOverview(ev, now);
  assert.equal(
    o.dau.active,
    2,
    "one browser refreshing three times is one visitor",
  );
});

test("computeOverview splits new from returning by first-ever activity", () => {
  const now = Date.now();
  const ev = [
    // Seen for the first time two months ago, active again today → returning.
    { ts: at(now, 60 * D), type: "pageview", anon: "old" },
    { ts: at(now, 2 * H), type: "pageview", anon: "old" },
    // First appearance is today → new.
    { ts: at(now, 3 * H), type: "pageview", anon: "fresh" },
  ];
  const o = events.computeOverview(ev, now);
  assert.equal(o.dau.active, 2);
  assert.equal(
    o.dau.new,
    1,
    "only the visitor whose first event is today is new",
  );
  assert.equal(o.dau.returning, 1);
});

test("computeOverview windows nest correctly", () => {
  const now = Date.now();
  const ev = [
    { ts: at(now, 2 * H), type: "pageview", anon: "today" },
    { ts: at(now, 3 * D), type: "pageview", anon: "thisweek" },
    { ts: at(now, 20 * D), type: "pageview", anon: "thismonth" },
    { ts: at(now, 90 * D), type: "pageview", anon: "ancient" },
  ];
  const o = events.computeOverview(ev, now);
  assert.equal(o.dau.active, 1);
  assert.equal(o.wau.active, 2);
  assert.equal(
    o.mau.active,
    3,
    "the 90-day-old visitor falls outside every window",
  );
});

test("computeOverview ignores events with no anonymous id", () => {
  const now = Date.now();
  const o = events.computeOverview(
    [
      { ts: at(now, H), type: "pageview" },
      { ts: at(now, H), type: "pageview", anon: "a" },
    ],
    now,
  );
  assert.equal(
    o.dau.active,
    1,
    "an id-less event must not become a phantom visitor",
  );
});

test("funnel measures the six roadmap stages, in order", () => {
  const now = Date.now();
  const ev = [
    { ts: at(now, H), type: "pageview", anon: "a" },
    { ts: at(now, H), type: "signup", anon: "a" },
    { ts: at(now, H), type: "dream_update", anon: "a" },
    { ts: at(now, H), type: "save", anon: "a" },
    { ts: at(now, H), type: "compare", anon: "a" },
    { ts: at(now, H), type: "apply_click", anon: "a" },
    // A visitor who only browsed drops out after the first stage.
    { ts: at(now, H), type: "pageview", anon: "b" },
  ];
  const stages = events.computeFunnel(ev, { sinceMs: D });
  assert.deepEqual(
    stages.map((s) => s.key),
    ["visit", "register", "dream", "save", "compare", "apply"],
  );
  assert.equal(stages[0].count, 2);
  assert.equal(stages[1].count, 1, "only one of the two registered");
  assert.equal(stages[5].count, 1);
});
