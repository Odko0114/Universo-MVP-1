"use strict";

/**
 * Data-quality layer — scoring, honest provenance metadata, and a dataset audit.
 *
 * Two hard rules, straight from the brief:
 *   1. Never fabricate. A field is scored present only if a real value exists.
 *   2. Never penalise records for data NO source provides. Per-university
 *      scholarships/deadlines/requirements/contacts don't exist at global scale
 *      (only the 40 curated records carry deadlines/requirements). Scoring those
 *      as "missing" on ~2,900 records would be dishonest noise, so they are NOT
 *      in the per-record score — the aggregate audit reports them as
 *      STRUCTURALLY UNAVAILABLE instead.
 *
 * Performance: everything here is computed ONCE at build/boot (wired into
 * lib/dataset.js + a cached audit in server.js), never per user request.
 */

// Weighted completeness over fields that genuinely vary per record and are
// obtainable from our sources. Weights sum to 100. Tuition is deliberately
// excluded: it's present on every record but as a country ESTIMATE for all but
// 40 (tuition_source), so scoring it would reward a flag, not real data — the
// audit reports researched-tuition coverage separately and honestly.
const DIMENSIONS = [
  { key: "city", label: "City", weight: 12, has: (u) => !!u.city },
  { key: "website", label: "Website", weight: 16, has: (u) => !!u.website },
  {
    key: "founded",
    label: "Founding year",
    weight: 8,
    has: (u) => u.founded != null,
  },
  {
    key: "student_count",
    label: "Enrolment",
    weight: 10,
    has: (u) => u.student_count != null,
  },
  {
    key: "institution_type",
    label: "Institution type",
    weight: 8,
    has: (u) => !!u.institution_type,
  },
  {
    key: "degree_levels",
    label: "Degree levels",
    weight: 12,
    has: (u) => Array.isArray(u.degree_levels) && u.degree_levels.length > 0,
  },
  {
    key: "fields_of_study",
    label: "Fields of study",
    weight: 12,
    has: (u) =>
      Array.isArray(u.fields_of_study) && u.fields_of_study.length > 0,
  },
  {
    key: "language",
    label: "Language of instruction",
    weight: 10,
    has: (u) =>
      Array.isArray(u.language_of_instruction) &&
      u.language_of_instruction.length > 0,
  },
  {
    key: "coords",
    label: "Coordinates",
    weight: 6,
    has: (u) => !!(u.coords && u.coords.lat != null && u.coords.lon != null),
  },
  {
    key: "description",
    label: "Description",
    weight: 6,
    has: (u) => !!u.short_description,
  },
];

// Fields the brief asks to "audit for missing" that NO data source provides per
// university. Reported at dataset level as structurally unavailable, never as a
// per-record deduction (see rule 2 above).
const STRUCTURALLY_UNAVAILABLE = [
  "per-university scholarships",
  "application deadlines",
  "admission requirements",
  "contact email/phone",
  "social links",
  "accommodation",
  "campus description",
  "programme catalogue",
];

const BANDS = [
  { min: 85, band: "Excellent" },
  { min: 65, band: "Good" },
  { min: 45, band: "Needs Improvement" },
  { min: 0, band: "Incomplete" },
];

// Newest reference year known to EXIST at each source. Probed 2026-07-30:
// ETER's 2024 is not yet published, 2023 is current. Bump this when a newer
// snapshot ships so the audit flags any dataset we're behind on. This is what
// makes "stale" actionable — a stale record can actually be refreshed to
// something newer, rather than being permanently old (ETER data is inherently
// a few years lagged; flagging all of it forever would be noise, not signal).
const SOURCE_LATEST_REFYEAR = { eter: 2023 };

function bandFor(score) {
  return (BANDS.find((b) => score >= b.min) || BANDS[BANDS.length - 1]).band;
}

/**
 * Per-record completeness score with explained deductions.
 * @returns {{ score:number, band:string, missing:{key:string,label:string,weight:number}[] }}
 */
function scoreRecord(u) {
  let score = 0;
  const missing = [];
  for (const d of DIMENSIONS) {
    if (d.has(u)) score += d.weight;
    else missing.push({ key: d.key, label: d.label, weight: d.weight });
  }
  return { score, band: bandFor(score), missing };
}

// Human-readable, honest source label.
function dataSourceLabel(source) {
  switch (source) {
    case "curated":
      return "Universo curated research";
    case "eter":
      return "ETER — official EU register";
    case "global":
      return "Hipolabs global university list";
    default:
      return source || "Unknown";
  }
}

/**
 * Honest verification status from PROVENANCE, never from guesswork.
 *  - curated: hand-researched by us → Verified
 *  - eter: official EU register → Verified (authoritative source)
 *  - global: community-maintained name+domain list → Unknown (not authoritative)
 */
function verificationStatus(u) {
  if (u.source === "curated") return "Verified";
  if (u.source === "eter") return "Verified";
  return "Unknown";
}

/**
 * When this record's facts were last verified at source. ETER carries a real
 * reference year; curated has a real review date; the global list has no
 * verification date, so it's null (marked Unknown above) — never invented.
 */
function lastVerifiedAt(u, curatedReviewedAt) {
  if (u.source === "curated") return curatedReviewedAt || null;
  if (u.source === "eter" && u.ref_year) return `${u.ref_year}-01-01`;
  return null;
}

/**
 * Stale = a NEWER snapshot exists at the source than the one this record
 * carries, i.e. it is refreshable. NOT mere absolute age: ETER publishes with
 * a multi-year lag, so its newest data is always a few years old — flagging
 * that forever would be noise. A record whose source has no versioned snapshot
 * (Hipolabs, undated) is left to verification_status = Unknown rather than
 * marked stale, since there is nothing newer to refresh it to.
 * @param {object} u  a university record (needs source + ref_year)
 */
function isStale(u) {
  if (u.source === "eter" && u.ref_year != null) {
    const latest = SOURCE_LATEST_REFYEAR.eter;
    return latest != null && u.ref_year < latest;
  }
  return false;
}

/**
 * One-pass aggregate audit over the whole dataset. Pure; run once at boot.
 * @param {object[]} list  university records (post-build, with metadata)
 */
function auditDataset(list) {
  const n = list.length;
  const distribution = {
    Excellent: 0,
    Good: 0,
    "Needs Improvement": 0,
    Incomplete: 0,
  };
  const byStatus = { Verified: 0, "Needs Review": 0, Unknown: 0 };
  const bySource = {};
  const missingCounts = {};
  for (const d of DIMENSIONS) missingCounts[d.key] = 0;
  let scoreSum = 0;
  let staleCount = 0;
  let researchedTuition = 0;
  let deeplyVerified = 0; // hand-curated profiles (u.verified), NOT the broader
  // verification_status field — the two are easy to confuse and mean different
  // things (300 hand-checked vs ~2,900 source-cross-checked).

  for (const u of list) {
    const { score, band, missing } = scoreRecord(u);
    scoreSum += score;
    distribution[band] += 1;
    byStatus[u.verification_status] =
      (byStatus[u.verification_status] || 0) + 1;
    bySource[u.source] = (bySource[u.source] || 0) + 1;
    for (const m of missing) missingCounts[m.key] += 1;
    if (u.stale) staleCount += 1;
    if (u.tuition_source === "curated_research") researchedTuition += 1;
    if (u.verified) deeplyVerified += 1;
  }

  const missingRanked = DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    missing: missingCounts[d.key],
    pct: n ? Math.round((100 * missingCounts[d.key]) / n) : 0,
  })).sort((a, b) => b.missing - a.missing);

  return {
    generated_at: new Date().toISOString(),
    count: n,
    average_score: n ? Math.round(scoreSum / n) : 0,
    deeply_verified: deeplyVerified,
    distribution,
    by_status: byStatus,
    by_source: bySource,
    stale_count: staleCount,
    researched_tuition: researchedTuition,
    missing_fields: missingRanked,
    structurally_unavailable: STRUCTURALLY_UNAVAILABLE,
  };
}

module.exports = {
  DIMENSIONS,
  STRUCTURALLY_UNAVAILABLE,
  SOURCE_LATEST_REFYEAR,
  scoreRecord,
  bandFor,
  dataSourceLabel,
  verificationStatus,
  lastVerifiedAt,
  isStale,
  auditDataset,
};
