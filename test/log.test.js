"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const log = require("../lib/log");

// Captures what a stream's .write() was called with, without actually
// printing to the real stdout/stderr during the test run.
function captureStream(stream) {
  const original = stream.write;
  const calls = [];
  stream.write = (chunk) => {
    calls.push(chunk);
    return true;
  };
  return {
    calls,
    restore: () => {
      stream.write = original;
    },
  };
}

test("info writes one JSON line to stdout with t/level/msg", () => {
  const out = captureStream(process.stdout);
  try {
    log.info("hello", { foo: "bar" });
  } finally {
    out.restore();
  }
  assert.equal(out.calls.length, 1);
  const parsed = JSON.parse(out.calls[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.foo, "bar");
  assert.ok(parsed.t); // timestamp present
});

test("warn and error go to stderr, not stdout", () => {
  const out = captureStream(process.stdout);
  const err = captureStream(process.stderr);
  try {
    log.warn("w");
    log.error("e");
  } finally {
    out.restore();
    err.restore();
  }
  assert.equal(out.calls.length, 0);
  assert.equal(err.calls.length, 2);
});

test("debug is suppressed at the default (info) floor", () => {
  const out = captureStream(process.stdout);
  try {
    log.debug("should not appear");
  } finally {
    out.restore();
  }
  assert.equal(out.calls.length, 0);
});

test("captureError logs the message and a truncated stack, never throws on a non-Error", () => {
  const err = captureStream(process.stderr);
  try {
    log.captureError(new Error("boom"), { where: "test" });
    assert.doesNotThrow(() => log.captureError(undefined, {}));
    assert.doesNotThrow(() =>
      log.captureError("a string, not an Error object"),
    );
  } finally {
    err.restore();
  }
  const first = JSON.parse(err.calls[0]);
  assert.equal(first.msg, "boom");
  assert.equal(first.where, "test");
  assert.ok(first.stack.split(" | ").length <= 4);
});

// LOG_LEVEL is read once at module load time, so testing that it actually
// changes the floor requires a fresh process — spawn one instead of trying
// to mutate process.env.LOG_LEVEL after this test file already required the
// module (which would silently test nothing).
test("LOG_LEVEL=error raised in a fresh process suppresses info/warn", () => {
  const script = `
    process.env.LOG_LEVEL = 'error';
    const log = require(${JSON.stringify(path.join(__dirname, "..", "lib", "log.js"))});
    log.info('should not print');   // stdout — suppressed
    log.warn('should not print either'); // stderr — suppressed
    log.error('should print');      // stderr — allowed at this floor
  `;
  // error/warn write to stderr, info/debug to stdout (see lib/log.js) — capture
  // both explicitly rather than relying on execFileSync's stdout-only default.
  const { stdout, stderr } = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
  });
  assert.equal(stdout.trim(), "", "nothing should have gone to stdout");
  const lines = stderr.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).msg, "should print");
});
