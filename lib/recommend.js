"use strict";

// Recommendation engine v2 — turns the manual performance feedback loop into
// plain-language guidance. It joins each rated result (which carries platform +
// rating) with its idea (formula, topic, goal) and aggregates by dimension and
// by cross-combination, then picks a "create next" suggestion and flags weak
// performers. Pure and deterministic; the caller maps keys -> labels for display.
//
// Honesty: everything is derived only from what the user actually rated. Claims
// are gated by support (a combo needs >=2 rated posts before it's asserted), and
// the sample size + confidence are returned so the UI never overstates a signal.

const SCORE = { Great: 3, Good: 2, Average: 1, Poor: 0 };
const MIN_COMBO = 2; // rated posts needed before a combination is claimed
const round2 = (n) => Math.round(n * 100) / 100;
const mean = (arr) => round2(arr.reduce((a, b) => a + b, 0) / arr.length);
const rank = (a, b) => b.avg - a.avg || b.n - a.n;

// Group points by the tuple of `fields`; key on the JSON of the values so no
// in-band delimiter can collide with a topic string.
function aggregate(points, fields) {
  const m = new Map();
  for (const p of points) {
    if (fields.some((f) => !p[f])) continue; // skip points missing any dimension
    const parts = fields.map((f) => p[f]);
    const key = JSON.stringify(parts);
    if (!m.has(key)) m.set(key, { parts, scores: [] });
    m.get(key).scores.push(p.score);
  }
  return [...m.values()].map(({ parts, scores }) => {
    const o = /** @type {any} */ ({ avg: mean(scores), n: scores.length });
    fields.forEach((f, i) => (o[f] = parts[i]));
    if (fields.length === 1) o.key = parts[0];
    return o;
  }).sort(rank);
}

function analyze(ideas) {
  ideas = Array.isArray(ideas) ? ideas : [];
  const points = [];
  for (const i of ideas) {
    for (const r of i.results || []) {
      if (!(r.rating in SCORE)) continue; // only rated posts inform anything
      points.push({ formula: i.formula || "", topic: i.topic || "", goal: i.goal || "", platform: r.platform || "", score: SCORE[r.rating] });
    }
  }
  const sampleSize = points.length;
  const dims = {
    formula: aggregate(points, ["formula"]),
    platform: aggregate(points, ["platform"]),
    topic: aggregate(points, ["topic"]),
    goal: aggregate(points, ["goal"]),
  };
  const combos = {
    formulaTopicPlatform: aggregate(points, ["formula", "topic", "platform"]),
    formulaPlatform: aggregate(points, ["formula", "platform"]),
    formulaTopic: aggregate(points, ["formula", "topic"]),
  };
  // "Create next": the best-supported combination, most specific first.
  const firstSupported = (arr) => arr.find((x) => x.n >= MIN_COMBO) || null;
  const nextBest = firstSupported(combos.formulaTopicPlatform)
    || firstSupported(combos.formulaPlatform)
    || firstSupported(combos.formulaTopic)
    || (dims.formula[0] && dims.formula[0].n >= MIN_COMBO ? { formula: dims.formula[0].key, avg: dims.formula[0].avg, n: dims.formula[0].n } : null);
  // "Avoid": the weakest supported single dimension (avg <= Average).
  const avoid = [];
  for (const [dim, arr] of [["formula", dims.formula], ["platform", dims.platform], ["topic", dims.topic], ["goal", dims.goal]]) {
    const w = arr[arr.length - 1];
    if (w && w.n >= MIN_COMBO && w.avg <= 1) avoid.push({ dim, key: w.key, avg: w.avg, n: w.n });
  }
  const confidence = sampleSize >= 10 ? "high" : sampleSize >= 4 ? "medium" : "low";
  return { sampleSize, confidence, dims, combos, nextBest, avoid };
}

module.exports = { analyze, SCORE };

// Self-check: node lib/recommend.js
if (require.main === module) {
  const assert = require("assert");
  const ideas = [
    { formula: "story", topic: "Scholarships", goal: "signups", results: [{ platform: "reel", rating: "Great" }, { platform: "reel", rating: "Great" }] },
    { formula: "story", topic: "Scholarships", goal: "signups", results: [{ platform: "linkedin", rating: "Average" }] },
    { formula: "list", topic: "Cost", goal: "awareness", results: [{ platform: "reel", rating: "Poor" }, { platform: "reel", rating: "Poor" }] },
    { formula: "list", topic: "Cost", results: [{ platform: "linkedin", rating: "" }] }, // unrated -> ignored
  ];
  const a = analyze(ideas);
  assert.equal(a.sampleSize, 5, "only rated results count");
  assert.equal(a.dims.formula[0].key, "story", "story ranks above list");
  // nextBest should be the best-supported combo: story + Scholarships + reel (two Greats)
  assert.equal(a.nextBest.formula, "story");
  assert.equal(a.nextBest.topic, "Scholarships");
  assert.equal(a.nextBest.platform, "reel");
  assert.equal(a.nextBest.n, 2);
  assert.equal(a.nextBest.avg, 3);
  // list is the weakest supported formula (two Poors) -> flagged to avoid
  assert.ok(a.avoid.some((x) => x.dim === "formula" && x.key === "list"), "weak list flagged");
  // empty / no data -> safe nulls
  const e = analyze([]);
  assert.equal(e.sampleSize, 0);
  assert.equal(e.nextBest, null);
  assert.equal(e.confidence, "low");
  console.log("recommend self-check passed");
}
