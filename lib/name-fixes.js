'use strict';

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
  'rwth-aachen.de': 'RWTH Aachen University',
  // "Frankfurt University" is Goethe. Renaming matters for safety as much as
  // accuracy: "Frankfurt University of Applied Sciences" is a DIFFERENT school
  // and owns the domain frankfurt-university.de, so the bare old name was
  // actively misleading.
  'goethe-university-frankfurt.de': 'Goethe University Frankfurt',
};

/**
 * Known-ambiguous or duplicate records that need a human decision. These are
 * deliberately NOT auto-fixed — surfaced so a founder can resolve them against
 * the real institutions.
 */
const AMBIGUOUS_REVIEW = [
  {
    issue: 'Probable duplicate of one institution under two domains',
    records: ['eter-de0048 (goethe-university-frankfurt.de)', 'g-uni-frankfurt-de (uni-frankfurt.de)'],
    note: 'Both appear to be Goethe University Frankfurt. Domain-based dedup cannot catch this because the institution publishes under two hostnames. Confirm and merge manually.',
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
  if (typeof url !== 'string' || !url) return url;
  return url.startsWith('http://') ? 'https://' + url.slice('http://'.length) : url;
}

module.exports = { NAME_BY_DOMAIN, AMBIGUOUS_REVIEW, applyNameFixes, httpsify };
