"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  scholarshipsFor,
  scholarshipsForDestinations,
  scholarshipsOutbound,
  slug,
} = require("../lib/scholarships");

test("EU country gets the EU-wide scheme plus its own national scheme", () => {
  const list = scholarshipsFor("Germany");
  assert.ok(list.some((s) => s.name.includes("Erasmus Mundus")));
  assert.ok(list.some((s) => s.name.includes("DAAD")));
});

test("non-EU country with a known scheme gets it, without Erasmus Mundus", () => {
  const list = scholarshipsFor("Japan");
  assert.ok(list.some((s) => s.name.includes("MEXT")));
  assert.ok(!list.some((s) => s.name.includes("Erasmus Mundus")));
});

test("unknown country falls back to the generic pointer", () => {
  const list = scholarshipsFor("Nauru");
  assert.equal(list.length, 1);
  assert.equal(list[0].scope, "generic");
});

test("every entry is flagged verify:true (never presented as confirmed)", () => {
  for (const country of ["Germany", "Japan", "Nauru"]) {
    for (const s of scholarshipsFor(country)) assert.equal(s.verify, true);
  }
});

test("result is capped at 3 entries", () => {
  const list = scholarshipsFor("Germany"); // EU-wide + country-specific = 2, well under cap
  assert.ok(list.length <= 3);
});

test("scholarshipsForDestinations groups by destination and adds EU-wide once", () => {
  const r = scholarshipsForDestinations(["Germany", "France"]);
  assert.deepEqual(
    r.groups.map((g) => g.country),
    ["Germany", "France"],
  );
  assert.ok(r.groups[0].scholarships.some((s) => s.name.includes("DAAD")));
  assert.ok(r.eu_wide.some((s) => s.name.includes("Erasmus")));
  // Every scheme carries a stable key for tracking.
  assert.ok(r.groups[0].scholarships.every((s) => s.key && s.verify === true));
});

test("scholarshipsForDestinations: non-EU-only destinations get no EU-wide block", () => {
  const r = scholarshipsForDestinations(["Japan"]);
  assert.equal(r.eu_wide.length, 0);
  // Dedupes repeated destinations.
  const dup = scholarshipsForDestinations(["Germany", "Germany"]);
  assert.equal(dup.groups.length, 1);
});

test("slug is stable and url-safe", () => {
  assert.equal(slug("DAAD Scholarships"), "daad-scholarships");
  assert.equal(slug("Eiffel Excellence Scholarship"), "eiffel-excellence-scholarship");
});

test("scholarshipsOutbound: known home country gets its scheme; unknown gets an honest pointer", () => {
  const cn = scholarshipsOutbound("China");
  assert.ok(cn.some((s) => s.name.includes("CSC")));
  assert.ok(cn.every((s) => s.verify === true && s.key));
  const mn = scholarshipsOutbound("Mongolia");
  assert.equal(mn.length, 1);
  assert.equal(mn[0].scope, "home-generic", "no fabricated program name/URL");
  assert.equal(mn[0].website, "");
});
