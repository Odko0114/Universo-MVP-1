'use strict';

/**
 * The single fixed field-of-study taxonomy shared by BOTH sides of the match:
 * the student's `fields_of_interest` and the university's `fields_offered`.
 * Matching only works if both are drawn from the same closed list — free text
 * on either side is what made earlier "why this fits" reasons generic.
 *
 * The dataset's raw `fields_of_study` values (from ETER's ISCED groupings) use
 * a slightly different, broader vocabulary; MAP_FROM_RAW folds them into this
 * canonical list so an inferred university tag lines up with a student's pick.
 */

const FIELDS = [
  'Computer Science',
  'Engineering',
  'Business',
  'Law',
  'Medicine',
  'Natural Sciences',
  'Social Sciences',
  'Arts & Design',
  'Education',
  'Agriculture & Veterinary',
  'Hospitality & Services',
];

const FIELD_SET = new Set(FIELDS);

// Raw dataset taxonomy → canonical field(s). One raw group can map to several
// (e.g. "Business & Law" → Business + Law).
const MAP_FROM_RAW = {
  'Computer Science & IT': ['Computer Science'],
  'Engineering & Technology': ['Engineering'],
  'Business & Law': ['Business', 'Law'],
  'Business & Economics': ['Business'],
  'Law': ['Law'],
  'Medicine & Health': ['Medicine'],
  'Natural Sciences': ['Natural Sciences'],
  'Social Sciences': ['Social Sciences'],
  'Arts & Humanities': ['Arts & Design'],
  'Humanities & Arts': ['Arts & Design'],
  'Education': ['Education'],
  'Agriculture & Veterinary': ['Agriculture & Veterinary'],
  'Services & Hospitality': ['Hospitality & Services'],
};

/** Map a university's raw fields_of_study array to canonical fields_offered. */
function canonicalFields(rawList) {
  const out = new Set();
  for (const raw of rawList || []) {
    for (const f of MAP_FROM_RAW[raw] || []) out.add(f);
  }
  return [...out];
}

/**
 * Best-effort field inference from an institution's NAME, for records with no
 * fields_of_study at all (many ETER rows). Deliberately conservative — this is
 * `field_source: inferred` data and, per design, only ever feeds soft scoring,
 * never a hard filter.
 */
/** @type {Array<[RegExp, string[]]>} */
const NAME_HINTS = [
  [/\b(polytech|polit+ecnico|institute of technology|technical|technolog|technische|technique)\b/i, ['Engineering', 'Computer Science']],
  [/\b(medic|health|pharma|dental|nursing)\b/i, ['Medicine']],
  [/\b(business|management|economic|commerce|commercial)\b/i, ['Business']],
  [/\b(law|juridic|legal)\b/i, ['Law']],
  [/\b(art|music|design|conservatoire|conservatory|fine arts|academy of)\b/i, ['Arts & Design']],
  [/\b(agri|veterinary|forestry)\b/i, ['Agriculture & Veterinary']],
  [/\b(education|pedagog|teacher)\b/i, ['Education']],
  [/\b(social|political)\b/i, ['Social Sciences']],
];

function inferFieldsFromName(name) {
  const out = new Set();
  for (const [re, fields] of NAME_HINTS) {
    if (re.test(name || '')) fields.forEach((f) => out.add(f));
  }
  return [...out];
}

module.exports = { FIELDS, FIELD_SET, canonicalFields, inferFieldsFromName };
