"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeSources,
  hostKey,
  cleanName,
  describeEter,
  dedupeByNameCountry,
} = require("../lib/dataset");

test("buildDataset fills gaps with real data only (website, approx coords, language)", () => {
  const { buildDataset } = require("../lib/dataset");
  const list = buildDataset();

  const tum = list.find((u) => u.id === "tum");
  assert.ok(tum, "curated TUM record present");
  assert.equal(
    tum.website,
    "https://www.tum.de",
    "website derived from the application_link origin",
  );
  assert.ok(
    tum.coords && tum.coords.lat != null && tum.coords.approx === true,
    "city-level coords filled from the geocoded override and marked approx",
  );

  // Language now covered for previously-blank EU countries (flagged estimate).
  const bg = list.find((u) => u.country === "Bulgaria");
  assert.ok(
    bg &&
      bg.language_of_instruction &&
      bg.language_of_instruction.length &&
      bg.language_estimated === true,
    "Bulgaria language filled and flagged as an estimate",
  );

  // Never attach coordinates to a junk city value (some records carry "m").
  const junk = list.filter(
    (u) => u.city === "m" && u.coords && u.coords.lat != null,
  );
  assert.equal(junk.length, 0, "junk city 'm' never receives coordinates");
});

test("dedupeByNameCountry keeps the highest-priority source and maps dropped slugs", () => {
  const rows = [
    {
      id: "aarhus",
      source: "curated",
      name: "Aarhus University",
      country: "Denmark",
    },
    {
      id: "g-au-dk",
      source: "global",
      name: "Aarhus University",
      country: "Denmark",
    },
    {
      id: "eter-x",
      source: "eter",
      name: "Twin University",
      country: "France",
    },
    {
      id: "g-twin",
      source: "global",
      name: "Twin  University",
      country: "France",
    }, // extra space normalizes equal
    {
      id: "solo",
      source: "global",
      name: "Aarhus University",
      country: "Germany",
    }, // same name, other country — kept
  ];
  const { kept, redirects } = dedupeByNameCountry(rows);
  assert.deepEqual(kept.map((u) => u.id).sort(), ["aarhus", "eter-x", "solo"]);
  assert.deepEqual(redirects, { "g-au-dk": "aarhus", "g-twin": "eter-x" });
});

test("cleanName strips registry quote artifacts", () => {
  assert.equal(
    cleanName('"Agora" University of Oradea'),
    "Agora University of Oradea",
  );
  assert.equal(cleanName("“Aldent” University"), "Aldent University");
  assert.equal(cleanName("Plain University"), "Plain University");
});

test("describeEter builds a human sentence from register fields", () => {
  const s = describeEter({
    legal_status: "Public",
    institution_type: "University",
    city: "Oradea",
    country: "Romania",
    founded: 2012,
    student_count: 775,
  });
  assert.equal(
    s,
    "A public university in Oradea, Romania, established 2012. Home to around 775 students.",
  );
});

test("describeEter degrades gracefully with sparse fields", () => {
  const s = describeEter({
    institution_type: "Other institution",
    city: "Tirana",
    country: "Albania",
  });
  assert.match(s, /higher-education institution in Tirana, Albania\./);
});

test("hostKey normalizes protocol and www", () => {
  assert.equal(hostKey({ website: "https://www.TUM.de/en/apply" }), "tum.de");
  assert.equal(hostKey({ domain: "harvard.edu" }), "harvard.edu");
  assert.equal(hostKey({}), "");
});

test("higher-priority source wins on a domain clash", () => {
  const curated = [
    {
      id: "cur",
      source: "curated",
      application_link: "https://www.tum.de/apply",
    },
  ];
  const eter = [{ id: "eter", source: "eter", domain: "tum.de" }];
  const global = [{ id: "glob", source: "global", domain: "tum.de" }];
  const merged = mergeSources([curated, eter, global]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "cur"); // curated kept, eter+global dropped
});

test("distinct institutions sharing a domain are NOT deduped within a source", () => {
  // Real ETER case: a faculty and its parent university share one host.
  const eter = [
    { id: "parent", source: "eter", domain: "uni-trier.de" },
    { id: "faculty", source: "eter", domain: "uni-trier.de" },
  ];
  const merged = mergeSources([[], eter, []]);
  assert.equal(merged.length, 2); // both kept
});

test("records without a host are always kept (no false dedup)", () => {
  const eter = [
    { id: "x", source: "eter", domain: "" },
    { id: "y", source: "eter", domain: "" },
  ];
  const merged = mergeSources([[], eter, []]);
  assert.equal(merged.length, 2);
});

test("global records survive when not overlapping Europe", () => {
  const eter = [{ id: "e", source: "eter", domain: "tum.de" }];
  const global = [{ id: "g", source: "global", domain: "harvard.edu" }];
  const merged = mergeSources([[], eter, global]);
  assert.equal(merged.length, 2);
});
