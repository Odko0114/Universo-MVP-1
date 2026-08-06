"use strict";

/**
 * Resilient outbound HTTP: timeout + bounded retries with backoff + a simple
 * per-host circuit breaker so one flaky upstream (ETER, Wikipedia, a favicon
 * host) can't hang requests or get hammered while it's down.
 */

const log = require("./log");

const breakers = new Map(); // host -> { failures, openUntil }
const BREAKER_THRESHOLD = 5; // consecutive failures before opening
const BREAKER_COOLDOWN_MS = 30_000;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function breakerState(host) {
  return breakers.get(host) || { failures: 0, openUntil: 0 };
}

function recordSuccess(host) {
  breakers.delete(host);
}

function recordFailure(host) {
  const b = breakerState(host);
  b.failures += 1;
  if (b.failures >= BREAKER_THRESHOLD)
    b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  breakers.set(host, b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?:number, retries?:number, label?:string }} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithResilience(url, opts = {}) {
  const { timeoutMs = 10_000, retries = 2, label, ...init } = opts;
  const host = hostOf(url);

  const b = breakerState(host);
  if (b.openUntil > Date.now()) {
    throw new Error(`circuit open for ${host}`);
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 500) throw new Error(`upstream ${res.status}`);
      recordSuccess(host);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(250 * 2 ** attempt); // 250ms, 500ms backoff
      }
    }
  }
  recordFailure(host);
  log.warn("outbound fetch failed", {
    host,
    label,
    error: lastErr && lastErr.message,
  });
  throw lastErr;
}

module.exports = { fetchWithResilience };
