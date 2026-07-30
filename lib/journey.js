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

// ---- Timeline (study-abroad roadmap) --------------------------------------
// A single ordered arc from account → arrival. The first three stages are
// DERIVED from real state (recomputed every request, so they can never go
// stale or be faked); the rest are SELF-reported — the student marks them, and
// only these are stored (student.milestones). Nothing is invented: an "auto"
// stage is done iff the underlying fact is true; a "self" stage is done iff the
// student said so.
const TIMELINE = [
  { key: 'account_created', label: 'Created your account', kind: 'auto', hint: '' },
  { key: 'profile_set', label: 'Set up your matching profile', kind: 'auto', hint: 'Answer a few quick questions so universities are ranked for you.' },
  { key: 'shortlist_started', label: 'Built a shortlist', kind: 'auto', hint: 'Save the universities you want to compare.' },
  { key: 'scholarships_researched', label: 'Researched scholarships', kind: 'self', hint: 'Check the scholarship pointers for your country and the universities’ own aid pages.' },
  { key: 'application_started', label: 'Started an application', kind: 'self', hint: 'Begin an application on a university’s official page.' },
  { key: 'application_submitted', label: 'Submitted an application', kind: 'self', hint: 'Submit at least one application.' },
  { key: 'offer_received', label: 'Received an offer', kind: 'self', hint: 'Mark this when an offer arrives — a real milestone.' },
  { key: 'visa_started', label: 'Started visa & travel', kind: 'self', hint: 'Begin your visa application and travel planning.' },
  { key: 'arrived', label: 'Arrived', kind: 'self', hint: 'You made it. Same start, equal chance.' },
];

// The only milestone keys a client may toggle (the auto ones are never
// client-settable — they reflect real state).
const SELF_MILESTONE_KEYS = new Set(TIMELINE.filter((s) => s.kind === 'self').map((s) => s.key));

/**
 * @param {boolean} profiled   result of match.hasProfile(student)
 * @param {number} savedCount
 * @param {string[]} [milestones]  the student's self-reported milestone keys
 * @returns {{ stages:{key:string,label:string,kind:string,hint:string,done:boolean,next:boolean}[], next_key:string|null }}
 */
function buildTimeline(profiled, savedCount, milestones) {
  const selfDone = new Set(Array.isArray(milestones) ? milestones : []);
  const autoDone = {
    account_created: true,
    profile_set: !!profiled,
    shortlist_started: savedCount > 0,
  };
  const stages = TIMELINE.map((s) => ({
    key: s.key,
    label: s.label,
    kind: s.kind,
    hint: s.hint,
    done: s.kind === 'auto' ? !!autoDone[s.key] : selfDone.has(s.key),
    next: false,
  }));
  const nextIdx = stages.findIndex((s) => !s.done);
  if (nextIdx >= 0) stages[nextIdx].next = true;
  return { stages, next_key: nextIdx >= 0 ? stages[nextIdx].key : null };
}

// ---- Per-university application status -------------------------------------
// Makes the saved list "active" using the only application data we actually
// have: the student's own progress per school. Not deadlines/requirements
// (the register has none) — just where the student is with each saved uni.
const APPLICATION_STATUSES = [
  { key: 'considering', label: 'Considering' },
  { key: 'researching', label: 'Researching' },
  { key: 'applied', label: 'Applied' },
  { key: 'offer', label: 'Offer received' },
  { key: 'rejected', label: 'Not accepted' },
];
const APPLICATION_STATUS_KEYS = new Set(APPLICATION_STATUSES.map((s) => s.key));
const DEFAULT_STATUS = 'considering';

/**
 * Count saved universities by application status (unset = 'considering').
 * @param {Record<string,string>} applications  { uniId: status }
 * @param {string[]} savedIds
 * @returns {Record<string,number>}
 */
function statusCounts(applications, savedIds) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const id of savedIds || []) {
    const st = (applications && applications[id]) || DEFAULT_STATUS;
    counts[st] = (counts[st] || 0) + 1;
  }
  return counts;
}

// ---- Dream Plan: documents ------------------------------------------------
// The standard study-abroad document set. Self-tracked (like milestones) —
// students mark what they have. We never claim to hold or verify a document;
// this is the student's own preparation checklist, which powers the honest
// "Document readiness" indicator below.
const DOCUMENTS = [
  { key: 'transcript', label: 'Academic transcript', hint: 'Your official grades from previous studies.' },
  { key: 'english_test', label: 'English test score', hint: 'IELTS / TOEFL / Duolingo, if your program is taught in English.' },
  { key: 'passport', label: 'Valid passport', hint: 'Check it stays valid well past your intended arrival.' },
  { key: 'recommendation', label: 'Recommendation letter', hint: 'From a teacher, professor or employer.' },
  { key: 'personal_statement', label: 'Personal statement', hint: 'Your motivation letter / statement of purpose.' },
  { key: 'cv', label: 'CV / résumé', hint: 'A short academic or professional CV.' },
];
const DOCUMENT_KEYS = new Set(DOCUMENTS.map((d) => d.key));

// ---- Dream Plan: readiness indicators -------------------------------------
// The signature "how close am I?" feature — deliberately NOT an admission-chance
// prediction (we can't verify that and it would be dishonest). Each dimension
// is 0–100 from REAL state, with a concrete, actionable "what's next" line.

/**
 * @param {object} inputs
 * @param {number} inputs.completenessPercent   profileCompleteness().percent
 * @param {string[]} inputs.missingProfile       missing profile field labels
 * @param {number} inputs.savedCount
 * @param {Record<string,number>} inputs.statusCounts
 * @param {number} inputs.docsDone
 * @param {boolean} inputs.scholarshipRequired
 * @param {boolean} inputs.scholarshipsResearched
 * @returns {{key:string,label:string,score:number,detail:string}[]}
 */
function readiness(inputs) {
  const dims = [];

  // Profile — reuse the completeness score directly.
  dims.push({
    key: 'profile', label: 'Profile', score: inputs.completenessPercent,
    detail: inputs.completenessPercent >= 100
      ? 'Complete — every university is ranked for you.'
      : `Add ${(inputs.missingProfile || []).slice(0, 2).join(' and ').toLowerCase() || 'the remaining fields'} to sharpen your matches.`,
  });

  // Application — from the shortlist and how far the furthest application is.
  const has = (k) => (inputs.statusCounts && inputs.statusCounts[k]) > 0;
  let appScore = 0;
  let appDetail = 'Save universities to start building your application list.';
  if (inputs.savedCount > 0) {
    if (has('offer')) { appScore = 100; appDetail = 'Offer received — a real milestone. 🎉'; }
    else if (has('applied')) { appScore = 75; appDetail = 'Application submitted. Track the rest of your shortlist as you go.'; }
    else if (has('researching')) { appScore = 45; appDetail = 'Researching your targets — move one to “Applied” when you submit.'; }
    else { appScore = 25; appDetail = 'You have a shortlist — start researching and applying to your top choices.'; }
  }
  dims.push({ key: 'application', label: 'Application', score: appScore, detail: appDetail });

  // Documents — self-tracked checklist.
  const docTotal = DOCUMENTS.length;
  const docScore = docTotal ? Math.round((100 * inputs.docsDone) / docTotal) : 0;
  dims.push({
    key: 'documents', label: 'Documents', score: docScore,
    detail: docScore >= 100 ? 'Your document checklist is complete.'
      : `${inputs.docsDone} of ${docTotal} ready — mark each document as you prepare it.`,
  });

  // Scholarship — only a dimension if the student says they need one.
  if (inputs.scholarshipRequired) {
    dims.push({
      key: 'scholarship', label: 'Scholarship',
      score: inputs.scholarshipsResearched ? 100 : 40,
      detail: inputs.scholarshipsResearched
        ? 'You’ve reviewed scholarship options for your country.'
        : 'Check the scholarship pointers for your country, then mark that step done on your roadmap.',
    });
  }

  return dims;
}

/**
 * The single most impactful next step — the lowest-scoring readiness dimension
 * that isn't complete (ties broken by the order below: profile powers
 * everything, so it leads). Returns null only when every dimension is 100.
 */
function nextBestAction(dims) {
  const ACTION = {
    profile: { title: 'Complete your matching profile', href: '/onboarding', cta: 'Set up matching' },
    application: { title: 'Build and advance your application list', href: '/discover', cta: 'Find universities' },
    documents: { title: 'Prepare your documents', href: '/journey#documents', cta: 'Open checklist' },
    scholarship: { title: 'Research scholarships for your country', href: '/journey#roadmap', cta: 'See roadmap' },
  };
  const incomplete = dims.filter((d) => d.score < 100);
  if (!incomplete.length) return null;
  // lowest score first; stable order among the fixed dimension keys as tiebreak
  const priority = ['profile', 'application', 'documents', 'scholarship'];
  incomplete.sort((a, b) => (a.score - b.score) || (priority.indexOf(a.key) - priority.indexOf(b.key)));
  const top = incomplete[0];
  const a = ACTION[top.key] || { title: top.label, href: '/journey', cta: 'Continue' };
  return { key: top.key, title: a.title, body: top.detail, href: a.href, cta: a.cta };
}

module.exports = {
  PROFILE_DIMENSIONS, profileCompleteness, nextActions,
  TIMELINE, SELF_MILESTONE_KEYS, buildTimeline,
  APPLICATION_STATUSES, APPLICATION_STATUS_KEYS, DEFAULT_STATUS, statusCounts,
  DOCUMENTS, DOCUMENT_KEYS, readiness, nextBestAction,
};
