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

test("buildTimeline: self-reported milestones mark their stage done", () => {
  const t = journey.buildTimeline(true, 1, [
    "scholarships_researched",
    "application_started",
  ]);
  assert.equal(
    t.stages.find((s) => s.key === "scholarships_researched").done,
    true,
  );
  assert.equal(
    t.stages.find((s) => s.key === "application_started").done,
    true,
  );
  assert.equal(t.next_key, "application_submitted");
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
    scholarshipsResearched: true,
  });
  assert.ok(withReq.some((d) => d.key === "scholarship" && d.score === 100));
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

test("applicationView: required_done counts required only; shared reads vault, unique reads app", () => {
  const uni = { id: "u1", name: "Helsinki" };
  // Vault: transcript + passport ready (shared). Motivation letter (unique) not.
  const vault = { transcript: true, passport: true };
  const app = {
    status: "preparing",
    req: { english_test: "not_required" }, // drop english from required
    docs: {}, // personal_statement (unique) not ready
  };
  const v = journey.applicationView(app, uni, vault);
  // Defaults required: transcript, english_test, passport, personal_statement.
  // english_test overridden to not_required → required set = transcript, passport, personal_statement.
  assert.equal(v.required_total, 3);
  assert.equal(v.required_done, 2, "transcript + passport ready from vault");
  assert.deepEqual(v.missing_required, ["Motivation letter"]);
  const cv = v.docs.find((d) => d.key === "cv");
  assert.equal(cv.shared, true);
  assert.equal(cv.level, "recommended", "cv default level");
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
  // Shared required docs live in the vault; the unique motivation letter is
  // tracked per application, so a "complete" app needs it in its own docs map.
  const vault = { transcript: true, passport: true, english_test: true };
  const letterDone = { personal_statement: true };
  const apps = {
    u1: { deadline: "2999-12-31", docs: { ...letterDone } },
    u2: { deadline: "2999-01-01", docs: { ...letterDone } },
  };
  const views = journey.buildApplications(unis, apps, { ...vault });
  const ov = journey.applicationsOverview(views);
  assert.equal(ov.total, 3, "every saved uni is an application");
  assert.equal(ov.ready, 2, "u1 and u2 have every required doc ready");
  assert.equal(ov.in_progress, 1, "u3 has the shared docs but not its letter");
  assert.equal(ov.upcoming_deadlines.length, 2, "only the two with a deadline");
  assert.equal(ov.upcoming_deadlines[0].name, "Aalto", "earliest deadline first");
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
  assert.ok(journey.SELF_MILESTONE_KEYS.has("application_submitted"));
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
