"use strict";

// Isolate the test run from the real ./data directory.
//
// Every test file does `require("../server")`, which boots lib/store + lib/events
// against DATA_DIR = UNIVERSO_DATA_DIR || ./data. Without this, tests that
// register a student, submit a pilot lead, record an event, etc. WRITE INTO the
// real data files — which is exactly how data/pilot_leads.json accumulated 127
// "Test University" leads over a month of test runs.
//
// Preloaded via `node --test --require ./scripts/test-setup.js`, so it runs
// before any test file loads the server. It lives in scripts/ (not test/) so
// the test runner doesn't pick it up as a test file. Universities load from
// data/seed (a fixed path), so the dataset is still available in the temp dir.
//
// Guarded so config.test.js (which sets UNIVERSO_DATA_DIR explicitly for the
// child processes it spawns) is never overridden.

const os = require("os");
const fs = require("fs");
const path = require("path");

// Lift the auth/login rate caps for the suite: every test registers/logs in
// from the same loopback IP within one 15-min window, which otherwise trips the
// production defaults (20 / 10). Tests that assert 429 use isolated IPs on other
// routes, so this doesn't weaken them.
if (!process.env.UNIVERSO_AUTH_RATE_MAX)
  process.env.UNIVERSO_AUTH_RATE_MAX = "100000";
if (!process.env.UNIVERSO_LOGIN_RATE_MAX)
  process.env.UNIVERSO_LOGIN_RATE_MAX = "100000";

if (!process.env.UNIVERSO_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "universo-test-"));
  process.env.UNIVERSO_DATA_DIR = dir;
  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
}
