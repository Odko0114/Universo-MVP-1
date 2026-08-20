"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const search = require("../lib/search");

const sample = [
  {
    id: "a",
    name: "São Paulo State University",
    country: "Brazil",
    fields_of_study: [],
    degree_levels: [],
    language_of_instruction: [],
  },
  {
    id: "b",
    name: "University of Tokyo",
    country: "Japan",
    student_count: 28000,
    fields_of_study: [],
    degree_levels: [],
    language_of_instruction: [],
  },
  {
    id: "c",
    name: "Tokyo Institute of Technology",
    country: "Japan",
    student_count: 10000,
    fields_of_study: [],
    degree_levels: [],
    language_of_instruction: [],
  },
  {
    id: "d",
    name: "Curated Uni",
    country: "Germany",
    source: "curated",
    tuition_range: { min: 0, max: 0, period: "year" },
    fields_of_study: ["Engineering"],
    degree_levels: ["Master"],
    language_of_instruction: ["English"],
  },
];
const index = search.buildIndex(sample);

test("search is diacritic-insensitive", () => {
  const r = search.query(index, { q: "sao paulo" });
  assert.equal(r.count, 1);
  assert.equal(r.universities[0].id, "a");
});

test("search ranks name matches by relevance (prefix beats substring)", () => {
  const r = search.query(index, { q: "tokyo" });
  assert.equal(r.count, 2);
  // "Tokyo Institute…" starts with the term → ranks above "University of Tokyo"
  assert.equal(r.universities[0].id, "c");
});

test("country filter narrows results", () => {
  const r = search.query(index, { country: "Japan" });
  assert.equal(r.count, 2);
});

test("tuition budget filter excludes records without tuition data", () => {
  const r = search.query(index, { maxTuition: "1000" });
  assert.equal(r.count, 1);
  assert.equal(r.universities[0].id, "d"); // only the curated one has tuition
});

test("pagination reports total and has_more correctly", () => {
  const r = search.query(index, { limit: 2, offset: 0 });
  assert.equal(r.count, 4);
  assert.equal(r.universities.length, 2);
  assert.equal(r.has_more, true);
});

test("sort by size orders by student_count desc", () => {
  const r = search.query(index, { sort: "size" });
  assert.equal(r.universities[0].id, "b"); // 28000
});

test("popular sort uses the click lookup", () => {
  const clicks = { c: 99 };
  const r = search.query(index, { sort: "popular" }, (id) => clicks[id] || 0);
  assert.equal(r.universities[0].id, "c");
});

test("buildFilters derives distinct facets", () => {
  const f = search.buildFilters(sample);
  assert.ok(f.countries.includes("Japan"));
  assert.deepEqual(f.degree_levels, ["Master"]);
});

test("sort=match breaks score ties by strength (world rank), not alphabetically", () => {
  // Three universities that all match equally; only their strength differs.
  const uni = (id, name, world_rank, verified) => ({
    id,
    name,
    country: "Germany",
    verified,
    ranking: world_rank ? { world_rank, provider: "CWUR" } : undefined,
    fields_of_study: ["Computer Science"],
    degree_levels: [],
    language_of_instruction: [],
  });
  const tie = [
    uni("z-strong", "Zeta University", 90, true), // best rank, but last alphabetically
    uni("a-weak", "Alpha University", 800, true), // worst rank, first alphabetically
    uni("m-unranked", "Mu University", null, true), // no rank → after ranked ones
  ];
  const idx = search.buildIndex(tie);
  // Equal match score for all → the tie-break decides the order.
  const r = search.query(idx, { sort: "match" }, () => 0, { scoreFn: () => 5 });
  assert.deepEqual(
    r.universities.map((u) => u.id),
    ["z-strong", "a-weak", "m-unranked"],
    "stronger world rank first; unranked last — never alphabetical",
  );
});

test("sort=match tie-break prefers a verified profile when ranks are equal", () => {
  const base = (id, verified) => ({
    id,
    name: id,
    country: "Germany",
    verified,
    ranking: { world_rank: 200, provider: "CWUR" },
    fields_of_study: ["Computer Science"],
    degree_levels: [],
    language_of_instruction: [],
  });
  const idx = search.buildIndex([
    base("register", false),
    base("verified", true),
  ]);
  const r = search.query(idx, { sort: "match" }, () => 0, { scoreFn: () => 5 });
  assert.equal(
    r.universities[0].id,
    "verified",
    "verified profile wins an equal-rank tie",
  );
});
