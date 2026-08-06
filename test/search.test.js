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
