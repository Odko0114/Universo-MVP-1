"use strict";

/**
 * Curated, hand-verified scholarships (data/scholarships-curated.json). Unlike
 * the country-level pointers in lib/scholarships.js, these carry a full record
 * (funding breakdown, eligibility, application route, deadline, participating
 * universities) sourced from the scholarship's OWN official pages — every field
 * traceable to `verification.sources`, nothing fabricated. `university_ids`
 * reference existing records in data/universities.json (no duplication); the
 * reverse lookup powers the university→scholarship direction.
 */

const fs = require("fs");
const path = require("path");

let CURATED = [];
try {
  CURATED = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "data", "scholarships-curated.json"), "utf8"),
  );
  if (!Array.isArray(CURATED)) CURATED = [];
} catch {
  CURATED = [];
}

const allCurated = () => CURATED;
const curatedByKey = (key) => CURATED.find((s) => s.key === key) || null;
const curatedForUniversity = (uniId) =>
  CURATED.filter((s) => (s.university_ids || []).includes(uniId));
const isCuratedUniversity = (uniId) =>
  CURATED.some((s) => (s.university_ids || []).includes(uniId));

module.exports = {
  allCurated,
  curatedByKey,
  curatedForUniversity,
  isCuratedUniversity,
};
