"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOverrides } = require("../lib/overrides");
const {
  buildSheet,
  planImport,
  parseMoneyCell,
  parseDateCell,
} = require("../lib/csv-import");
const { parseCsv } = require("../lib/csv");

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
    tuition_range: { min: 0, max: 6000, currency: "EUR", period: "year" },
    tuition_source: "curated_research",
    language_of_instruction: ["English", "German"],
    application_deadline: "May 31",
    last_verified_at: "2026-07-16",
  },
  {
    id: "eter-2",
    source: "eter",
    name: "Second Register University",
    country: "Finland",
    verified: true,
    tuition_range: {
      min: 1000,
      max: 3000,
      currency: "EUR",
      period: "year",
      estimated: true,
    },
    tuition_source: "country_estimate",
    language_of_instruction: ["Finnish"],
    language_estimated: true,
    application_deadline: "",
  },
];
const seedSch = () => [
  {
    key: "daad",
    name: "DAAD",
    country: "Germany",
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
function make() {
  const unis = seedUnis(),
    schs = seedSch();
  const doc = {};
  let writes = 0;
  const ov = createOverrides({
    doc,
    universities: unis,
    scholarships: schs,
    persist: () => writes++,
    now: NOW,
  });
  return { ov, unis, schs, doc, writes: () => writes };
}
const HEAD =
  "type,id,name,country,tuition_min,tuition_max,tuition_source,deadline,deadline_source,requirements,requirements_source,languages,languages_source,application_link";
const plan = (csv, ov) => planImport(csv, ov);

// ---- strict cell parsers ---------------------------------------------------

test("money: whole euros only, European thousands understood, guesses refused", () => {
  assert.equal(parseMoneyCell("12000"), 12000);
  assert.equal(parseMoneyCell("12 000"), 12000);
  assert.equal(parseMoneyCell("12 000"), 12000); // non-breaking space (Excel)
  assert.equal(parseMoneyCell("12,000"), 12000);
  assert.equal(parseMoneyCell("12.000"), 12000); // Finnish/European thousands — NOT twelve euros
  assert.equal(parseMoneyCell("€1.200.000"), 1200000);
  assert.equal(parseMoneyCell("0"), 0);
  assert.equal(parseMoneyCell(""), null);
  for (const bad of ["12k", "free", "12000.50", "12,5", "1,2,3", "abc", "-5"])
    assert.equal(parseMoneyCell(bad), undefined, bad);
});

test("dates: ISO and 15.1.2027 are read; slashes are refused, never guessed", () => {
  assert.equal(parseDateCell("2027-01-15"), "2027-01-15");
  assert.equal(parseDateCell("15.1.2027"), "2027-01-15");
  assert.equal(parseDateCell("05.03.2027"), "2027-03-05");
  assert.equal(parseDateCell(""), null);
  for (const bad of [
    "3/4/2027",
    "15/01/2027",
    "2027-02-31",
    "31.2.2027",
    "Jan 15",
    "2027",
  ])
    assert.equal(parseDateCell(bad), undefined, bad);
});

// ---- export ----------------------------------------------------------------

test("export pre-fills only CONFIRMED values; estimates stay blank", () => {
  const { ov } = make();
  const csv = buildSheet(
    "university",
    [{ id: "eter-1" }, { id: "cur-1" }],
    ov,
    { delimiter: "," },
  );
  const rows = parseCsv(csv).records.map((r) => r.cells);
  const h = rows[0],
    col = (r, n) => r[h.indexOf(n)];
  assert.equal(csv.charCodeAt(0), 0xfeff, "BOM so Excel reads accents");
  assert.equal(col(rows[1], "id"), "eter-1");
  assert.equal(
    col(rows[1], "tuition_min"),
    "",
    "a country-level estimate is never pre-filled",
  );
  assert.equal(
    col(rows[1], "languages"),
    "",
    "an estimated language list is never pre-filled",
  );
  assert.equal(col(rows[2], "tuition_min"), "0");
  assert.equal(col(rows[2], "tuition_max"), "6000");
  assert.equal(col(rows[2], "deadline"), "May 31");
  assert.equal(col(rows[2], "languages"), "English; German");
});

test("export uses the delimiter asked for (semicolon for Finnish Excel)", () => {
  const { ov } = make();
  const csv = buildSheet("university", [{ id: "cur-1" }], ov, {
    delimiter: ";",
  });
  assert.equal(parseCsv(csv).delimiter, ";");
});

// ---- import: the happy path ------------------------------------------------

test("a filled-in row becomes an update with a readable summary of what changes", () => {
  const { ov } = make();
  const p = plan(
    `${HEAD}\nuniversity,eter-1,x,x,"1,200",,${SRC},31 January 2027,${SRC},,,,,\n`,
    ov,
  );
  assert.equal(p.ok, true);
  assert.deepEqual(p.summary, { update: 1, unchanged: 0, empty: 0, error: 0 });
  assert.deepEqual(p.rows[0].changes, [
    "tuition €1,200",
    "deadline “31 January 2027”",
  ]);
  assert.deepEqual(p.items[0], {
    type: "university",
    id: "eter-1",
    patch: {
      tuition: { min: 1200, max: 1200, source: SRC },
      deadline: { value: "31 January 2027", source: SRC },
    },
  });
  assert.equal(
    p.rows[0].name,
    "x",
    "the row's own name column is echoed so a misaligned sheet is visible",
  );
});

test("a SEMICOLON file with European numbers is read correctly (Finnish Excel)", () => {
  const { ov } = make();
  const csv = `type;id;name;country;tuition_min;tuition_max;tuition_source;deadline;deadline_source\nuniversity;eter-1;;;12.000;15.000;${SRC};1.3.2027;${SRC}\n`;
  const p = plan(csv, ov);
  assert.equal(p.delimiter, ";");
  assert.equal(p.rows[0].errors.length, 0);
  assert.equal(
    p.items[0].patch.tuition.min,
    12000,
    "12.000 is twelve THOUSAND",
  );
  assert.equal(p.items[0].patch.tuition.max, 15000);
});

test("export → import untouched is silent: unchanged / empty, never errors", () => {
  const { ov } = make();
  const csv = buildSheet(
    "university",
    [{ id: "eter-1" }, { id: "cur-1" }, { id: "eter-2" }],
    ov,
    { delimiter: ";" },
  );
  const p = plan(csv, ov);
  assert.equal(p.summary.error, 0, JSON.stringify(p.rows));
  assert.equal(p.summary.update, 0);
  // cur-1 is hand-researched with no source link on file: untouched must not demand one.
  assert.equal(p.rows.find((r) => r.id === "cur-1").status, "unchanged");
  assert.equal(p.rows.find((r) => r.id === "eter-1").status, "empty");
});

test("only the cells that changed are part of the update", () => {
  const { ov } = make();
  const csv = buildSheet("university", [{ id: "cur-1" }], ov, {
    delimiter: ",",
  }).replace("May 31", "June 15");
  const p = plan(csv, ov);
  assert.equal(
    p.summary.error,
    1,
    "changed deadline but no source link → refused",
  );
  const ok = plan(csv.replace("June 15,", `June 15,${SRC}`), ov);
  assert.deepEqual(
    Object.keys(ok.items[0].patch),
    ["deadline"],
    "tuition and languages untouched",
  );
});

// ---- import: refusals ------------------------------------------------------

test("the honesty rule holds in bulk: a number or date without a source is an error", () => {
  const { ov } = make();
  const p = plan(`${HEAD}\nuniversity,eter-1,,,5000,,,,,,,,,\n`, ov);
  assert.equal(p.rows[0].status, "error");
  assert.match(p.rows[0].errors[0], /source/i);
  assert.equal(p.items.length, 0);
});

test("clear, specific errors: unknown id, duplicate id, missing id, wrong kind", () => {
  const { ov } = make();
  const p = plan(
    `${HEAD}\nuniversity,nope,,,,,,,,,,,,\nuniversity,eter-1,,,1,,${SRC},,,,,,,\nuniversity,eter-1,,,2,,${SRC},,,,,,,\nuniversity,,,,,,,,,,,,,x\nscholarship,eter-2,,,,,,,,,,,,\n`,
    ov,
  );
  const by = (line) => p.rows.find((r) => r.line === line);
  assert.match(by(2).errors[0], /Unknown university id/);
  assert.equal(by(3).status, "update");
  assert.match(by(4).errors[0], /also appears on line 3/);
  assert.match(by(5).errors[0], /No id/);
  assert.match(by(6).errors[0], /scholarship/);
});

test("number problems say what to do, and decimals / words are refused", () => {
  const { ov } = make();
  for (const bad of ["12k", "free", "12000.50", "12,5"]) {
    const p = plan(
      `${HEAD}\nuniversity,eter-1,,,\"${bad}\",,${SRC},,,,,,,\n`,
      ov,
    );
    assert.equal(p.rows[0].status, "error", bad);
    assert.match(p.rows[0].errors[0], /whole number of euros/);
  }
});

test("half-filled groups are caught: source without value, max without min", () => {
  const { ov } = make();
  assert.match(
    plan(`${HEAD}\nuniversity,eter-1,,,,,${SRC},,,,,,,\n`, ov).rows[0]
      .errors[0],
    /no tuition figure/,
  );
  assert.match(
    plan(`${HEAD}\nuniversity,eter-1,,,,5000,${SRC},,,,,,,\n`, ov).rows[0]
      .errors[0],
    /tuition_min is empty/,
  );
  assert.match(
    plan(`${HEAD}\nuniversity,eter-1,,,,,,,${SRC},,,,,\n`, ov).rows[0]
      .errors[0],
    /deadline_source is filled in but deadline is empty/,
  );
});

test("file-level problems are reported plainly", () => {
  const { ov } = make();
  assert.equal(plan("", ov).ok, false);
  assert.match(plan("name,country\nA,B\n", ov).error, /“id”/);
  assert.match(
    plan(`id,deadline_date,tuition_min\nx,2027-01-01,5\n`, ov).error,
    /mixes/,
  );
  assert.match(
    plan('id,deadline\nu1,"never closed\n', ov).error,
    /never closed/,
  );
});

test("unknown columns are ignored with a warning, not an error", () => {
  const { ov } = make();
  const p = plan(
    `${HEAD},my_notes\nuniversity,eter-1,,,5,,${SRC},,,,,,,,remember to call\n`,
    ov,
  );
  assert.equal(p.ok, true);
  assert.match(p.warnings[0], /my_notes/);
  assert.equal(p.summary.update, 1);
});

// ---- scholarships ----------------------------------------------------------

test("scholarship sheet: dates validated, Finnish dates converted, portal link", () => {
  const { ov } = make();
  const SH =
    "type,id,name,country,deadline_date,deadline_note,deadline_source,portal";
  const good = plan(
    `${SH}\nscholarship,daad,,,15.1.2027,Round 2,${SRC},https://new.example\n`,
    ov,
  );
  assert.equal(good.kind, "scholarship");
  assert.deepEqual(good.items[0].patch.deadline, {
    value: "2027-01-15",
    note: "Round 2",
    source: SRC,
  });
  assert.equal(good.items[0].patch.portal.value, "https://new.example");
  const slash = plan(`${SH}\nscholarship,daad,,,3/4/2027,,${SRC},\n`, ov);
  assert.match(slash.rows[0].errors[0], /Use 2027-01-15 or 15.1.2027/);
  const noSrc = plan(`${SH}\nscholarship,daad,,,2027-01-15,,,\n`, ov);
  assert.equal(noSrc.rows[0].status, "error");
});

// ---- apply (saveMany) ------------------------------------------------------

test("applying a plan changes the records, with ONE write and ONE log entry", () => {
  const { ov, unis, writes, doc } = make();
  const csv = `${HEAD}\nuniversity,eter-1,,,3000,,${SRC},1 March 2027,${SRC},,,,,\nuniversity,eter-2,,,2000,2500,${SRC},,,,,,,\n`;
  const p = plan(csv, ov);
  assert.equal(p.summary.update, 2);
  const r = ov.saveMany(p.items, "odko");
  assert.deepEqual(
    { applied: r.applied, failed: r.failed.length },
    { applied: 2, failed: 0 },
  );
  assert.equal(unis[0].tuition_source, "curated_research");
  assert.equal(unis[0].application_deadline, "1 March 2027");
  assert.equal(unis[2].tuition_range.max, 2500);
  assert.equal(writes(), 1, "one disk write for the whole batch");
  assert.equal(doc.log.length, 1);
  assert.equal(doc.log[0].action, "import");
  assert.match(doc.log[0].name, /2 records/);
  assert.equal(ov.get("university", "eter-1").verified_at, "2026-10-17");
});

test("saveMany never trusts a plan: tampered items are rejected and reported", () => {
  const { ov, unis, writes } = make();
  const r = ov.saveMany(
    [
      { type: "university", id: "eter-1", patch: { tuition: { min: 5000 } } }, // no source
      {
        type: "university",
        id: "ghost",
        patch: { deadline: { value: "x", source: SRC } },
      },
      {
        type: "university",
        id: "eter-2",
        patch: { deadline: { value: "ok", source: SRC } },
      },
    ],
    "odko",
  );
  assert.equal(r.applied, 1);
  assert.equal(r.failed.length, 2);
  assert.equal(
    unis[0].tuition_source,
    "country_estimate",
    "the unsourced edit was not applied",
  );
  assert.equal(unis[2].application_deadline, "ok");
  assert.equal(writes(), 1);
});

test("a plan with nothing to apply writes nothing", () => {
  const { ov, writes } = make();
  assert.deepEqual(ov.saveMany([], "odko"), {
    ok: true,
    applied: 0,
    failed: [],
  });
  assert.equal(writes(), 0);
});
