"use strict";

/**
 * Corrections for truncated or ambiguous institution names in the ETER import.
 *
 * Keyed by DOMAIN, never by name. A name key would be dangerous here: the
 * register contains several genuinely different institutions in the same city
 * with confusingly similar names (Frankfurt's Goethe University vs. Frankfurt
 * University of Applied Sciences — whose domain is literally
 * "frankfurt-university.de"). The domain identifies the institution
 * unambiguously, so a fix can't silently rewrite the wrong school.
 *
 * ONLY add an entry when the domain makes the correct name unambiguous. If a
 * register name is genuinely ambiguous between two real institutions, leave it
 * and report it instead of guessing — see AMBIGUOUS_REVIEW below.
 */

// domain -> corrected official English name
const NAME_BY_DOMAIN = {
  // "Aachen University" is RWTH; FH Aachen is a separate record (fh-aachen.de)
  // and is already named correctly, so this rename also disambiguates the two.
  "rwth-aachen.de": "RWTH Aachen University",
  // "Frankfurt University" is Goethe. Renaming matters for safety as much as
  // accuracy: "Frankfurt University of Applied Sciences" is a DIFFERENT school
  // and owns the domain frankfurt-university.de, so the bare old name was
  // actively misleading.
  "goethe-university-frankfurt.de": "Goethe University Frankfurt",
  // Goethe University's other official domain (uni-frankfurt.de, its primary
  // German site) — the global-source record under this host had the same
  // institution under a very different string ("Johann Wolfgang Goethe
  // Universität Frankfurt am Main"), so name-based dedup missed it. Mapping
  // both domains to the identical corrected name lets the existing
  // dedupeByNameCountry pass collapse them automatically (ETER's richer
  // record wins; see AMBIGUOUS_REVIEW below, now resolved this way).
  "uni-frankfurt.de": "Goethe University Frankfurt",
};

/**
 * Ambiguous/duplicate cases investigated so far, kept as a record of the
 * decision rather than a pending TODO. Each entry's resolution is a comment
 * above the NAME_BY_DOMAIN key(s) that fixed it — this array is for
 * traceability, not for driving any code path.
 */
const AMBIGUOUS_REVIEW = [
  {
    issue: "Probable duplicate of one institution under two domains",
    records: [
      "eter-de0048 (goethe-university-frankfurt.de)",
      "g-uni-frankfurt-de (uni-frankfurt.de)",
    ],
    note: "Both are Goethe University Frankfurt (eter-de0048 has founding year, enrollment, coordinates, fields of study; g-uni-frankfurt-de has almost none). Resolved: uni-frankfurt.de added to NAME_BY_DOMAIN above so both records collapse to the identical corrected name and the existing name+country dedup pass merges them automatically, keeping the richer ETER record and redirecting the dropped global one.",
    resolved: true,
  },
];

/** Apply the domain-keyed corrections in place. Returns the number changed. */
function applyNameFixes(universities, hostKey) {
  let changed = 0;
  for (const u of universities) {
    const corrected = NAME_BY_DOMAIN[hostKey(u)];
    if (corrected && u.name !== corrected) {
      u.name_register = u.name; // keep the register's original for provenance
      u.name = corrected;
      changed++;
    }
  }
  return changed;
}

/**
 * Force outbound institution links to https. The register stores many links as
 * http:// (2,700+ records); sending students to a plain-http page from an https
 * site is both a trust and a mixed-content problem. Applied at build time so
 * every consumer (cards, profile, SSR, apply-click redirect) is consistent.
 */
function httpsify(url) {
  if (typeof url !== "string" || !url) return url;
  return url.startsWith("http://")
    ? "https://" + url.slice("http://".length)
    : url;
}

module.exports = { NAME_BY_DOMAIN, AMBIGUOUS_REVIEW, applyNameFixes, httpsify };
