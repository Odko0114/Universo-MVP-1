"use strict";

/**
 * Deterministic two-stage matcher — plain code, NOT an AI call (the optional
 * one-sentence explanation is the only model-touching piece; see lib/explain.js).
 *
 * Stage 1 — HARD FILTERS eliminate genuine non-matches before scoring, but only
 *   for preferences the student actually stated, and never on unconfirmed data:
 *   a university with no known tuition / language / degree data is KEPT and
 *   flagged, not hidden on a guess. Inferred field tags never hard-filter.
 *
 * Stage 2 — SOFT SCORING (0–100) ranks whatever survived, and records exactly
 *   which components fired so the explanation layer can cite only real reasons.
 *
 * Every value that fires is traceable to a labelled component — there is no
 * opaque number.
 */

const { isEU } = require("./countries");

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .trim();

/** Does the student have enough set for matching to be meaningful? */
function hasProfile(student) {
  return (
    !!student &&
    ((student.fields_of_interest || []).length > 0 ||
      !!student.degree_level ||
      student.budget_max_eur_year != null)
  );
}

// ---- Stage 1: hard filters -------------------------------------------------
// Returns { passed, flags } — flags note data we COULDN'T confirm (shown to the
// student as honesty, e.g. "tuition not yet confirmed"), never a reason to hide.
function hardFilters(student, u) {
  const flags = [];

  // Budget — only eliminate on CONFIRMED (curated-research) tuition. Estimates
  // are not per-university facts, so they must not hide a school; flag instead.
  if (student.budget_max_eur_year != null) {
    if (u.tuition_source === "curated_research" && u.tuition_intl_min != null) {
      if (u.tuition_intl_min > student.budget_max_eur_year)
        return { passed: false, flags };
    } else {
      flags.push("tuition_unconfirmed");
    }
  }

  // Degree — eliminate only when the university's offered levels are known.
  if (student.degree_level) {
    const levels = u.degree_levels || [];
    if (levels.length) {
      if (!levels.includes(student.degree_level))
        return { passed: false, flags };
    } else flags.push("degree_unconfirmed");
  }

  // Language — eliminate only when the university's teaching languages are known.
  if ((student.preferred_languages || []).length) {
    const uni = (u.language_of_instruction || []).map(norm);
    if (uni.length) {
      const want = student.preferred_languages.map(norm);
      if (!want.some((l) => uni.includes(l))) return { passed: false, flags };
    } else {
      flags.push("language_unconfirmed");
    }
  }

  return { passed: true, flags };
}

// ---- Stage 2: soft scoring -------------------------------------------------
const WEIGHTS = { field: 40, city: 20, country: 20, verified: 10, budget: 10 };

function softScore(student, u) {
  const components = []; // { key, label, pts }
  let score = 0;
  const add = (key, label, pts) => {
    score += pts;
    components.push({ key, label, pts });
  };

  const want = student.fields_of_interest || [];
  const offered = u.fields_offered || [];
  const fieldHit = want.filter((f) => offered.includes(f));
  if (fieldHit.length)
    add("field", `Offers ${fieldHit.join(" & ")}`, WEIGHTS.field);

  if (
    student.city_preference &&
    u.city_size_category &&
    u.city_size_category === student.city_preference
  ) {
    const label = {
      large: "In a large city",
      mid: "In a mid-size city",
      small: "In a small town",
    }[u.city_size_category];
    add("city", label, WEIGHTS.city);
  }

  if (
    (student.country_preference || []).length &&
    student.country_preference.includes(u.country)
  ) {
    add("country", `In ${u.country} (a country you picked)`, WEIGHTS.country);
  }

  if (u.verified)
    add("verified", "Verified, university-confirmed profile", WEIGHTS.verified);

  // Comfortably-under-budget bonus — confirmed tuition only, well below ceiling.
  if (
    student.budget_max_eur_year != null &&
    u.tuition_source === "curated_research" &&
    u.tuition_intl_min != null
  ) {
    if (u.tuition_intl_min <= student.budget_max_eur_year * 0.8) {
      add(
        "budget",
        u.tuition_intl_min === 0
          ? "No tuition fee"
          : "Comfortably within your budget",
        WEIGHTS.budget,
      );
    }
  }

  return { score, components };
}

/**
 * Full match for one university. `passed` reflects the hard filters; `score`
 * and `components` the soft stage; `flags` the unconfirmed-data notes.
 */
function matchUniversity(student, u) {
  const hard = hardFilters(student, u);
  const soft = softScore(student, u);
  return {
    passed: hard.passed,
    score: soft.score,
    components: soft.components,
    flags: hard.flags,
  };
}

/**
 * The maximum score achievable for THIS profile. Only dimensions the student
 * actually stated can ever fire, so a field+budget search tops out at 60, not
 * 100. Normalising the displayed score against this ceiling makes "87" read as
 * "87% of the best possible fit for what you told us" — which spreads the bands
 * and stops a perfect match looking mediocre — rather than "87/100" in the
 * abstract. Verified is always in the ceiling: some university can earn it.
 */
function maxScore(student) {
  let max = WEIGHTS.verified;
  if ((student.fields_of_interest || []).length) max += WEIGHTS.field;
  if (student.city_preference) max += WEIGHTS.city;
  if ((student.country_preference || []).length) max += WEIGHTS.country;
  if (student.budget_max_eur_year != null) max += WEIGHTS.budget;
  return max;
}

/** Raw score as a 0–100 percentage of what this profile could achieve. */
function displayScore(student, u) {
  return Math.round((matchUniversity(student, u).score / maxScore(student)) * 100);
}

/**
 * Rank universities for a student: hard-filter, score, sort desc, top N.
 * @param {object} student
 * @param {object[]} universities
 * @param {{ limit?:number, excludeIds?:Set<string> }} [opts]
 */
function recommend(student, universities, opts = {}) {
  const { limit = 6, excludeIds } = opts;
  const mx = maxScore(student);
  const scored = [];
  for (const u of universities) {
    if (excludeIds && excludeIds.has(u.id)) continue;
    const m = matchUniversity(student, u);
    if (!m.passed) continue;
    scored.push({ u, ...m });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || (b.u.verified ? 1 : 0) - (a.u.verified ? 1 : 0),
  );
  return scored.slice(0, limit).map((r) => ({
    ...r.u,
    // Normalised for display; ordering above is by raw score (monotonic, so the
    // sort is unchanged) — the number just becomes % of achievable fit.
    match_score: Math.round((r.score / mx) * 100),
    match_components: r.components,
    match_flags: r.flags,
    match_reasons: r.components.map((c) => c.label),
  }));
}

/**
 * Compat shim for callers that only want the reason labels for one university
 * (e.g. the profile endpoint). Returns even when hard filters didn't pass — the
 * profile page still explains what does/doesn't line up.
 */
function scoreUniversity(student, u) {
  const m = matchUniversity(student, u);
  return {
    score: m.score,
    reasons: m.components.map((c) => c.label),
    components: m.components,
    flags: m.flags,
    passed: m.passed,
  };
}

module.exports = {
  matchUniversity,
  recommend,
  scoreUniversity,
  hasProfile,
  maxScore,
  displayScore,
  WEIGHTS,
};
