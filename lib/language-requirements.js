"use strict";

/**
 * Curated, hand-verified language requirements (data/language-requirements.json).
 *
 * Answers one student question: "what language test and score do I need to
 * apply?" Every record is traceable to the university's OWN official admissions
 * page (`source_url`) — nothing inferred, nothing copied between universities.
 * Records are keyed by `university_id` (referencing data/universities.json) with
 * an optional `program`; the vast majority of universities have no record, and
 * that absence is shown honestly as "not yet verified" rather than guessed.
 *
 * Never launder the free-text `acceptance_requirements` on a university record
 * into a verified requirement — that field is explicitly a best-effort estimate
 * in the UI. Only records in this file are "verified".
 */

const fs = require("fs");
const path = require("path");

let RECORDS = [];
try {
  RECORDS = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "data", "language-requirements.json"),
      "utf8",
    ),
  );
  if (!Array.isArray(RECORDS)) RECORDS = [];
} catch {
  RECORDS = [];
}

const forUniversity = (uniId) =>
  RECORDS.filter((r) => r.university_id === uniId);

/**
 * Resolve a display view from a set of records (pure — exported for testing).
 * Priority: a university-wide record wins as the shown requirement (with a count
 * of any programme-specific overrides); if only programme-specific records
 * exist, one resolves to "verified" and several resolve to "varies"; none → "none".
 * @returns {{state:"verified"|"varies"|"none", ...}}
 */
function resolveView(recs) {
  if (!recs || !recs.length) return { state: "none" };

  const uniWide = recs.find((r) => !r.program);
  const programRecs = recs.filter((r) => r.program);

  if (uniWide)
    return { state: "verified", ...uniWide, other_programs: programRecs.length };
  if (programRecs.length === 1) return { state: "verified", ...programRecs[0] };
  return {
    state: "varies",
    programs: programRecs.map((r) => ({
      program: r.program,
      source_url: r.source_url,
    })),
  };
}

/** Resolve what to show for a university with no specific programme in context. */
const viewForUniversity = (uniId) => resolveView(forUniversity(uniId));

const hasRequirement = (uniId) => forUniversity(uniId).length > 0;

module.exports = {
  forUniversity,
  viewForUniversity,
  resolveView,
  hasRequirement,
  all: () => RECORDS,
};
