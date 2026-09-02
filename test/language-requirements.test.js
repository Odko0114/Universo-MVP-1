"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const lang = require("../lib/language-requirements");
const app = require("../server");

// ---- Loader / resolver (pure) ---------------------------------------------

test("every seeded record is verified and carries a source URL (honesty)", () => {
  const all = lang.all();
  assert.ok(all.length > 0, "expected at least one seeded requirement");
  for (const r of all) {
    assert.equal(
      r.verification && r.verification.status,
      "verified",
      `${r.university_id}: only verified records belong in this file`,
    );
    assert.ok(r.source_url && /^https:\/\//.test(r.source_url), `${r.university_id}: needs an official https source`);
    assert.ok(Array.isArray(r.tests) && r.tests.length > 0, `${r.university_id}: needs at least one test`);
    for (const t of r.tests)
      assert.ok(t.test && t.min_score, `${r.university_id}: each test needs a name and a min score`);
  }
});

test("a seeded university resolves to a verified view with multiple tests", () => {
  const v = lang.viewForUniversity("eter-se0008"); // KTH — national English 6
  assert.equal(v.state, "verified");
  assert.ok(v.tests.length >= 2, "supports multiple accepted tests");
  assert.match(v.tests.map((t) => t.test).join(","), /IELTS/);
  assert.ok(v.source_url);
});

test("an unseeded university resolves to 'none' — never invented", () => {
  assert.equal(lang.viewForUniversity("tum").state, "none");
  assert.equal(lang.viewForUniversity("__does_not_exist__").state, "none");
  assert.equal(lang.hasRequirement("tum"), false);
});

test("resolveView: university-wide record wins, counting programme overrides", () => {
  const v = lang.resolveView([
    { scope: "university", tests: [{ test: "IELTS", min_score: "6.5" }], source_url: "https://x" },
    { program: "MSc CS", tests: [{ test: "IELTS", min_score: "7.0" }], source_url: "https://y" },
  ]);
  assert.equal(v.state, "verified");
  assert.equal(v.other_programs, 1);
});

test("resolveView: only programme-specific records → 'varies'", () => {
  const v = lang.resolveView([
    { program: "MSc CS", source_url: "https://a" },
    { program: "MA History", source_url: "https://b" },
  ]);
  assert.equal(v.state, "varies");
  assert.equal(v.programs.length, 2);
});

test("resolveView: a single programme record still resolves verified", () => {
  const v = lang.resolveView([
    { program: "MSc CS", tests: [{ test: "IELTS", min_score: "7.0" }], source_url: "https://a" },
  ]);
  assert.equal(v.state, "verified");
  assert.equal(v.program, "MSc CS");
});

// ---- Server integration ----------------------------------------------------

let server, base;
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test("GET /api/universities/:id attaches a verified language view for a seeded uni", async () => {
  const res = await fetch(`${base}/api/universities/eter-se0008`);
  const { university } = await res.json();
  assert.equal(university.language_requirements.state, "verified");
  assert.ok(university.language_requirements.source_url);
});

test("GET /api/universities/:id reports 'none' honestly for an unseeded uni", async () => {
  const res = await fetch(`${base}/api/universities/tum`);
  const { university } = await res.json();
  assert.equal(university.language_requirements.state, "none");
});

test("SSR: verified language leads the merged Entry requirements section", async () => {
  const res = await fetch(`${base}/university/eter-se0008`);
  const html = await res.text();
  assert.match(html, /Entry requirements/);
  assert.match(html, /Language:/);
  assert.match(html, /View official requirement/);
  assert.match(html, /IELTS/);
});

test("SSR: an unseeded uni shows Entry requirements from its own text, no verified language line (option a)", async () => {
  const res = await fetch(`${base}/university/tum`);
  const html = await res.text();
  // tum has free-text acceptance_requirements but no verified language record.
  assert.match(html, /Entry requirements/);
  assert.doesNotMatch(html, /View official requirement/); // no verified language block
});
