'use strict';

/**
 * In-memory sliding-window rate limiter (no external store). Good enough for a
 * single-process MVP; swap the backing Map for Redis when you scale horizontally
 * (the limiter interface stays the same).
 *
 * Usage:
 *   const limit = rateLimit({ windowMs: 60_000, max: 10, key: keyByIp });
 *   app.post('/x', limit, handler);
 */

const buckets = new Map(); // key -> number[] (timestamps within the window)

// Periodically drop empty buckets so the Map doesn't grow unbounded.
const SWEEP_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) {
    if (!hits.length || now - hits[hits.length - 1] > SWEEP_MS) buckets.delete(k);
  }
}, SWEEP_MS).unref();

const ipOf = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

/**
 * @param {{ windowMs:number, max:number, key?:(req)=>string, message?:string }} opts
 */
function rateLimit({ windowMs, max, key = ipOf, message }) {
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const bucketKey = `${req.method}:${req.path}:${key(req)}`;
    const hits = (buckets.get(bucketKey) || []).filter((t) => now - t < windowMs);

    if (hits.length >= max) {
      const retryMs = windowMs - (now - hits[0]);
      res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
      return res.status(429).json({ error: message || 'Too many requests. Please slow down and try again shortly.' });
    }

    hits.push(now);
    buckets.set(bucketKey, hits);
    next();
  };
}

module.exports = { rateLimit, ipOf };
