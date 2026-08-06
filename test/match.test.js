"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  matchUniversity,
  scoreUniversity,
  recommend,
  hasProfile,
} = require("../lib/match");

const student = {
  fields_of_interest: ["Computer Science"],
  degree_level: "Master",
  budget_max_eur_year: 5000,
  preferred_languages: ["English"],
  city_preference: "large",
  country_preference: ["Germany"],
};

const strongFit = {
  id: "a",
  name: "Strong Fit University",
  country: "Germany",
  source: "curated",
  verified: true,
  degree_levels: ["Bachelor", "Master", "PhD"],
  fields_offered: ["Computer Science", "Engineering"],
  language_of_instruction: ["English", "German"],
  tuition_intl_min: 0,
  tuition_source: "curated_research",
  city_size_category: "large",
};
const wrongDegree = { ...strongFit, id: "b", degree_levels: ["Bachelor"] };
const overBudget = {
  id: "c",
  name: "Pricey University",
  country: "Germany",
  source: "curated",
  verified: true,
  degree_levels: ["Master"],
  fields_offered: ["Computer Science"],
  language_of_instruction: ["English"],
  tuition_intl_min: 30000,
  tuition_source: "curated_research",
  city_size_category: "large",
};
const sparse = {
  id: "d",
  name: "Sparse University",
  country: "Poland",
  source: "eter",
  verified: false,
  degree_levels: [],
  fields_offered: [],
  language_of_instruction: [],
  tuition_source: "country_estimate",
  tuition_intl_min: 2000,
  city_size_category: null,
};

test("hasProfile is false for empty, true once a field/degree/budget is set", () => {
  assert.equal(hasProfile({}), false);
  assert.equal(hasProfile({ fields_of_interest: ["Business"] }), true);
  assert.equal(hasProfile({ degree_level: "PhD" }), true);
});

test("a strong fit passes hard filters and scores high with cited components", () => {
  const m = matchUniversity(student, strongFit);
  assert.equal(m.passed, true);
  assert.ok(m.score >= 90, `expected a high score, got ${m.score}`);
  const keys = m.components.map((c) => c.key);
  assert.deepEqual(
    new Set(keys),
    new Set(["field", "city", "country", "verified", "budget"]),
  );
});

test("HARD FILTER: wrong degree is eliminated entirely", () => {
  assert.equal(matchUniversity(student, wrongDegree).passed, false);
});

test("HARD FILTER: over-budget (confirmed tuition) is eliminated", () => {
  assert.equal(matchUniversity(student, overBudget).passed, false);
});

test("unconfirmed data is KEPT and flagged, never hidden", () => {
  const m = matchUniversity(student, sparse);
  assert.equal(
    m.passed,
    true,
    "sparse record with unknown degree/language survives",
  );
  assert.ok(m.flags.includes("degree_unconfirmed"));
  assert.ok(m.flags.includes("language_unconfirmed"));
  assert.ok(
    m.flags.includes("tuition_unconfirmed"),
    "estimate tuition is not treated as confirmed",
  );
});

test("inferred fields never hard-filter (field is soft-only)", () => {
  // A student who only stated a field still matches a school whose fields don't
  // overlap — they just score 0 on the field component, not eliminated.
  const fieldOnly = { fields_of_interest: ["Law"] };
  const m = matchUniversity(fieldOnly, strongFit); // strongFit offers CS/Eng, not Law
  assert.equal(m.passed, true);
  assert.ok(!m.components.some((c) => c.key === "field"));
});

test("scoreUniversity returns reason labels for the profile page", () => {
  const { reasons } = scoreUniversity(student, strongFit);
  assert.ok(reasons.some((r) => /Computer Science/.test(r)));
});

test("recommend() hard-filters, sorts by score desc, respects limit and exclusions", () => {
  const results = recommend(student, [wrongDegree, sparse, strongFit], {
    limit: 5,
  });
  assert.equal(results[0].id, "a"); // strong fit ranks first
  assert.ok(!results.some((r) => r.id === "b"), "wrong-degree filtered out");
  assert.ok(
    results.every(
      (r, i, arr) => i === 0 || arr[i - 1].match_score >= r.match_score,
    ),
  );

  const excluded = recommend(student, [strongFit, sparse], {
    excludeIds: new Set(["a"]),
  });
  assert.ok(!excluded.some((r) => r.id === "a"));
});
