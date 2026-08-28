"use strict";

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
  {
    key: "fields_of_interest",
    label: "Fields of study",
    filled: (s) => (s.fields_of_interest || []).length > 0,
  },
  {
    key: "degree_level",
    label: "Degree level",
    filled: (s) => !!s.degree_level,
  },
  {
    key: "budget_max_eur_year",
    label: "Budget",
    filled: (s) => s.budget_max_eur_year != null,
  },
  {
    key: "preferred_languages",
    label: "Study language",
    filled: (s) => (s.preferred_languages || []).length > 0,
  },
  {
    key: "country_preference",
    label: "Preferred countries",
    filled: (s) => (s.country_preference || []).length > 0,
  },
  {
    key: "city_preference",
    label: "City size",
    filled: (s) => !!s.city_preference,
  },
];

/**
 * @param {object} student
 * @returns {{ filled:number, total:number, percent:number, missing:string[], dimensions:{key:string,label:string,filled:boolean}[] }}
 */
function profileCompleteness(student) {
  const dimensions = PROFILE_DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    filled: !!student && d.filled(student),
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
      key: "complete_profile",
      title: first
        ? "Set up your matching profile"
        : "Finish your matching profile",
      body: first
        ? "Answer a few quick questions so every university is ranked for you, not just listed A–Z."
        : `Add ${completeness.missing.slice(0, 2).join(" and ").toLowerCase()} to sharpen your matches.`,
      href: "/onboarding",
      cta: first ? "Start — 30 sec" : "Continue",
    });
  }

  if (savedCount === 0) {
    actions.push({
      key: "save_first",
      title: "Save your first university",
      body: "Build a shortlist you can compare side by side as you decide.",
      href: "/discover",
      cta: "Browse universities",
    });
  } else if (savedCount < 3) {
    actions.push({
      key: "save_more",
      title: `You've saved ${savedCount} — add a couple more`,
      body: "Comparing three to five options side by side makes the decision much clearer.",
      href: "/discover",
      cta: "Find more",
    });
  } else {
    actions.push({
      key: "compare",
      title: `Compare your ${savedCount} saved universities`,
      body: "Review tuition, teaching language and fit across your shortlist.",
      href: "/compare",
      cta: "Compare side by side",
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
  {
    key: "account_created",
    label: "Created your account",
    kind: "auto",
    hint: "",
  },
  {
    key: "profile_set",
    label: "Set up your matching profile",
    kind: "auto",
    hint: "Answer a few quick questions so universities are ranked for you.",
  },
  {
    key: "shortlist_started",
    label: "Built a shortlist",
    kind: "auto",
    hint: "Save the universities you want to compare.",
  },
  {
    key: "scholarships_researched",
    label: "Researched scholarships",
    kind: "self",
    hint: "Check the scholarship pointers for your country and the universities’ own aid pages.",
  },
  {
    // Derived from your applications' statuses (no double-entry): true once any
    // application has moved past "Planning".
    key: "application_started",
    label: "Started an application",
    kind: "auto",
    hint: "Begin an application on a university’s official page.",
  },
  {
    key: "application_submitted",
    label: "Submitted an application",
    kind: "auto",
    hint: "Set an application's status to Submitted once you send it.",
  },
  {
    key: "offer_received",
    label: "Received an offer",
    kind: "auto",
    hint: "Set an application to Accepted when an offer arrives.",
  },
  {
    key: "visa_started",
    label: "Started visa & travel",
    kind: "self",
    hint: "Begin your visa application and travel planning.",
  },
  {
    key: "arrived",
    label: "Arrived",
    kind: "self",
    hint: "You made it. Same start, equal chance.",
  },
];

// The only milestone keys a client may toggle (the auto ones are never
// client-settable — they reflect real state).
const SELF_MILESTONE_KEYS = new Set(
  TIMELINE.filter((s) => s.kind === "self").map((s) => s.key),
);

/**
 * @param {boolean} profiled   result of match.hasProfile(student)
 * @param {number} savedCount
 * @param {string[]} [milestones]  the student's self-reported milestone keys
 * @returns {{ stages:{key:string,label:string,kind:string,hint:string,done:boolean,next:boolean}[], next_key:string|null }}
 */
function buildTimeline(profiled, savedCount, milestones, appStatuses) {
  const selfDone = new Set(Array.isArray(milestones) ? milestones : []);
  const statuses = Array.isArray(appStatuses) ? appStatuses : [];
  const STARTED = new Set([
    "preparing",
    "ready",
    "submitted",
    "under_review",
    "accepted",
    "rejected",
  ]);
  const SUBMITTED = new Set(["submitted", "under_review", "accepted", "rejected"]);
  const autoDone = {
    account_created: true,
    profile_set: !!profiled,
    shortlist_started: savedCount > 0,
    application_started: statuses.some((s) => STARTED.has(s)),
    application_submitted: statuses.some((s) => SUBMITTED.has(s)),
    offer_received: statuses.some((s) => s === "accepted"),
  };
  const stages = TIMELINE.map((s) => ({
    key: s.key,
    label: s.label,
    kind: s.kind,
    hint: s.hint,
    done: s.kind === "auto" ? !!autoDone[s.key] : selfDone.has(s.key),
    next: false,
  }));
  const nextIdx = stages.findIndex((s) => !s.done);
  if (nextIdx >= 0) stages[nextIdx].next = true;
  return { stages, next_key: nextIdx >= 0 ? stages[nextIdx].key : null };
}

// ---- Per-university application status -------------------------------------
// Each saved university IS an application. Its lifecycle is student-reported —
// the register has no requirements or deadlines, so nothing here is asserted by
// Universo; it's all the student's own progress. Submission (submitted/…) is
// tracked separately from document readiness on purpose.
const APPLICATION_STATUSES = [
  { key: "planning", label: "Planning" },
  { key: "preparing", label: "Preparing" },
  { key: "ready", label: "Ready to submit" },
  { key: "submitted", label: "Submitted" },
  { key: "under_review", label: "Under review" },
  { key: "accepted", label: "Accepted" },
  { key: "rejected", label: "Not accepted" },
];
const APPLICATION_STATUS_KEYS = new Set(APPLICATION_STATUSES.map((s) => s.key));
const DEFAULT_STATUS = "planning";
// Old 5-status scheme → new lifecycle. Applied lazily so stored bare-string
// entries keep working without a migration pass.
const LEGACY_STATUS = {
  considering: "planning",
  researching: "preparing",
  applied: "submitted",
  offer: "accepted",
  rejected: "rejected",
};

/**
 * Normalize a stored application entry to the object shape. Accepts the legacy
 * bare status string, an object, or undefined (a saved uni with no entry yet).
 * @param {string|object|undefined} val
 * @returns {{status:string, deadline:string, program:string, req:Record<string,string>, docs:Record<string,boolean>}}
 */
function normalizeApplication(val) {
  if (typeof val === "string") {
    return {
      status: LEGACY_STATUS[val] || DEFAULT_STATUS,
      deadline: "",
      program: "",
      req: {},
      docs: {},
    };
  }
  const v = val && typeof val === "object" ? val : {};
  return {
    status: APPLICATION_STATUS_KEYS.has(v.status) ? v.status : DEFAULT_STATUS,
    deadline: typeof v.deadline === "string" ? v.deadline : "",
    program: typeof v.program === "string" ? v.program : "",
    req: v.req && typeof v.req === "object" ? v.req : {},
    docs: v.docs && typeof v.docs === "object" ? v.docs : {},
    // Extra docs the student added for this application (portfolio, GRE, an
    // essay…) — always unique to the application, never shared.
    custom: Array.isArray(v.custom) ? v.custom : [],
  };
}

/**
 * Whole days from today (local) until a YYYY-MM-DD date. Negative = past.
 * null for an empty/invalid date.
 * @param {string} dateStr
 * @returns {number|null}
 */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

/**
 * Count saved universities by application status (unset = 'planning').
 * @param {Record<string,string|object>} applications  { uniId: status|entry }
 * @param {string[]} savedIds
 * @returns {Record<string,number>}
 */
function statusCounts(applications, savedIds) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const id of savedIds || []) {
    const st = normalizeApplication(applications && applications[id]).status;
    counts[st] = (counts[st] || 0) + 1;
  }
  return counts;
}

// ---- Dream Plan: documents ------------------------------------------------
// The standard study-abroad document set. Self-tracked (like milestones) —
// students mark what they have. We never claim to hold or verify a document;
// this is the student's own preparation checklist, which powers the honest
// "Document readiness" indicator below.
// `shared` = reusable across applications (prepared once, lives in the vault:
// student.documents). Non-shared = written per application (e.g. a motivation
// letter for THIS university), tracked on the application itself.
// `default_level` = the requirement level a new application starts each doc at;
// the student can override it per application.
const DOCUMENTS = [
  {
    key: "transcript",
    label: "Academic transcript",
    hint: "Your official grades from previous studies.",
    shared: true,
    default_level: "required",
  },
  {
    key: "english_test",
    label: "English test score",
    hint: "IELTS / TOEFL / Duolingo, if your program is taught in English.",
    shared: true,
    default_level: "required",
  },
  {
    key: "passport",
    label: "Valid passport",
    hint: "Check it stays valid well past your intended arrival.",
    shared: true,
    default_level: "required",
  },
  {
    key: "recommendation",
    label: "Recommendation letter",
    hint: "From a teacher, professor or employer.",
    shared: true,
    default_level: "recommended",
  },
  {
    key: "personal_statement",
    label: "Motivation letter",
    hint: "Written fresh for each university — your statement of purpose.",
    shared: false,
    default_level: "required",
  },
  {
    key: "cv",
    label: "CV / résumé",
    hint: "A short academic or professional CV.",
    shared: true,
    default_level: "recommended",
  },
];
const DOCUMENT_KEYS = new Set(DOCUMENTS.map((d) => d.key));

// Per-application requirement levels. 'conditional' currently scores like
// 'recommended' (shown, not counted against required completion).
// ponytail: no real per-uni condition source exists; upgrade to true
// conditional logic only if structured requirement data ever arrives.
const LEVELS = ["required", "recommended", "conditional", "not_required"];
const LEVEL_KEYS = new Set(LEVELS);

/**
 * Build the per-application document view: every document with its requirement
 * level for this application and whether it's ready. Shared docs read readiness
 * from the vault (reuse across applications); non-shared from the app itself.
 * @param {string|object|undefined} appRaw  stored application entry
 * @param {{id:string, name:string}} uni
 * @param {Record<string,boolean>} vaultDocs  student.documents
 */
function applicationView(appRaw, uni, vaultDocs = {}) {
  const app = normalizeApplication(appRaw);
  const docs = DOCUMENTS.map((d) => {
    const level = LEVEL_KEYS.has(app.req[d.key]) ? app.req[d.key] : d.default_level;
    const ready = d.shared ? vaultDocs[d.key] === true : app.docs[d.key] === true;
    return { key: d.key, label: d.label, shared: d.shared, custom: false, level, ready };
  });
  for (const c of app.custom) {
    docs.push({
      key: c.id,
      label: c.label,
      shared: false,
      custom: true,
      level: LEVEL_KEYS.has(c.level) ? c.level : "required",
      ready: c.ready === true,
    });
  }
  const required = docs.filter((d) => d.level === "required");
  return {
    uni_id: uni.id,
    name: uni.name,
    program: app.program,
    deadline: app.deadline,
    days_left: daysUntil(app.deadline),
    status: app.status,
    // Real, verifiable pointers from the university record (never invented):
    // where to actually apply, and — for curated unis only — the official
    // deadline/requirements text, shown as a "verify" hint, not an assertion.
    portal: uni.application_link || uni.website || "",
    curated_deadline: uni.application_deadline || "",
    curated_requirements: uni.acceptance_requirements || "",
    docs,
    required_total: required.length,
    required_done: required.filter((d) => d.ready).length,
    missing_required: required.filter((d) => !d.ready).map((d) => d.label),
  };
}

/**
 * Build an application view for every saved university (the saved list is the
 * driver — an application IS a saved uni, whether or not it has a stored entry).
 * @param {{id:string, name:string}[]} savedUnis
 * @param {Record<string,string|object>} applications
 * @param {Record<string,boolean>} vaultDocs
 */
function buildApplications(savedUnis, applications = {}, vaultDocs = {}) {
  return (savedUnis || []).map((u) =>
    applicationView(applications[u.id], u, vaultDocs),
  );
}

// Deadline triage: soonest first (overdue negatives lead), applications with
// no deadline last. Stable for equal keys, so save order breaks ties.
function sortApplications(views) {
  return [...(views || [])].sort((a, b) => {
    if (a.days_left == null && b.days_left == null) return 0;
    if (a.days_left == null) return 1;
    if (b.days_left == null) return -1;
    return a.days_left - b.days_left;
  });
}

// Green / amber / red bucket for one application's document completion.
function docTone(v) {
  if (v.required_total === 0 || v.required_done === v.required_total)
    return "complete";
  return v.required_done === 0 ? "missing" : "partial";
}

function deadlineTone(days) {
  if (days < 0) return "overdue";
  if (days <= 3) return "red";
  if (days <= 7) return "amber";
  return "green";
}

/**
 * High-level roll-up for the Dream Plan header, derived from the application
 * views built by buildApplications().
 * @param {ReturnType<typeof buildApplications>} views
 */
function applicationsOverview(views) {
  const v = Array.isArray(views) ? views : [];
  let ready = 0;
  let missing = 0;
  let in_progress = 0;
  let requirements_done = 0;
  let requirements_total = 0;
  const deadlines = [];
  for (const a of v) {
    requirements_total += a.required_total;
    requirements_done += a.required_done;
    const tone = docTone(a);
    if (tone === "complete") ready++;
    else if (tone === "missing") missing++;
    else in_progress++;
    if (a.days_left != null)
      deadlines.push({
        name: a.name,
        days_left: a.days_left,
        tone: deadlineTone(a.days_left),
      });
  }
  deadlines.sort((x, y) => x.days_left - y.days_left);
  return {
    total: v.length,
    ready,
    in_progress,
    missing,
    requirements_done,
    requirements_total,
    upcoming_deadlines: deadlines.slice(0, 5),
  };
}

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
    key: "profile",
    label: "Profile",
    score: inputs.completenessPercent,
    detail:
      inputs.completenessPercent >= 100
        ? "Complete — every university is ranked for you."
        : `Add ${(inputs.missingProfile || []).slice(0, 2).join(" and ").toLowerCase() || "the remaining fields"} to sharpen your matches.`,
  });

  // Application — from the shortlist and how far the furthest application is.
  const has = (k) => (inputs.statusCounts && inputs.statusCounts[k]) > 0;
  let appScore = 0;
  let appDetail = "Save universities to start building your application list.";
  if (inputs.savedCount > 0) {
    if (has("accepted")) {
      appScore = 100;
      appDetail = "Accepted — a real milestone. 🎉";
    } else if (has("submitted") || has("under_review")) {
      appScore = 75;
      appDetail =
        "Application submitted. Track the rest of your shortlist as you go.";
    } else if (has("preparing") || has("ready")) {
      appScore = 45;
      appDetail =
        "Preparing your applications — move one to “Submitted” once you send it.";
    } else {
      appScore = 25;
      appDetail =
        "You have a shortlist — start preparing and submitting your top choices.";
    }
  }
  dims.push({
    key: "application",
    label: "Application",
    score: appScore,
    detail: appDetail,
  });

  // Documents — self-tracked checklist.
  const docTotal = DOCUMENTS.length;
  const docScore = docTotal
    ? Math.round((100 * inputs.docsDone) / docTotal)
    : 0;
  dims.push({
    key: "documents",
    label: "Documents",
    score: docScore,
    detail:
      docScore >= 100
        ? "Your document checklist is complete."
        : `${inputs.docsDone} of ${docTotal} ready — mark each document as you prepare it.`,
  });

  // Scholarship — only a dimension if the student says they need one.
  if (inputs.scholarshipRequired) {
    dims.push({
      key: "scholarship",
      label: "Scholarship",
      score: inputs.scholarshipsResearched ? 100 : 40,
      detail: inputs.scholarshipsResearched
        ? "You’ve reviewed scholarship options for your country."
        : "Check the scholarship pointers for your country, then mark that step done on your roadmap.",
    });
  }

  return dims;
}

/**
 * A looming deadline with missing required documents outranks everything else —
 * it's the one thing that can't be recovered if missed. Picks the soonest such
 * application within ~two weeks (overdue included). Null if none.
 * @param {ReturnType<typeof buildApplications>} views
 */
function deadlineAction(views) {
  if (!Array.isArray(views)) return null;
  const cand = views
    .filter(
      (v) =>
        v.days_left != null && v.days_left <= 14 && v.missing_required.length,
    )
    .sort((a, b) => a.days_left - b.days_left);
  if (!cand.length) return null;
  const v = cand[0];
  const when =
    v.days_left < 0
      ? "overdue"
      : v.days_left === 0
        ? "due today"
        : `due in ${v.days_left} day${v.days_left === 1 ? "" : "s"}`;
  const n = v.missing_required.length;
  return {
    key: "deadline",
    title: `Your ${v.name} application is ${when}`,
    body: `Missing ${n} required document${n === 1 ? "" : "s"}: ${v.missing_required.join(", ")}.`,
    href: "/journey#applications",
    cta: "Open application",
  };
}

/**
 * The single most impactful next step. A missed-deadline risk leads if present;
 * otherwise the lowest-scoring readiness dimension that isn't complete (ties
 * broken by the order below: profile powers everything, so it leads). Returns
 * null only when there's nothing left to do.
 * @param {{key:string,score:number,detail:string,label:string}[]} dims
 * @param {ReturnType<typeof buildApplications>} [views]  application views (optional)
 */
function nextBestAction(dims, views) {
  const urgent = deadlineAction(views);
  if (urgent) return urgent;
  const ACTION = {
    profile: {
      title: "Complete your matching profile",
      href: "/onboarding",
      cta: "Set up matching",
    },
    application: {
      title: "Build and advance your application list",
      href: "/discover",
      cta: "Find universities",
    },
    documents: {
      title: "Prepare your documents",
      href: "/journey#documents",
      cta: "Open checklist",
    },
    scholarship: {
      title: "Research scholarships for your country",
      href: "/journey#roadmap",
      cta: "See roadmap",
    },
  };
  const incomplete = dims.filter((d) => d.score < 100);
  if (!incomplete.length) return null;
  // lowest score first; stable order among the fixed dimension keys as tiebreak
  const priority = ["profile", "application", "documents", "scholarship"];
  incomplete.sort(
    (a, b) =>
      a.score - b.score || priority.indexOf(a.key) - priority.indexOf(b.key),
  );
  const top = incomplete[0];
  const a = ACTION[top.key] || {
    title: top.label,
    href: "/journey",
    cta: "Continue",
  };
  return {
    key: top.key,
    title: a.title,
    body: top.detail,
    href: a.href,
    cta: a.cta,
  };
}

module.exports = {
  PROFILE_DIMENSIONS,
  profileCompleteness,
  nextActions,
  TIMELINE,
  SELF_MILESTONE_KEYS,
  buildTimeline,
  APPLICATION_STATUSES,
  APPLICATION_STATUS_KEYS,
  DEFAULT_STATUS,
  normalizeApplication,
  daysUntil,
  statusCounts,
  DOCUMENTS,
  DOCUMENT_KEYS,
  LEVELS,
  LEVEL_KEYS,
  applicationView,
  buildApplications,
  sortApplications,
  applicationsOverview,
  readiness,
  deadlineAction,
  nextBestAction,
};
