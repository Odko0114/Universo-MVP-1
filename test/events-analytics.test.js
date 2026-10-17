"use strict";

// What is left of lib/events.js after the marketing-analytics aggregators were
// removed: GDPR erasure (purgeAnon) and the partner dashboard time-series. The
// admin's weekly numbers are tested in test/usage.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const events = require("../lib/events");

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

test("computeUniTimeseries buckets one university's events by UTC day and ignores others", () => {
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  const day = (d) => new Date(NOW - d * 86400000).toISOString();
  const ev = [
    { ts: day(0), type: "profile_view", anon: "a", uni: "tum" },
    { ts: day(0), type: "save", anon: "a", uni: "tum" },
    { ts: day(1), type: "apply_click", anon: "b", uni: "tum" },
    { ts: day(1), type: "profile_view", anon: "b", uni: "other" }, // different university
    { ts: day(90), type: "profile_view", anon: "c", uni: "tum" }, // outside the window, still in totals
  ];
  const r = events.computeUniTimeseries(ev, "tum", { days: 7, now: NOW });
  assert.equal(r.series.length, 7);
  assert.deepEqual(r.series[6], {
    date: "2026-10-17",
    views: 1,
    saves: 1,
    applies: 0,
  });
  assert.deepEqual(r.series[5], {
    date: "2026-10-16",
    views: 0,
    saves: 0,
    applies: 1,
  });
  assert.deepEqual(r.totals, { views: 2, saves: 1, applies: 1 });
  assert.deepEqual(r.viewer_anons.sort(), ["a", "c"]);
});
