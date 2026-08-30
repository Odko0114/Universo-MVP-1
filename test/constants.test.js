"use strict";

// Guards the single-source-of-truth invariant (audit item 17): several enums are
// defined canonically in lib/ and MIRRORED as display arrays in the browser
// bundle (which can't import from lib/). These tests fail the build if the mirror
// drifts from its source, so the "// mirrors …" comments can't silently rot.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const journey = require("../lib/journey");
const notify = require("../lib/notify");

const APP_JS = fs.readFileSync(
  path.join(__dirname, "..", "public", "js", "app.js"),
  "utf8",
);

// First quoted string of each `["key", …]` row inside `const NAME = [ … ];`.
function mirrorKeys(name) {
  const block = APP_JS.match(
    new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`),
  );
  assert.ok(block, `${name} not found in app.js`);
  return [...block[1].matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1]);
}

test("app.js APP_STATUSES mirrors journey.APPLICATION_STATUSES", () => {
  assert.deepEqual(
    mirrorKeys("APP_STATUSES"),
    journey.APPLICATION_STATUSES.map((s) => s.key),
  );
});

test("app.js LEVELS mirrors journey.LEVELS", () => {
  assert.deepEqual(mirrorKeys("LEVELS"), journey.LEVELS);
});

test("app.js SCHOLARSHIP_STATUSES mirrors journey.SCHOLARSHIP_STATUSES", () => {
  assert.deepEqual(
    mirrorKeys("SCHOLARSHIP_STATUSES"),
    journey.SCHOLARSHIP_STATUSES.map((s) => s.key),
  );
});

test("app.js NOTIF_LABELS mirrors notify.NOTIFICATION_CATEGORIES", () => {
  assert.deepEqual(mirrorKeys("NOTIF_LABELS"), notify.NOTIFICATION_CATEGORIES);
});
