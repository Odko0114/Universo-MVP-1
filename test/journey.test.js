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
    statusCounts: { considering: 1, applied: 1 },
    docsDone: 3,
    scholarshipRequired: false,
    scholarshipsResearched: false,
  });
  const by = Object.fromEntries(dims.map((d) => [d.key, d.score]));
  assert.equal(by.profile, 50);
  assert.equal(
    by.application,
    75,
    "an applied status lifts application readiness",
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
    statusCounts: { considering: 1 },
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
    statusCounts: { offer: 1 },
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

test("statusCounts: unset saved unis count as the default (considering)", () => {
  const counts = journey.statusCounts({ a: "applied", b: "offer" }, [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.equal(counts.applied, 1);
  assert.equal(counts.offer, 1);
  assert.equal(
    counts.considering,
    2,
    "c and d have no explicit status → considering",
  );
});

test("statusCounts: empty saved list yields no counts", () => {
  assert.deepEqual(journey.statusCounts({}, []), {});
});

test("APPLICATION_STATUS_KEYS holds exactly the five valid statuses", () => {
  assert.equal(journey.APPLICATION_STATUS_KEYS.size, 5);
  assert.ok(journey.APPLICATION_STATUS_KEYS.has("considering"));
  assert.ok(journey.APPLICATION_STATUS_KEYS.has("offer"));
  assert.ok(!journey.APPLICATION_STATUS_KEYS.has("enrolled"));
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
