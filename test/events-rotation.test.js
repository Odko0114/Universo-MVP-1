"use strict";

// NOTE: these tests back up/restore the REAL data/events.jsonl (lib/events.js
// has no injectable file path). api.test.js starts the real server, which
// writes to that same file on requests like registration. Node's test runner
// runs separate files concurrently by default, so running this file at the
// same time as api.test.js is a genuine race (whichever finishes last wins,
// clobbering the other's backup/restore). `npm test` pins concurrency to 1
// specifically because of this — don't re-parallelize without giving these
// tests an isolated file path first.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const events = require("../lib/events");

test("shouldRotate is a pure size comparison", () => {
  assert.equal(events.shouldRotate(1000, 5000), false);
  assert.equal(events.shouldRotate(5000, 5000), true);
  assert.equal(events.shouldRotate(6000, 5000), true);
});

test("shouldRotate defaults to the module ROTATE_AT_BYTES threshold", () => {
  assert.equal(events.shouldRotate(events.ROTATE_AT_BYTES - 1), false);
  assert.equal(events.shouldRotate(events.ROTATE_AT_BYTES), true);
});

// Real-file integration check: back up whatever is already there (if
// anything), force a rotation with a temporarily lowered threshold via a
// tiny file, and restore the original afterward so this test never touches
// real event history.
test("rotateIfLarge archives an oversized file and leaves a clean live file", async () => {
  const original = fs.existsSync(events.FILE)
    ? fs.readFileSync(events.FILE)
    : null;
  const before = fs.readdirSync(require("node:path").dirname(events.FILE));

  try {
    fs.writeFileSync(events.FILE, "x".repeat(events.ROTATE_AT_BYTES + 1));
    const rotated = await events.rotateIfLarge();
    assert.equal(rotated, true);
    assert.equal(
      fs.existsSync(events.FILE),
      false,
      "live file should have been renamed away",
    );

    const after = fs.readdirSync(require("node:path").dirname(events.FILE));
    const newFiles = after.filter((f) => !before.includes(f));
    assert.equal(
      newFiles.length,
      1,
      "exactly one archive file should have appeared",
    );
    assert.match(
      newFiles[0],
      /events-archive-\d{4}-\d{2}-\d{2}(-\d+)?\.jsonl$/,
    );

    // Clean up the archive this test created.
    fs.unlinkSync(
      require("node:path").join(
        require("node:path").dirname(events.FILE),
        newFiles[0],
      ),
    );
  } finally {
    // Restore exactly what was there before, whether or not the test passed.
    if (original !== null) fs.writeFileSync(events.FILE, original);
    else if (fs.existsSync(events.FILE)) fs.unlinkSync(events.FILE);
  }
});

test("rotateIfLarge is a no-op when the file is under the threshold", async () => {
  const original = fs.existsSync(events.FILE)
    ? fs.readFileSync(events.FILE)
    : null;
  try {
    fs.writeFileSync(
      events.FILE,
      '{"ts":"2026-01-01T00:00:00.000Z","type":"pageview"}\n',
    );
    const rotated = await events.rotateIfLarge();
    assert.equal(rotated, false);
    assert.equal(fs.existsSync(events.FILE), true);
  } finally {
    if (original !== null) fs.writeFileSync(events.FILE, original);
    else if (fs.existsSync(events.FILE)) fs.unlinkSync(events.FILE);
  }
});
