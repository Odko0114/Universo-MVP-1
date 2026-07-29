'use strict';

/**
 * "My Journey" — the pure, testable core of the personalized study-abroad
 * dashboard. Everything here is derived ENTIRELY from data the student and
 * platform already have: the matching profile (lib/validate.js#matchProfileFields)
 * and the saved list. No new university-side data, no fabricated milestones.
 *
 * server.js#/api/me/journey wires these functions to the matcher (lib/match.js),
 * the scholarship pointers (lib/scholarships.js) and the store — this module
 * itself does no I/O, so it's unit-testable without a running server.
 */

// Completeness is measured ONLY against the profile dimensions the matcher can
// actually score on (see lib/match.js). Deliberately NOT against preferences
// the universities have no data for — a bar you can never reach honestly is
// worse than no bar. Each dimension maps 1:1 to a real matcher input.
const PROFILE_DIMENSIONS = [
  { key: 'fields_of_interest', label: 'Fields of study', filled: (s) => (s.fields_of_interest || []).length > 0 },
  { key: 'degree_level', label: 'Degree level', filled: (s) => !!s.degree_level },
  { key: 'budget_max_eur_year', label: 'Budget', filled: (s) => s.budget_max_eur_year != null },
  { key: 'preferred_languages', label: 'Study language', filled: (s) => (s.preferred_languages || []).length > 0 },
  { key: 'country_preference', label: 'Preferred countries', filled: (s) => (s.country_preference || []).length > 0 },
  { key: 'city_preference', label: 'City size', filled: (s) => !!s.city_preference },
];

/**
 * @param {object} student
 * @returns {{ filled:number, total:number, percent:number, missing:string[], dimensions:{key:string,label:string,filled:boolean}[] }}
 */
function profileCompleteness(student) {
  const dimensions = PROFILE_DIMENSIONS.map((d) => ({
    key: d.key, label: d.label, filled: !!student && d.filled(student),
  }));
  const filled = dimensions.filter((d) => d.filled).length;
  const total = dimensions.length;
  return {
    filled,
    total,
    percent: Math.round((filled / total) * 100),
    missing: dimensions.filter((d) => !d.filled).map((d) => d.label),
    dimensions,
  };
}

/**
 * Concrete, ordered next steps — each one real and actionable from data we
 * have (nothing invented). Ordered by what moves the student forward most:
 * a complete profile powers every recommendation, so it leads until done;
 * then building and comparing a shortlist.
 * @param {number} savedCount
 * @param {ReturnType<typeof profileCompleteness>} completeness
 * @returns {{ key:string, title:string, body:string, href:string, cta:string }[]}
 */
function nextActions(savedCount, completeness) {
  const actions = [];

  if (completeness.percent < 100) {
    const first = completeness.filled === 0;
    actions.push({
      key: 'complete_profile',
      title: first ? 'Set up your matching profile' : 'Finish your matching profile',
      body: first
        ? 'Answer a few quick questions so every university is ranked for you, not just listed A–Z.'
        : `Add ${completeness.missing.slice(0, 2).join(' and ').toLowerCase()} to sharpen your matches.`,
      href: '/onboarding',
      cta: first ? 'Start — 30 sec' : 'Continue',
    });
  }

  if (savedCount === 0) {
    actions.push({
      key: 'save_first',
      title: 'Save your first university',
      body: 'Build a shortlist you can compare side by side as you decide.',
      href: '/discover',
      cta: 'Browse universities',
    });
  } else if (savedCount < 3) {
    actions.push({
      key: 'save_more',
      title: `You've saved ${savedCount} — add a couple more`,
      body: 'Comparing three to five options side by side makes the decision much clearer.',
      href: '/discover',
      cta: 'Find more',
    });
  } else {
    actions.push({
      key: 'compare',
      title: `Compare your ${savedCount} saved universities`,
      body: 'Review tuition, teaching language and fit across your shortlist.',
      href: '/saved',
      cta: 'Review shortlist',
    });
  }

  return actions;
}

module.exports = { PROFILE_DIMENSIONS, profileCompleteness, nextActions };
