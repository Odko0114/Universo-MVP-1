"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rateLimit } = require("../lib/rate-limit");

// Minimal req/res doubles. Each test uses a unique path so the module-level
// bucket map never bleeds state between tests.
let n = 0;
function makeReq(ip = "1.2.3.4") {
  return {
    method: "POST",
    path: `/test-${n}`,
    headers: {},
    socket: { remoteAddress: ip },
  };
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}
function run(limiter, req) {
  const res = makeRes();
  let passed = false;
  limiter(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

test("allows up to max requests, then blocks with 429 + Retry-After", () => {
  n++;
  const limiter = rateLimit({ windowMs: 60_000, max: 3 });
  const req = makeReq();
  for (let i = 0; i < 3; i++)
    assert.equal(
      run(limiter, req).passed,
      true,
      `request ${i + 1} should pass`,
    );

  const blocked = run(limiter, req);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.ok(blocked.res.headers["Retry-After"] >= 1);
  assert.match(blocked.res.body.error, /Too many/i);
});

test("the window slides: old hits expire and requests pass again", async () => {
  n++;
  const limiter = rateLimit({ windowMs: 120, max: 2 });
  const req = makeReq();
  assert.equal(run(limiter, req).passed, true);
  assert.equal(run(limiter, req).passed, true);
  assert.equal(run(limiter, req).passed, false); // over the limit

  await new Promise((r) => setTimeout(r, 150)); // let the window pass
  assert.equal(
    run(limiter, req).passed,
    true,
    "should pass again after the window expires",
  );
});

test("limits are per client ip — one abuser cannot exhaust another user's quota", () => {
  n++;
  const limiter = rateLimit({ windowMs: 60_000, max: 1 });
  assert.equal(run(limiter, makeReq("9.9.9.9")).passed, true);
  assert.equal(run(limiter, makeReq("9.9.9.9")).passed, false); // abuser blocked
  assert.equal(
    run(limiter, makeReq("8.8.8.8")).passed,
    true,
    "a different ip still has quota",
  );
});

test("limits are per route — hitting one endpoint does not consume another's quota", () => {
  n++;
  const limiter = rateLimit({ windowMs: 60_000, max: 1 });
  const reqA = makeReq();
  n++;
  const reqB = makeReq(); // different path
  assert.equal(run(limiter, reqA).passed, true);
  assert.equal(run(limiter, reqA).passed, false);
  assert.equal(run(limiter, reqB).passed, true);
});

test("uses the first X-Forwarded-For hop when behind a proxy", () => {
  n++;
  const limiter = rateLimit({ windowMs: 60_000, max: 1 });
  const forwarded = {
    method: "POST",
    path: `/test-${n}`,
    headers: { "x-forwarded-for": "7.7.7.7, 10.0.0.1" },
    socket: { remoteAddress: "10.0.0.1" },
  };
  assert.equal(run(limiter, forwarded).passed, true);
  assert.equal(
    run(limiter, forwarded).passed,
    false,
    "same forwarded ip shares one bucket",
  );
});

test("supports a custom message", () => {
  n++;
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 0,
    message: "Custom slow down",
  });
  const { res } = run(limiter, makeReq());
  assert.equal(res.body.error, "Custom slow down");
});
