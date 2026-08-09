"use strict";

/**
 * Append-only analytics event log (JSON Lines at data/events.jsonl).
 *
 * The MVP's whole purpose is measuring behaviour, so we record discrete,
 * timestamped, PII-free events (never emails) instead of just bumping global
 * counters. That lets us answer time-windowed questions, compute a real funnel,
 * and dedupe apply-clicks / retention by anonymous client id.
 *
 * Event types recorded by the app: pageview, profile_view, filter_used, search,
 * save, unsave, apply_click, signup, login, account_delete.
 * Each line: { ts, type, anon, ...meta } — `anon` is a random per-browser id,
 * never an email or student id.
 *
 * The aggregation functions below (computeFunnel, computeRetention, …) are pure
 * — they take an array of events and return a result, with no file I/O — so
 * they're unit-testable without touching disk. `summary()` etc. are thin
 * wrappers that read the log and call the pure function.
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

function readAll() {
  if (!fs.existsSync(FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
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

/** Totals + rolling-window totals by event type. */
function computeSummary(events, now = Date.now()) {
  const totals = {};
  const last24h = {};
  const last7d = {};
  const applyByUni = {};
  const applyUniqueSets = {};

  for (const e of events) {
    const age = now - Date.parse(e.ts);
    totals[e.type] = (totals[e.type] || 0) + 1;
    if (age <= DAY) last24h[e.type] = (last24h[e.type] || 0) + 1;
    if (age <= 7 * DAY) last7d[e.type] = (last7d[e.type] || 0) + 1;
    if (e.type === "apply_click" && e.uni) {
      applyByUni[e.uni] = (applyByUni[e.uni] || 0) + 1;
      (applyUniqueSets[e.uni] = applyUniqueSets[e.uni] || new Set()).add(
        e.anon || Math.random(),
      );
    }
  }
  const applyUnique = {};
  for (const [uni, set] of Object.entries(applyUniqueSets))
    applyUnique[uni] = set.size;

  return {
    totals,
    last24h,
    last7d,
    applyByUni,
    applyUnique,
    count: events.length,
  };
}

/**
 * Overview: active visitors over the three standard windows, plus how many of
 * them are new.
 *
 * "Active" counts distinct anonymous ids, not events — one person refreshing
 * twenty times is one visitor, and reporting it as twenty would flatter every
 * number on the page. Events without an anon id (there shouldn't be any) are
 * skipped rather than counted as a phantom visitor.
 *
 * "New" means the id's FIRST EVER event falls inside the window, judged against
 * the whole log rather than the window — otherwise everyone looks new whenever
 * the window is short, which is exactly when you'd be misled.
 *
 * @param {object[]} events
 * @param {number} [now]
 */
function computeOverview(events, now = Date.now()) {
  const firstSeen = new Map(); // anon -> ms of earliest event anywhere in the log
  for (const e of events) {
    if (!e.anon) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const prev = firstSeen.get(e.anon);
    if (prev === undefined || t < prev) firstSeen.set(e.anon, t);
  }

  const windows = { dau: DAY, wau: 7 * DAY, mau: 30 * DAY };
  const out = {};
  for (const [key, span] of Object.entries(windows)) {
    const active = new Set();
    for (const e of events) {
      if (!e.anon) continue;
      const t = Date.parse(e.ts);
      if (Number.isFinite(t) && now - t <= span) active.add(e.anon);
    }
    let fresh = 0;
    for (const anon of active) {
      if (now - (firstSeen.get(anon) ?? 0) <= span) fresh++;
    }
    out[key] = {
      active: active.size,
      new: fresh,
      returning: active.size - fresh,
    };
  }
  return out;
}

/** Views/clicks/saves grouped by university id, for "top universities" tables. */
function computeTopByUni(events, type, limit = 10) {
  const counts = {};
  const uniqueSets = {};
  for (const e of events) {
    if (e.type !== type || !e.uni) continue;
    counts[e.uni] = (counts[e.uni] || 0) + 1;
    (uniqueSets[e.uni] = uniqueSets[e.uni] || new Set()).add(
      e.anon || Math.random(),
    );
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, count]) => ({ id, count, unique: uniqueSets[id].size }));
}

/**
 * Most frequent search terms in the window (folded to lowercase, blanks skipped).
 * @param {object[]} events
 * @param {{ sinceMs?: number, limit?: number }} [opts]
 */
function computeTopSearches(events, opts = {}) {
  const { sinceMs, limit = 10 } = opts;
  const now = Date.now();
  const counts = new Map();
  for (const e of events) {
    if (e.type !== "search" || !e.q) continue;
    if (sinceMs && now - Date.parse(e.ts) > sinceMs) continue;
    const key = String(e.q).trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([q, count]) => ({ q, count }));
}

/**
 * Acquisition/engagement funnel: distinct anonymous clients reaching each
 * stage within the window, in order, with conversion vs. the first stage and
 * vs. the previous stage. A client only needs ONE event of a type to count
 * for that stage (order across stages isn't enforced — this measures reach,
 * not strict sequential funnels, which is the honest thing to claim from an
 * event log without session stitching).
 */
// The student journey the roadmap actually cares about:
// Visitor → Register → Dream → Save → Compare → Apply.
//
// Previously this measured visit → search → profile_view → save → apply_click,
// which skipped the three stages that mark real commitment (creating an account,
// naming a dream, comparing a shortlist) and counted two browsing steps instead.
// Every event below is already recorded — nothing here is aspirational.
const FUNNEL_STAGES = [
  { key: "visit", label: "Visited", types: ["pageview", "profile_view"] },
  { key: "register", label: "Registered", types: ["signup"] },
  { key: "dream", label: "Created a dream", types: ["dream_update"] },
  { key: "save", label: "Saved a university", types: ["save"] },
  { key: "compare", label: "Compared", types: ["compare"] },
  { key: "apply", label: "Clicked Apply", types: ["apply_click"] },
];

/**
 * @param {object[]} events
 * @param {{ sinceMs?: number }} [opts]
 */
function computeFunnel(events, opts = {}) {
  const { sinceMs } = opts;
  const now = Date.now();
  const inWindow = sinceMs
    ? events.filter((e) => now - Date.parse(e.ts) <= sinceMs)
    : events;

  const stageSets = FUNNEL_STAGES.map(() => new Set());
  for (const e of inWindow) {
    if (!e.anon) continue;
    FUNNEL_STAGES.forEach((stage, i) => {
      if (stage.types.includes(e.type)) stageSets[i].add(e.anon);
    });
  }

  const first = stageSets[0].size || 0;
  let prev = null;
  return FUNNEL_STAGES.map((stage, i) => {
    const n = stageSets[i].size;
    const row = {
      key: stage.key,
      label: stage.label,
      count: n,
      pct_of_first: first ? Math.round((n / first) * 1000) / 10 : 0,
      pct_of_prev:
        prev == null ? 100 : prev ? Math.round((n / prev) * 1000) / 10 : 0,
    };
    prev = n;
    return row;
  });
}

/**
 * Weekly cohort retention. Cohorts clients by the ISO week of their first-ever
 * event (in the full log, not just the window) and reports, for each of the
 * following `weeks` weeks, what % of that cohort had ANY event.
 */
function isoWeekStart(date) {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function computeRetention(events, { weeks = 6 } = {}) {
  const firstSeen = new Map(); // anon -> Date of first event
  const activeWeeks = new Map(); // anon -> Set(weekIndexSinceEpochMonday)

  const sorted = [...events]
    .filter((e) => e.anon)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!sorted.length) return { cohorts: [] };

  const WEEK_MS = 7 * DAY;
  const originWeek = isoWeekStart(new Date(Date.parse(sorted[0].ts))).getTime();

  for (const e of sorted) {
    const t = Date.parse(e.ts);
    if (!firstSeen.has(e.anon)) firstSeen.set(e.anon, t);
    const weekIdx = Math.floor(
      (isoWeekStart(new Date(t)).getTime() - originWeek) / WEEK_MS,
    );
    if (!activeWeeks.has(e.anon)) activeWeeks.set(e.anon, new Set());
    activeWeeks.get(e.anon).add(weekIdx);
  }

  // Group clients into cohorts by the week they were first seen.
  const cohortMembers = new Map(); // cohortWeekIdx -> [anon,...]
  for (const [anon, t] of firstSeen) {
    const w = Math.floor(
      (isoWeekStart(new Date(t)).getTime() - originWeek) / WEEK_MS,
    );
    if (!cohortMembers.has(w)) cohortMembers.set(w, []);
    cohortMembers.get(w).push(anon);
  }

  const nowWeek = Math.floor(
    (isoWeekStart(new Date()).getTime() - originWeek) / WEEK_MS,
  );
  const cohortWeeks = [...cohortMembers.keys()]
    .sort((a, b) => a - b)
    .filter((w) => nowWeek - w < weeks + 8); // cap history shown

  const cohorts = cohortWeeks.slice(-weeks).map((w) => {
    const members = cohortMembers.get(w);
    const weekDate = new Date(originWeek + w * WEEK_MS);
    const retention = [];
    for (let offset = 0; offset < weeks; offset++) {
      const targetWeek = w + offset;
      if (targetWeek > nowWeek) {
        retention.push(null);
        continue;
      } // hasn't happened yet
      const returned = members.filter((a) =>
        activeWeeks.get(a)?.has(targetWeek),
      ).length;
      retention.push(Math.round((returned / members.length) * 1000) / 10);
    }
    return {
      week_start: weekDate.toISOString().slice(0, 10),
      size: members.length,
      retention,
    };
  });

  return { cohorts, weeks };
}

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

/** Traffic view: pageviews, unique visitors, top paths/referrers/devices/languages. */
/**
 * @param {object[]} events
 * @param {{ sinceMs?: number }} [opts]
 */
function computeTraffic(events, opts = {}) {
  const { sinceMs } = opts;
  const now = Date.now();
  const inWindow = sinceMs
    ? events.filter((e) => now - Date.parse(e.ts) <= sinceMs)
    : events;

  const viewEvents = inWindow.filter(
    (e) => e.type === "pageview" || e.type === "profile_view",
  );
  const uniqueVisitors = new Set(inWindow.map((e) => e.anon).filter(Boolean));

  const bump = (map, key) => {
    if (key) map.set(key, (map.get(key) || 0) + 1);
  };
  const paths = new Map(),
    referrers = new Map(),
    languages = new Map();
  const device = { mobile: 0, desktop: 0, unknown: 0 };

  for (const e of viewEvents) {
    bump(paths, e.path);
    bump(referrers, e.ref || "direct");
    bump(languages, e.lang);
    device[
      e.device === "mobile" || e.device === "desktop" ? e.device : "unknown"
    ]++;
  }
  const top = (map, limit = 8) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k, v]) => ({ key: k, count: v }));

  return {
    pageviews: viewEvents.length,
    unique_visitors: uniqueVisitors.size,
    top_paths: top(paths),
    top_referrers: top(referrers),
    top_languages: top(languages),
    device_split: device,
  };
}

// ---------------------------------------------------------------------------
// File-backed convenience wrappers
// ---------------------------------------------------------------------------
const summary = () => computeSummary(readAll());
const overview = () => computeOverview(readAll());
const uniTimeseries = (uniId, opts) =>
  computeUniTimeseries(readAll(), uniId, opts);
const funnel = (opts) => computeFunnel(readAll(), opts);
const retention = (opts) => computeRetention(readAll(), opts);
const traffic = (opts) => computeTraffic(readAll(), opts);
const topSearches = (opts) => computeTopSearches(readAll(), opts);
const topByUni = (type, limit) => computeTopByUni(readAll(), type, limit);

module.exports = {
  record,
  readAll,
  flush,
  purgeAnon,
  rotateIfLarge,
  shouldRotate,
  FILE,
  ROTATE_AT_BYTES,
  summary,
  overview,
  funnel,
  retention,
  traffic,
  topSearches,
  topByUni,
  uniTimeseries,
  // exported for pure unit tests
  computeSummary,
  computeOverview,
  computeFunnel,
  computeRetention,
  computeTraffic,
  computeTopSearches,
  computeTopByUni,
  computeUniTimeseries,
};
