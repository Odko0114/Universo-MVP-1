"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOverrides, validate } = require("../lib/overrides");

const SRC = "https://www.example-university.edu/admissions";
const NOW = () => new Date("2026-10-17T10:00:00Z");

const seedUnis = () => [
  {
    id: "eter-1",
    source: "eter",
    name: "Register University",
    country: "Romania",
    verified: true,
    tuition_range: {
      min: 2000,
      max: 6000,
      currency: "EUR",
      period: "year",
      estimated: true,
    },
    tuition_source: "country_estimate",
    language_of_instruction: ["Romanian"],
    language_estimated: true,
    application_deadline: "",
    last_verified_at: "2023-01-01",
  },
  {
    id: "cur-1",
    source: "curated",
    name: "Curated University",
    country: "Germany",
    verified: true,
    tuition_range: {
      min: 0,
      max: 6000,
      currency: "EUR",
      period: "year",
      note: "x",
    },
    tuition_source: "curated_research",
    application_deadline: "May 31",
    last_verified_at: "2026-07-16",
  },
];
const seedSch = () => [
  {
    key: "daad",
    name: "DAAD",
    application: {
      deadline: "2025-10-30",
      deadline_note: "old",
      portal: "https://old.example",
    },
    verification: {
      sources: ["https://daad.de"],
      date: "2026-01-10",
      status: "verified",
    },
  },
];

function make(doc = {}, unis = seedUnis(), schs = seedSch()) {
  let writes = 0;
  const ov = createOverrides({
    doc,
    universities: unis,
    scholarships: schs,
    persist: () => writes++,
    now: NOW,
  });
  return { ov, doc, unis, schs, writes: () => writes };
}

test("validate: a tuition figure without a source is rejected", () => {
  const r = validate("university", { tuition: { min: 12000 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /source/i);
});

test("validate: rejects non-numeric, out-of-range, inverted tuition", () => {
  assert.equal(
    validate("university", { tuition: { min: "abc", source: SRC } }).ok,
    false,
  );
  assert.equal(
    validate("university", { tuition: { min: 999999, source: SRC } }).ok,
    false,
  );
  assert.equal(
    validate("university", { tuition: { min: 9000, max: 1000, source: SRC } })
      .ok,
    false,
  );
  assert.equal(
    validate("university", { tuition: { min: 9000, source: "not a url" } }).ok,
    false,
  );
});

test("validate: accepts a sourced tuition; max defaults to min; commas allowed", () => {
  const r = validate("university", { tuition: { min: "12,000", source: SRC } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.tuition, { min: 12000, max: 12000, source: SRC });
});

test("validate: unknown field, empty patch and bad languages are rejected", () => {
  assert.equal(validate("university", { name: { value: "x" } }).ok, false);
  assert.equal(validate("university", {}).ok, false);
  assert.equal(
    validate("university", { languages: { value: ["<script>"], source: SRC } })
      .ok,
    false,
  );
  assert.equal(validate("nope", { a: 1 }).ok, false);
});

test("validate: scholarship deadline needs ISO date (or a note) and a source", () => {
  assert.equal(
    validate("scholarship", { deadline: { value: "15 Jan", source: SRC } }).ok,
    false,
  );
  assert.equal(
    validate("scholarship", { deadline: { value: "2027-01-15" } }).ok,
    false,
  );
  assert.equal(
    validate("scholarship", { deadline: { value: "2027-01-15", source: SRC } })
      .ok,
    true,
  );
  assert.equal(
    validate("scholarship", {
      deadline: { value: "", note: "Rolling", source: SRC },
    }).ok,
    true,
  );
});

test("save: a sourced tuition turns an estimate into a verified, student-visible figure", () => {
  const { ov, unis } = make();
  const r = ov.save(
    "university",
    "eter-1",
    { tuition: { min: 3000, max: 3000, source: SRC } },
    "odko",
  );
  assert.equal(r.ok, true);
  const u = unis[0];
  assert.equal(u.tuition_source, "curated_research"); // the gate every student-facing display checks
  assert.equal(u.tuition_range.min, 3000);
  assert.equal(u.tuition_range.estimated, undefined);
  assert.equal(u.tuition_intl_min, 3000);
  assert.equal(u.sources.tuition, SRC);
  assert.equal(r.record.fields.tuition.status, "edited");
  assert.equal(r.record.verified_at, "2026-10-17");
  assert.equal(r.record.verified_by, "odko");
});

test("save: an unsourced edit is refused and changes nothing", () => {
  const { ov, unis, writes } = make();
  const r = ov.save(
    "university",
    "eter-1",
    { deadline: { value: "1 March" } },
    "odko",
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(unis[0].application_deadline, "");
  assert.equal(writes(), 0);
});

test("save: unknown record is a 404", () => {
  const { ov } = make();
  assert.equal(
    ov.save(
      "university",
      "nope",
      { deadline: { value: "x", source: SRC } },
      "a",
    ).status,
    404,
  );
});

test("edits survive a restart: a fresh seed + the same persisted doc re-applies them", () => {
  const first = make();
  first.ov.save(
    "university",
    "eter-1",
    { deadline: { value: "1 March 2027", source: SRC } },
    "odko",
  );
  // "Restart": brand-new seed objects (the dataset is rebuilt every boot), same persisted doc.
  const second = make(JSON.parse(JSON.stringify(first.doc)));
  assert.equal(second.unis[0].application_deadline, ""); // seed is pristine…
  second.ov.applyAll();
  assert.equal(second.unis[0].application_deadline, "1 March 2027"); // …until the overlay is applied
  assert.equal(second.unis[0].sources.deadline, SRC);
});

test("revert restores exactly what the seed said", () => {
  const { ov, unis } = make();
  ov.save(
    "university",
    "eter-1",
    { tuition: { min: 3000, source: SRC } },
    "odko",
  );
  ov.save("university", "eter-1", { tuition: null }, "odko");
  assert.equal(unis[0].tuition_source, "country_estimate");
  assert.equal(unis[0].tuition_range.estimated, true);
  assert.equal(unis[0].tuition_range.min, 2000);
  assert.equal(
    ov.get("university", "eter-1").fields.tuition.status,
    "estimate",
  );
});

test("get: never pre-fills a country-level estimate (it is shown as a hint only)", () => {
  const { ov } = make();
  const f = ov.get("university", "eter-1").fields;
  assert.equal(f.tuition.min, null);
  assert.deepEqual(f.tuition.estimate, { min: 2000, max: 6000 });
  assert.equal(f.tuition.status, "estimate");
  assert.equal(f.languages.status, "estimate");
  assert.deepEqual(f.languages.value, []);
});

test("verifiedAt: register records are 'never'; curated keep their research date", () => {
  const { ov } = make();
  assert.equal(ov.verifiedAt("university", "eter-1"), "");
  assert.equal(ov.verifiedAt("university", "cur-1"), "2026-07-16");
  assert.equal(ov.verifiedAt("scholarship", "daad"), "2026-01-10");
});

test("verify stamps the date and is logged", () => {
  const { ov, doc } = make();
  const r = ov.verify("university", "eter-1", "odko");
  assert.equal(r.ok, true);
  assert.equal(r.record.verified_at, "2026-10-17");
  assert.equal(doc.log[0].action, "verify");
  assert.equal(doc.log[0].name, "Register University");
});

test("scholarship deadline edit applies, adds the source to verification, and stamps it", () => {
  const { ov, schs } = make();
  const r = ov.save(
    "scholarship",
    "daad",
    { deadline: { value: "2026-10-31", note: "Round 2", source: SRC } },
    "odko",
  );
  assert.equal(r.ok, true);
  assert.equal(schs[0].application.deadline, "2026-10-31");
  assert.equal(schs[0].application.deadline_note, "Round 2");
  assert.equal(schs[0].application.portal, "https://old.example"); // untouched fields stay
  assert.ok(schs[0].verification.sources.includes(SRC));
  assert.ok(schs[0].verification.sources.includes("https://daad.de"));
  assert.equal(schs[0].verification.date, "2026-10-17");
});

test("log: newest first, capped, and reports what changed", () => {
  const { ov } = make();
  ov.save(
    "university",
    "eter-1",
    { deadline: { value: "A", source: SRC } },
    "odko",
  );
  ov.save(
    "university",
    "cur-1",
    { tuition: { min: 100, source: SRC } },
    "odko",
  );
  const log = ov.recentLog(5);
  assert.equal(log[0].id, "cur-1");
  assert.deepEqual(log[0].fields, ["tuition"]);
  assert.equal(log[1].id, "eter-1");
});
