"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const journey = require("../lib/journey");

test("profileCompleteness: empty profile is 0%, all six dimensions is 100%", () => {
  const empty = journey.profileCompleteness({});
  assert.equal(empty.filled, 0);
  assert.equal(empty.percent, 0);
  assert.equal(empty.total, 6);
  assert.equal(empty.missing.length, 6);

  const full = journey.profileCompleteness({
    fields_of_interest: ["Computer Science"],
    degree_level: "Master",
    budget_max_eur_year: 6000,
    preferred_languages: ["English"],
    country_preference: ["Germany"],
    city_preference: "large",
  });
  assert.equal(full.filled, 6);
  assert.equal(full.percent, 100);
  assert.deepEqual(full.missing, []);
});

test("profileCompleteness: budget of 0 counts as filled (a real answer), null does not", () => {
  const zero = journey.profileCompleteness({ budget_max_eur_year: 0 });
  assert.ok(
    zero.dimensions.find((d) => d.key === "budget_max_eur_year").filled,
    "0 EUR is a valid budget answer",
  );
  const none = journey.profileCompleteness({ budget_max_eur_year: null });
  assert.ok(
    !none.dimensions.find((d) => d.key === "budget_max_eur_year").filled,
  );
});

test("profileCompleteness: partial profile reports the right percent and missing labels", () => {
  const c = journey.profileCompleteness({
    fields_of_interest: ["Law"],
    degree_level: "Bachelor",
  });
  assert.equal(c.filled, 2);
  assert.equal(c.percent, 33); // 2/6 rounded
  assert.ok(c.missing.includes("Budget"));
  assert.ok(!c.missing.includes("Fields of study"));
});

test("nextActions: empty profile + no saved → set up profile, then save first", () => {
  const c = journey.profileCompleteness({});
  const actions = journey.nextActions(0, c);
  assert.equal(actions[0].key, "complete_profile");
  assert.match(actions[0].title, /Set up/);
  assert.equal(actions[0].href, "/onboarding");
  assert.equal(actions[1].key, "save_first");
});

test("buildTimeline: fresh student has only account_created done, profile_set is next", () => {
  const t = journey.buildTimeline(false, 0, []);
  assert.equal(t.stages.length, 9);
  assert.equal(t.stages[0].key, "account_created");
  assert.equal(t.stages[0].done, true);
  assert.equal(t.stages[1].done, false);
  assert.equal(t.next_key, "profile_set");
  assert.equal(t.stages.find((s) => s.key === "profile_set").next, true);
});

test("buildTimeline: auto stages reflect real state (profiled + saved)", () => {
  const t = journey.buildTimeline(true, 3, []);
  assert.equal(t.stages.find((s) => s.key === "profile_set").done, true);
  assert.equal(t.stages.find((s) => s.key === "shortlist_started").done, true);
  assert.equal(
    t.next_key,
    "scholarships_researched",
    "first self stage is next once autos are done",
  );
});

test("buildTimeline: self milestones mark their stage; application stages derive from statuses", () => {
  // scholarships_researched is still self-reported; application_started is now
  // DERIVED — a 'preparing' application marks it done without a second click.
  const t = journey.buildTimeline(true, 1, ["scholarships_researched"], [
    "preparing",
  ]);
  assert.equal(
    t.stages.find((s) => s.key === "scholarships_researched").done,
    true,
  );
  assert.equal(
    t.stages.find((s) => s.key === "application_started").done,
    true,
    "a preparing application counts as started",
  );
  assert.equal(
    t.stages.find((s) => s.key === "application_submitted").done,
    false,
    "preparing is not yet submitted",
  );
  assert.equal(t.next_key, "application_submitted");
});

test("buildTimeline: submitted/accepted statuses light the later derived stages", () => {
  const t = journey.buildTimeline(true, 2, [], ["planning", "accepted"]);
  const by = (k) => t.stages.find((s) => s.key === k).done;
  assert.equal(by("application_started"), true, "accepted implies started");
  assert.equal(by("application_submitted"), true, "accepted implies submitted");
  assert.equal(by("offer_received"), true, "accepted is an offer");
  // application_started/submitted/offer_received are no longer client-settable.
  assert.ok(!journey.SELF_MILESTONE_KEYS.has("application_submitted"));
  assert.ok(!journey.SELF_MILESTONE_KEYS.has("offer_received"));
  assert.ok(journey.SELF_MILESTONE_KEYS.has("visa_started"));
});

test("buildTimeline: next is the FIRST incomplete stage even if a later one is marked", () => {
  // A student who ticked "arrived" but never set a profile: arrived shows done,
  // but the roadmap still points them at the first real gap.
  const t = journey.buildTimeline(false, 0, ["arrived"]);
  assert.equal(t.stages.find((s) => s.key === "arrived").done, true);
  assert.equal(t.next_key, "profile_set");
});

test("readiness: computes profile/application/documents dimensions from real state", () => {
  const dims = journey.readiness({
    completenessPercent: 50,
    missingProfile: ["Budget", "Study language"],
    savedCount: 2,
    statusCounts: { planning: 1, submitted: 1 },
    docsDone: 3,
    scholarshipRequired: false,
    scholarshipsResearched: false,
  });
  const by = Object.fromEntries(dims.map((d) => [d.key, d.score]));
  assert.equal(by.profile, 50);
  assert.equal(
    by.application,
    75,
    "a submitted status lifts application readiness",
  );
  assert.equal(by.documents, 50, "3 of 6 documents");
  assert.ok(
    !("scholarship" in by),
    "scholarship dimension only appears when required",
  );
  assert.ok(
    dims.find((d) => d.key === "profile").detail.length > 0,
    "every dimension explains what to do",
  );
});

test("readiness: scholarship dimension appears only when required", () => {
  const withReq = journey.readiness({
    completenessPercent: 100,
    missingProfile: [],
    savedCount: 1,
    statusCounts: { planning: 1 },
    docsDone: 6,
    scholarshipRequired: true,
    // Reviewed the list but not yet tracking a specific scheme → mid score.
    scholarshipsResearched: true,
  });
  assert.ok(withReq.some((d) => d.key === "scholarship" && d.score === 50));
  const notReq = journey.readiness({
    completenessPercent: 100,
    missingProfile: [],
    savedCount: 1,
    statusCounts: { planning: 1 },
    docsDone: 6,
    scholarshipRequired: false,
  });
  assert.ok(!notReq.some((d) => d.key === "scholarship"));
});

test("nextBestAction: picks the lowest-scoring incomplete dimension; null when all complete", () => {
  const dims = journey.readiness({
    completenessPercent: 30,
    missingProfile: ["Budget"],
    savedCount: 0,
    statusCounts: {},
    docsDone: 6,
    scholarshipRequired: false,
    scholarshipsResearched: false,
  });
  const nba = journey.nextBestAction(dims);
  // application is 0 (no saved) which is lower than profile 30 → application leads
  assert.equal(nba.key, "application");

  const allDone = journey.readiness({
    completenessPercent: 100,
    missingProfile: [],
    savedCount: 1,
    statusCounts: { accepted: 1 },
    docsDone: 6,
    scholarshipRequired: false,
    scholarshipsResearched: false,
  });
  assert.equal(
    journey.nextBestAction(allDone),
    null,
    "nothing left to do → no next action",
  );
});

test("DOCUMENT_KEYS holds the checklist keys and excludes unknowns", () => {
  assert.ok(journey.DOCUMENT_KEYS.has("transcript"));
  assert.ok(journey.DOCUMENT_KEYS.has("english_test"));
  assert.ok(!journey.DOCUMENT_KEYS.has("nonsense"));
  assert.equal(journey.DOCUMENTS.length, journey.DOCUMENT_KEYS.size);
});

test("statusCounts: legacy string statuses migrate; unset saved unis default to planning", () => {
  // 'applied'/'offer' are the OLD scheme — statusCounts normalizes them.
  const counts = journey.statusCounts({ a: "applied", b: "offer" }, [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.equal(counts.submitted, 1, "applied → submitted");
  assert.equal(counts.accepted, 1, "offer → accepted");
  assert.equal(counts.planning, 2, "c and d have no status → planning");
});

test("statusCounts: object entries and empty list", () => {
  assert.deepEqual(journey.statusCounts({}, []), {});
  const counts = journey.statusCounts({ a: { status: "ready" } }, ["a"]);
  assert.equal(counts.ready, 1);
});

test("APPLICATION_STATUS_KEYS holds exactly the seven lifecycle stages", () => {
  assert.equal(journey.APPLICATION_STATUS_KEYS.size, 7);
  assert.ok(journey.APPLICATION_STATUS_KEYS.has("planning"));
  assert.ok(journey.APPLICATION_STATUS_KEYS.has("under_review"));
  assert.ok(journey.APPLICATION_STATUS_KEYS.has("accepted"));
  assert.ok(!journey.APPLICATION_STATUS_KEYS.has("offer"));
  assert.equal(journey.DEFAULT_STATUS, "planning");
});

test("normalizeApplication: legacy string, object, and undefined", () => {
  const fromStr = journey.normalizeApplication("researching");
  assert.equal(fromStr.status, "preparing", "researching → preparing");
  assert.deepEqual(fromStr.req, {});
  assert.deepEqual(fromStr.docs, {});

  const fromUndef = journey.normalizeApplication(undefined);
  assert.equal(fromUndef.status, "planning");

  const fromObj = journey.normalizeApplication({
    status: "submitted",
    deadline: "2026-01-15",
    program: "CS",
    req: { cv: "required" },
    docs: { personal_statement: true },
  });
  assert.equal(fromObj.status, "submitted");
  assert.equal(fromObj.deadline, "2026-01-15");
  assert.equal(fromObj.req.cv, "required");

  // An unknown status falls back to the default rather than trusting it.
  assert.equal(journey.normalizeApplication({ status: "bogus" }).status, "planning");
});

test("applicationView: completion is per-application (app.docs); vault only sets the `have` hint", () => {
  const uni = { id: "u1", name: "Helsinki" };
  // The student HAS transcript + passport on file, but completion for THIS
  // application comes only from its own docs map — the vault never ticks it.
  const vault = { transcript: true, passport: true };
  const app = {
    status: "preparing",
    req: { english_test: "not_required" }, // drop english from required
    docs: { transcript: true }, // only transcript done for THIS application
  };
  const v = journey.applicationView(app, uni, vault);
  // Required set = transcript, passport, personal_statement (english dropped).
  assert.equal(v.required_total, 3);
  assert.equal(v.required_done, 1, "only this app's own transcript counts");
  assert.deepEqual(v.missing_required.sort(), ["Motivation letter", "Valid passport"]);
  // Passport is on file (have) but not ticked for this application (ready).
  const passport = v.docs.find((d) => d.key === "passport");
  assert.equal(passport.have, true, "recognized as on file");
  assert.equal(passport.ready, false, "but not done for this application");
  const cv = v.docs.find((d) => d.key === "cv");
  assert.equal(cv.shared, true);
  assert.equal(cv.have, false, "cv not on file → no hint");
});

test("applicationView: independent — the SAME shared doc differs across applications", () => {
  const uni = { id: "u1", name: "Helsinki" };
  const uni2 = { id: "u2", name: "Aalto" };
  const vault = { passport: true }; // possessed on file
  const a = journey.applicationView({ docs: { passport: true } }, uni, vault);
  const b = journey.applicationView({ docs: {} }, uni2, vault);
  assert.equal(a.docs.find((d) => d.key === "passport").ready, true);
  assert.equal(b.docs.find((d) => d.key === "passport").ready, false, "checking passport for A never ticks B");
});

test("applicationView + buildApplications: unique doc readiness is per-application", () => {
  const unis = [
    { id: "u1", name: "Helsinki" },
    { id: "u2", name: "Aalto" },
  ];
  const apps = {
    u1: { docs: { personal_statement: true } }, // letter done for Helsinki only
    u2: {},
  };
  const views = journey.buildApplications(unis, apps, {});
  const helsinki = views.find((v) => v.uni_id === "u1");
  const aalto = views.find((v) => v.uni_id === "u2");
  assert.equal(
    helsinki.docs.find((d) => d.key === "personal_statement").ready,
    true,
  );
  assert.equal(
    aalto.docs.find((d) => d.key === "personal_statement").ready,
    false,
    "the letter is unique per application, not shared",
  );
});

test("applicationsOverview: buckets by document completion and sorts deadlines", () => {
  const unis = [
    { id: "u1", name: "Helsinki" },
    { id: "u2", name: "Aalto" },
    { id: "u3", name: "Turku" },
  ];
  // Completion is per-application: every required doc must be ticked in the
  // application's OWN docs map (the vault no longer completes anything).
  const allRequired = {
    transcript: true,
    passport: true,
    english_test: true,
    personal_statement: true,
  };
  const apps = {
    u1: { deadline: "2999-12-31", docs: { ...allRequired } },
    u2: { deadline: "2999-01-01", docs: { ...allRequired } },
  };
  const views = journey.buildApplications(unis, apps, {});
  const ov = journey.applicationsOverview(views);
  assert.equal(ov.total, 3, "every saved uni is an application");
  assert.equal(ov.ready, 2, "u1 and u2 have every required doc ticked");
  assert.equal(ov.in_progress, 0);
  assert.equal(ov.missing, 1, "u3 (empty) has nothing ticked");
  assert.equal(ov.upcoming_deadlines.length, 2, "only the two with a deadline");
  assert.equal(ov.upcoming_deadlines[0].name, "Aalto", "earliest deadline first");
});

test("sinceAway: honest deadline deltas after a real absence; null otherwise", () => {
  const now = new Date("2026-02-20T00:00:00Z");
  const tenDaysAgo = "2026-02-10T00:00:00Z";
  const views = [
    { uni_id: "u1", name: "Helsinki", days_left: 5 }, // was ~15d → newly urgent
    { uni_id: "u2", name: "Aalto", days_left: -2 }, // was ~8d → newly overdue
    { uni_id: "u3", name: "Turku", days_left: 40 }, // still far → excluded
    { uni_id: "u4", name: "Oulu", days_left: null }, // no deadline → excluded
  ];
  const sa = journey.sinceAway(views, tenDaysAgo, now);
  assert.equal(sa.away_days, 10);
  assert.deepEqual(
    sa.items.map((i) => `${i.uni_id}:${i.kind}`),
    ["u1:urgent", "u2:overdue"],
  );

  // No previous visit, or too recent an absence → nothing.
  assert.equal(journey.sinceAway(views, "", now), null);
  assert.equal(
    journey.sinceAway(views, "2026-02-19T18:00:00Z", now),
    null,
    "a few hours away is not 'since you were away'",
  );
  // Away a while but nothing changed → null (Turku alone).
  assert.equal(
    journey.sinceAway([views[2]], tenDaysAgo, now),
    null,
  );
});

test("computeFunding: uses hand-researched tuition + living, computes the gap", () => {
  const unis = [
    {
      name: "A",
      tuition_source: "curated_research",
      tuition_range: { min: 0, max: 3000 },
      estimated_living_cost: { min: 1000, max: 1500 }, // per month
    },
    {
      name: "B (estimated tuition — ignored)",
      tuition_source: "country_estimate",
      tuition_range: { min: 5000, max: 9000 },
      estimated_living_cost: { min: 900, max: 1200 },
    },
  ];
  const f = journey.computeFunding(unis, 15000);
  assert.equal(f.count, 1, "only the curated-tuition uni counts");
  assert.equal(f.annual_min, 0 + 1000 * 12); // 12000
  assert.equal(f.annual_max, 3000 + 1500 * 12); // 21000
  assert.equal(f.gap, 21000 - 15000, "gap = max annual cost - budget");

  assert.equal(
    journey.computeFunding([], 15000),
    null,
    "nothing honest to show → null",
  );
  const noBudget = journey.computeFunding([unis[0]], null);
  assert.equal(noBudget.gap, null, "no budget → no gap, but still a cost range");
});

test("readiness: scholarship dimension scores from tracked scheme statuses", () => {
  const mk = (statuses) =>
    journey
      .readiness({
        completenessPercent: 100,
        missingProfile: [],
        savedCount: 1,
        statusCounts: { planning: 1 },
        docsDone: 6,
        scholarshipRequired: true,
        scholarshipStatuses: statuses,
      })
      .find((d) => d.key === "scholarship").score;
  assert.equal(mk(["applied"]), 100);
  assert.equal(mk(["applying"]), 70);
  assert.equal(mk(["researching"]), 50);
  assert.equal(mk([]), 30, "needs one but tracking none → low");
});

test("annualCost: curated tuition + living, else unknown", () => {
  const known = journey.annualCost({
    tuition_source: "curated_research",
    tuition_range: { min: 0, max: 3000 },
    estimated_living_cost: { min: 1000, max: 1500 },
  });
  assert.deepEqual(known, { min: 12000, max: 21000, known: true });
  const est = journey.annualCost({
    tuition_source: "country_estimate",
    tuition_range: { min: 5000, max: 9000 },
    estimated_living_cost: { min: 900, max: 1200 },
  });
  assert.equal(est.known, false, "estimated tuition is never treated as fact");
});

test("applicationView: program + intake flow through; normalizeApplication carries intake", () => {
  const n = journey.normalizeApplication({ intake: "Fall 2027", program: "CS" });
  assert.equal(n.intake, "Fall 2027");
  assert.equal(journey.normalizeApplication("applied").intake, "");
  const v = journey.applicationView(
    { program: "Data Science", intake: "Spring 2028" },
    { id: "u1", name: "X" },
    {},
  );
  assert.equal(v.program, "Data Science");
  assert.equal(v.intake, "Spring 2028");
});

test("applicationView: a curated listing marks docs 'listed', editable, never fabricated", () => {
  const uni = {
    id: "u1",
    name: "Curated",
    acceptance_requirements:
      "Recognised prior degree, proof of English (IELTS 6.5), and a recommendation letter.",
  };
  const v = journey.applicationView({}, uni, {});
  const eng = v.docs.find((d) => d.key === "english_test");
  const rec = v.docs.find((d) => d.key === "recommendation");
  const cv = v.docs.find((d) => d.key === "cv");
  assert.equal(eng.listed, true, "IELTS mention → english listed");
  assert.equal(eng.level, "required");
  assert.equal(rec.listed, true, "recommendation letter mention → listed");
  assert.equal(rec.level, "required", "listing nudges recommendation to required");
  assert.equal(cv.listed, false, "CV not mentioned → not listed");

  // A register uni with no listing text → nothing listed, defaults intact.
  const bare = journey.applicationView({}, { id: "u2", name: "Register" }, {});
  assert.ok(bare.docs.every((d) => d.listed === false));
  assert.equal(bare.docs.find((d) => d.key === "cv").level, "recommended");

  // Student override always wins over the listing suggestion.
  const overridden = journey.applicationView(
    { req: { recommendation: "not_required" } },
    uni,
    {},
  );
  assert.equal(
    overridden.docs.find((d) => d.key === "recommendation").level,
    "not_required",
    "the student's own choice beats the listing",
  );
});

test("applicationView: cost + over_budget from the student's budget", () => {
  const uni = {
    id: "u1",
    name: "X",
    country: "Germany",
    tuition_source: "curated_research",
    tuition_range: { min: 0, max: 3000 },
    estimated_living_cost: { min: 1000, max: 1500 },
  };
  const v = journey.applicationView({}, uni, {}, 15000);
  assert.equal(v.cost.max, 21000);
  assert.equal(v.over_budget, 6000, "21000 − 15000");
  assert.equal(v.country, "Germany");
  const noBudget = journey.applicationView({}, uni, {}, null);
  assert.equal(noBudget.over_budget, null);
});

test("normalizeApplication: priority validates + migrates legacy 'likely' → 'safety'", () => {
  assert.equal(journey.normalizeApplication({ priority: "reach" }).priority, "reach");
  assert.equal(journey.normalizeApplication({ priority: "likely" }).priority, "safety");
  assert.equal(journey.normalizeApplication({ priority: "bogus" }).priority, "");
  assert.deepEqual(
    journey.PRIORITIES.map((p) => p.key),
    ["reach", "target", "safety"],
  );
});

test("normalizeScholarship: legacy string and object", () => {
  assert.deepEqual(journey.normalizeScholarship("applied"), {
    status: "applied",
    deadline: "",
  });
  assert.deepEqual(
    journey.normalizeScholarship({ status: "applying", deadline: "2027-01-10" }),
    { status: "applying", deadline: "2027-01-10" },
  );
  assert.equal(journey.normalizeScholarship({ status: "bogus" }).status, "");
});

test("docExpiryStatus: expired, expiring soon, and fine", () => {
  const soon = new Date();
  soon.setDate(soon.getDate() + 30);
  const past = new Date();
  past.setDate(past.getDate() - 5);
  const far = new Date();
  far.setDate(far.getDate() + 400);
  assert.equal(journey.docExpiryStatus(past.toISOString().slice(0, 10)).level, "expired");
  assert.equal(journey.docExpiryStatus(soon.toISOString().slice(0, 10)).level, "soon");
  assert.equal(journey.docExpiryStatus(far.toISOString().slice(0, 10)).level, "ok");
  assert.equal(journey.docExpiryStatus(""), null);
});

test("buildAgenda: merges + sorts application, decision and scholarship dates", () => {
  const views = journey.buildApplications(
    [
      { id: "u1", name: "Helsinki" },
      { id: "u2", name: "Aalto" },
    ],
    {
      u1: { deadline: "2027-01-15" },
      u2: { status: "submitted", decision_date: "2027-03-01" },
    },
    {},
  );
  const agenda = journey.buildAgenda(views, [
    { name: "DAAD", deadline: "2027-02-01" },
  ]);
  assert.deepEqual(
    agenda.map((i) => i.kind),
    ["application", "scholarship", "decision"],
    "sorted by date across all three kinds",
  );
  assert.equal(agenda[0].href, "#app-u1");
});

test("buildActionPlan: urgent deadlines lead, shared docs grouped, unique docs per app", () => {
  const soon = new Date();
  soon.setDate(soon.getDate() + 2);
  const iso = soon.toISOString().slice(0, 10);
  const views = journey.buildApplications(
    [
      { id: "u1", name: "Helsinki" },
      { id: "u2", name: "Aalto" },
    ],
    { u1: { deadline: iso } }, // u1 near deadline, nothing ready
    {},
  );
  const plan = journey.buildActionPlan(views, {});
  assert.equal(plan[0].priority, "high", "the near deadline is first");
  assert.match(plan[0].label, /Helsinki/);
  // A shared required doc appears once, noting it covers both applications.
  const shared = plan.find((t) => t.key === "doc-transcript");
  assert.ok(shared);
  assert.match(shared.detail, /2 applications/);
  // u1 is already urgent, so its unique motivation letter isn't repeated.
  assert.ok(!plan.some((t) => t.key === "appdoc-u1-personal_statement"));
  // u2 (not urgent) does surface its unique letter.
  assert.ok(plan.some((t) => t.key === "appdoc-u2-personal_statement"));
});

test("sortApplications: soonest deadline first (overdue leads), no-deadline last", () => {
  const mk = (id, days_left) => ({ uni_id: id, days_left });
  const sorted = journey.sortApplications([
    mk("none", null),
    mk("far", 30),
    mk("overdue", -2),
    mk("soon", 3),
  ]);
  assert.deepEqual(
    sorted.map((v) => v.uni_id),
    ["overdue", "soon", "far", "none"],
  );
});

test("applicationView: custom docs count toward required and carry the custom flag", () => {
  const uni = { id: "u1", name: "Helsinki", application_link: "https://apply.example" };
  const app = {
    // Drop the built-in required docs so we isolate the custom one.
    req: {
      transcript: "not_required",
      english_test: "not_required",
      passport: "not_required",
      personal_statement: "not_required",
    },
    custom: [{ id: "c_1", label: "Portfolio", level: "required", ready: true }],
  };
  const v = journey.applicationView(app, uni, {});
  assert.equal(v.portal, "https://apply.example", "real portal link surfaced");
  const portfolio = v.docs.find((d) => d.key === "c_1");
  assert.equal(portfolio.custom, true);
  assert.equal(v.required_total, 1, "only the custom Portfolio is required");
  assert.equal(v.required_done, 1, "and it's marked ready");
});

test("applicationView: curated deadline/requirements surface as hints (never asserted as fact)", () => {
  const uni = {
    id: "u1",
    name: "Curated U",
    application_deadline: "May 31",
    acceptance_requirements: "IELTS 6.5",
  };
  const v = journey.applicationView({}, uni, {});
  assert.equal(v.curated_deadline, "May 31");
  assert.equal(v.curated_requirements, "IELTS 6.5");
  // A register uni with none of that yields empty hints, not fabricated text.
  const bare = journey.applicationView({}, { id: "u2", name: "Register U" }, {});
  assert.equal(bare.curated_deadline, "");
  assert.equal(bare.curated_requirements, "");
});

test("nextBestAction: a near deadline with missing required docs outranks everything", () => {
  const soon = new Date();
  soon.setDate(soon.getDate() + 3);
  const iso = soon.toISOString().slice(0, 10);
  const views = journey.buildApplications(
    [{ id: "u1", name: "Helsinki" }],
    { u1: { deadline: iso } }, // nothing ready → required docs missing
    {},
  );
  const dims = journey.readiness({
    completenessPercent: 100,
    missingProfile: [],
    savedCount: 1,
    statusCounts: { planning: 1 },
    docsDone: 6,
    scholarshipRequired: false,
    scholarshipsResearched: false,
  });
  const nba = journey.nextBestAction(dims, views);
  assert.equal(nba.key, "deadline");
  assert.match(nba.title, /Helsinki/);
  assert.match(nba.title, /due in 3 days/);
  assert.match(nba.body, /Motivation letter/);
});

test("deadlineAction: ignores far-off deadlines and fully-ready applications", () => {
  // Far off (>14 days) → no urgent action.
  const far = journey.buildApplications(
    [{ id: "u1", name: "X" }],
    { u1: { deadline: "2999-01-01" } },
    {},
  );
  assert.equal(journey.deadlineAction(far), null);
  // Soon but all required docs ready → nothing missing → no action.
  const soon = new Date();
  soon.setDate(soon.getDate() + 2);
  const iso = soon.toISOString().slice(0, 10);
  const ready = journey.buildApplications(
    [{ id: "u1", name: "X" }],
    { u1: { deadline: iso } },
    {
      transcript: true,
      passport: true,
      english_test: true,
    },
  );
  // personal_statement (unique) still required+missing → still fires; drop it:
  ready[0].missing_required = [];
  assert.equal(journey.deadlineAction(ready), null);
});

test("SELF_MILESTONE_KEYS excludes the auto stages (they are never client-settable)", () => {
  assert.ok(!journey.SELF_MILESTONE_KEYS.has("account_created"));
  assert.ok(!journey.SELF_MILESTONE_KEYS.has("profile_set"));
  assert.ok(!journey.SELF_MILESTONE_KEYS.has("shortlist_started"));
  // application_submitted is now derived from application status, not self.
  assert.ok(!journey.SELF_MILESTONE_KEYS.has("application_submitted"));
  assert.ok(journey.SELF_MILESTONE_KEYS.has("arrived"));
});

test("nextActions: complete profile hides the profile action; saved count drives the shortlist action", () => {
  const full = journey.profileCompleteness({
    fields_of_interest: ["CS"],
    degree_level: "Master",
    budget_max_eur_year: 5000,
    preferred_languages: ["English"],
    country_preference: ["Spain"],
    city_preference: "mid",
  });

  const oneSaved = journey.nextActions(1, full);
  assert.ok(
    !oneSaved.some((a) => a.key === "complete_profile"),
    "no profile action when 100%",
  );
  assert.equal(oneSaved[0].key, "save_more");

  const manySaved = journey.nextActions(5, full);
  assert.equal(manySaved[0].key, "compare");
  assert.match(manySaved[0].title, /5 saved/);
});

test("nextActions: the compare action points at the compare view, not the list", () => {
  const full = journey.profileCompleteness({
    fields_of_interest: ["CS"],
    degree_level: "Master",
    budget_max_eur_year: 5000,
    preferred_languages: ["English"],
    country_preference: ["Spain"],
    city_preference: "mid",
  });
  const a = journey.nextActions(5, full).find((x) => x.key === "compare");
  assert.ok(a, "a shortlist of 5 should offer comparing");
  assert.equal(
    a.href,
    "/compare",
    "sending them back to /saved was the old dead end",
  );
});
