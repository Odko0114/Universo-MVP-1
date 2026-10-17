"use strict";

/**
 * Append-only analytics event log (JSON Lines at data/events.jsonl).
 *
 * The MVP's whole purpose is measuring behaviour, so we record discrete,
 * timestamped, PII-free events (never emails) instead of just bumping global
 * counters. That lets us answer time-windowed questions, compute a real funnel,
 * and dedupe apply-clicks / retention by anonymous client id.
 *
 * Event types recorded by the app: pageview, profile_view, compare, search,
 * save, unsave, apply_click, signup, login, account_delete (and a few account/
 * plan actions). Weekly admin numbers are computed in lib/usage.js.
 * Each line: { ts, type, anon, ...meta } — `anon` is a random per-browser id,
 * never an email or student id.
 *
 * computeUniTimeseries below is pure — it takes an array of events and returns a
 * result, with no file I/O — so it's unit-testable without touching disk.
 * `uniTimeseries()` is a thin wrapper that reads the log and calls it.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const log = require("./log");
const cfg = require("./config");

// Same runtime-data location rule as lib/store.js: UNIVERSO_DATA_DIR points at
// the persistent volume in production so the event log survives deploys.
// Fail fast rather than silently logging events into the ephemeral image.
if (cfg.PROD && !process.env.UNIVERSO_DATA_DIR) {
  throw new Error(
    "UNIVERSO_DATA_DIR must be set in production (point it at a persistent volume).",
  );
}
const DATA_DIR =
  process.env.UNIVERSO_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "events.jsonl");
const DAY = 86_400_000;

// Rotation: events.jsonl is append-only and otherwise grows forever, and
// every admin-dashboard read does a synchronous full-file read + parse — so
// an unbounded file eventually means an unboundedly slow (and event-loop-
// blocking) dashboard. Once the live file passes this size, archive it under
// a dated filename and start a fresh one. Archives are kept on disk (for
// backup/audit) but are NOT included in live queries — retention/funnel/
// traffic report on the current file only. That's a deliberate scope limit,
// not an oversight: this app's analytics windows (7d/30d/12wk) rarely need
// history older than a rotation cycle in practice.
const ROTATE_AT_BYTES = 5 * 1024 * 1024; // ~5MB, tens of thousands of events

let buffer = [];
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 1000);
  flushTimer.unref?.();
}

async function flush() {
  flushTimer = null;
  if (!buffer.length) return;
  const chunk = buffer.join("");
  buffer = [];
  try {
    await fsp.appendFile(FILE, chunk);
  } catch {
    // Re-buffer on failure so we retry on the next flush rather than lose events.
    buffer.unshift(chunk);
  }
}

// Pure decision, split out from the file I/O below so the threshold logic is
// unit-testable without needing to actually write megabytes to disk.
const shouldRotate = (sizeBytes, threshold = ROTATE_AT_BYTES) =>
  sizeBytes >= threshold;

/**
 * Archive events.jsonl to a dated file if it's grown past ROTATE_AT_BYTES,
 * leaving a fresh (empty) live file. Cheap to call often: fs.statSync reads
 * file metadata only, never the file's contents, so checking size doesn't
 * cost the same synchronous full-read this function exists to avoid.
 */
async function rotateIfLarge() {
  await flush(); // don't archive out from under a pending write
  let size;
  try {
    size = fs.statSync(FILE).size;
  } catch {
    return false;
  } // no file yet — nothing to rotate
  if (!shouldRotate(size)) return false;

  const stamp = new Date().toISOString().slice(0, 10);
  let archivePath = FILE.replace(/\.jsonl$/, `-archive-${stamp}.jsonl`);
  let n = 2;
  while (fs.existsSync(archivePath))
    archivePath = FILE.replace(/\.jsonl$/, `-archive-${stamp}-${n++}.jsonl`);

  await fsp.rename(FILE, archivePath);
  log.info("events log rotated", {
    archivePath: path.basename(archivePath),
    bytes: size,
  });
  return true;
}

// Check once an hour; each check is a stat() call, not a file read, so this
// is negligible overhead. unref() so it never keeps the process alive.
const rotateTimer = setInterval(
  () => {
    rotateIfLarge().catch(() => {});
  },
  60 * 60 * 1000,
);
rotateTimer.unref?.();

/**
 * @param {string} type
 * @param {object} [meta]  small, PII-free fields (ids, short strings — never emails)
 */
function record(type, meta = {}) {
  buffer.push(
    JSON.stringify({ ts: new Date().toISOString(), type, ...meta }) + "\n",
  );
  scheduleFlush();
}

// Parsed-log cache. The admin dashboard fires ~8 endpoints at once and each
// aggregation reads the whole log — that used to be ~8 synchronous full reads
// + re-parses per dashboard load. Cache the parsed array and only re-read when
// the file actually changes (mtime + size), so repeat reads within a load (and
// across refreshes with no new events) are free. Callers must treat the result
// as READ-ONLY — the pure aggregations only read, and computeRetention copies
// before sorting. A flush/rotate/purge changes the file's mtime, which
// invalidates this automatically.
let _cache = { key: "", data: [] };
function readAll() {
  if (!fs.existsSync(FILE)) return [];
  let st;
  try {
    st = fs.statSync(FILE);
  } catch {
    return [];
  }
  const key = st.mtimeMs + ":" + st.size;
  if (key === _cache.key) return _cache.data;
  const out = [];
  for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  _cache = { key, data: out };
  return out;
}

/**
 * Permanently remove every event tied to any of the given anonymous ids
 * (GDPR erasure — called when a student deletes their account). Flushes any
 * buffered events first so nothing in-flight survives the purge.
 * @param {string[]} anonIds
 */
async function purgeAnon(anonIds) {
  await flush();
  const drop = new Set((anonIds || []).filter(Boolean));
  if (!drop.size || !fs.existsSync(FILE)) return 0;

  const lines = fs.readFileSync(FILE, "utf8").split("\n");
  let removed = 0;
  const kept = lines.filter((line) => {
    if (!line) return false;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return true;
    }
    if (e.anon && drop.has(e.anon)) {
      removed++;
      return false;
    }
    return true;
  });
  fs.writeFileSync(FILE, kept.length ? kept.join("\n") + "\n" : "");
  return removed;
}

// ---------------------------------------------------------------------------
// Pure aggregation functions (events in, summary out — no I/O, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Per-university daily time-series for the partner dashboard: profile views,
 * saves and apply clicks bucketed by UTC day over the last `days` days, plus
 * the distinct anonymous viewer ids (the caller can join those to student
 * countries — this module deliberately knows nothing about the students store).
 * Pure like the other compute* functions; `uniId` scoping happens HERE, on the
 * server, from the session — never from client input.
 */
function computeUniTimeseries(
  events,
  uniId,
  { days = 30, now = Date.now() } = {},
) {
  const series = [];
  const byDay = new Map(); // 'YYYY-MM-DD' -> row (same object referenced from series)
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * DAY).toISOString().slice(0, 10);
    const row = { date, views: 0, saves: 0, applies: 0 };
    byDay.set(date, row);
    series.push(row);
  }

  const viewerAnons = new Set();
  let totals = { views: 0, saves: 0, applies: 0 };
  for (const e of events) {
    if (e.uni !== uniId) continue;
    const key =
      e.type === "profile_view"
        ? "views"
        : e.type === "save"
          ? "saves"
          : e.type === "apply_click"
            ? "applies"
            : null;
    if (!key) continue;
    if (e.type === "profile_view" && e.anon) viewerAnons.add(e.anon);
    totals[key]++;
    const row = byDay.get(String(e.ts).slice(0, 10));
    if (row) row[key]++; // events older than the window still count toward totals
  }

  return { days, series, totals, viewer_anons: [...viewerAnons] };
}

// ---------------------------------------------------------------------------
// File-backed convenience wrappers
// ---------------------------------------------------------------------------
const uniTimeseries = (uniId, opts) =>
  computeUniTimeseries(readAll(), uniId, opts);

module.exports = {
  record,
  readAll,
  flush,
  purgeAnon,
  rotateIfLarge,
  shouldRotate,
  FILE,
  ROTATE_AT_BYTES,
  uniTimeseries,
  // exported for pure unit tests
  computeUniTimeseries,
};
