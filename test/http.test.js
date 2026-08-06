"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchWithResilience } = require("../lib/http");

// The circuit breaker keeps state per-host for the life of the process, so
// each test uses its own unique fake hostname to stay isolated from the others.
let n = 0;
const freshUrl = () => `https://resilience-test-${n++}.example/x`;

function mockFetch(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => {
    global.fetch = original;
  };
}

test("a successful first attempt calls fetch exactly once", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return { status: 200 };
  });
  try {
    const res = await fetchWithResilience(freshUrl(), { retries: 2 });
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("retries after a rejected fetch and succeeds on the second attempt", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    if (calls === 1) throw new Error("network blip");
    return { status: 200 };
  });
  try {
    const res = await fetchWithResilience(freshUrl(), { retries: 1 });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("a 5xx response counts as a failure and is retried", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return calls === 1 ? { status: 503 } : { status: 200 };
  });
  try {
    const res = await fetchWithResilience(freshUrl(), { retries: 1 });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("throws the last error once retries are exhausted", async () => {
  const restore = mockFetch(async () => {
    throw new Error("always fails");
  });
  try {
    await assert.rejects(
      () => fetchWithResilience(freshUrl(), { retries: 1 }),
      /always fails/,
    );
  } finally {
    restore();
  }
});

test("circuit breaker opens after 5 consecutive failures on the same host, then fails fast", async () => {
  const url = freshUrl();
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    throw new Error("down");
  });
  try {
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => fetchWithResilience(url, { retries: 0 }));
    }
    assert.equal(calls, 5);

    // 6th call: breaker should be open — rejects WITHOUT calling fetch again.
    await assert.rejects(
      () => fetchWithResilience(url, { retries: 0 }),
      /circuit open/,
    );
    assert.equal(
      calls,
      5,
      "fetch should not have been invoked while the circuit is open",
    );
  } finally {
    restore();
  }
});

test("a success clears the failure count so the breaker does not open early", async () => {
  const url = freshUrl();
  let mode = "fail";
  const restore = mockFetch(async () => {
    if (mode === "fail") throw new Error("down");
    return { status: 200 };
  });
  try {
    // 3 failures (below the threshold of 5)…
    for (let i = 0; i < 3; i++)
      await assert.rejects(() => fetchWithResilience(url, { retries: 0 }));
    // …then a success, which should reset the counter…
    mode = "ok";
    await fetchWithResilience(url, { retries: 0 });
    // …so 3 more failures still shouldn't open the breaker (would need 5 in a row).
    mode = "fail";
    for (let i = 0; i < 3; i++)
      await assert.rejects(() => fetchWithResilience(url, { retries: 0 }));
    // A 4th failure call still goes through to fetch (breaker not yet open) —
    // proves the earlier success reset the streak instead of just delaying it.
    await assert.rejects(
      () => fetchWithResilience(url, { retries: 0 }),
      (err) => !/circuit open/.test(err.message),
    );
  } finally {
    restore();
  }
});
