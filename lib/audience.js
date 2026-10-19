"use strict";

/**
 * "Who came?" for Marketing OS — counts only, never names or emails (a marketer
 * account sees this too).
 *
 *  - Accounts: NEW = signed up inside the window; RETURNING = signed up earlier
 *    and was active inside it.
 *  - Visitors (anonymous ids from the event log): NEW = first-ever event is
 *    inside the window; RETURNING = seen before the window started.
 * Days are counted in the founder's time zone, so "today" means today for them.
 */

const DAY = 24 * 60 * 60 * 1000;
const TZ = "Europe/Helsinki";
const RANGES = { today: 1, "7d": 7, "30d": 30 };
const WHO = ["all", "new", "returning"];

const dayKey = (t) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(t)); // YYYY-MM-DD, sorts as text

function top(counts, n = 6) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([label, count]) => ({ label, count }));
}

/**
 * @param {{students:any[], events:any[], now?:number, range?:string, who?:string}} o
 */
function computeAudience({ students, events, now = Date.now(), range, who }) {
  const r = RANGES[range] ? range : "today";
  const w = WHO.includes(who) ? who : "all";
  const days = RANGES[r];
  const startKey = dayKey(now - (days - 1) * DAY);
  const today = dayKey(now);
  const keyOf = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? dayKey(t) : "";
  };

  // ---- accounts ----
  const acc = { new: [], returning: [] };
  for (const s of students) {
    const su = keyOf(s.signup_date);
    const la = keyOf(s.last_active_date);
    if (su && su >= startKey) acc.new.push(s);
    else if (la && la >= startKey) acc.returning.push(s);
  }
  const picked =
    w === "new"
      ? acc.new
      : w === "returning"
        ? acc.returning
        : [...acc.new, ...acc.returning];
  const tally = (get) => {
    const m = new Map();
    for (const s of picked) {
      const v = String(get(s) || "")
        .trim()
        .slice(0, 60);
      if (v) m.set(v, (m.get(v) || 0) + 1);
    }
    return top(m);
  };

  // ---- anonymous visitors ----
  const first = new Map(); // anon -> first day ever seen
  const inRange = new Set();
  const perDay = new Map(); // day -> Set(anon), last 7 days
  const weekStart = dayKey(now - 6 * DAY);
  for (const e of events) {
    if (!e.anon) continue;
    const k = keyOf(e.ts);
    if (!k) continue;
    if (!first.has(e.anon) || k < first.get(e.anon)) first.set(e.anon, k);
    if (k >= startKey && k <= today) inRange.add(e.anon);
    if (k >= weekStart && k <= today) {
      if (!perDay.has(k)) perDay.set(k, new Set());
      perDay.get(k).add(e.anon);
    }
  }
  let vNew = 0;
  for (const a of inRange) if (first.get(a) >= startKey) vNew++;

  // ---- last 7 days, one row per day ----
  const newPerDay = new Map();
  for (const s of students) {
    const k = keyOf(s.signup_date);
    if (k >= weekStart) newPerDay.set(k, (newPerDay.get(k) || 0) + 1);
  }
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const k = dayKey(now - i * DAY);
    daily.push({
      day: k,
      newAccounts: newPerDay.get(k) || 0,
      visitors: (perDay.get(k) || new Set()).size,
    });
  }

  return {
    range: r,
    who: w,
    totalAccounts: students.length,
    accounts: {
      new: acc.new.length,
      returning: acc.returning.length,
      total: acc.new.length + acc.returning.length,
    },
    visitors: {
      new: vNew,
      returning: inRange.size - vNew,
      total: inRange.size,
    },
    breakdown: {
      countries: tally((s) => s.country_of_origin),
      fields: tally((s) => s.field_of_interest),
      degrees: tally((s) => s.target_degree_level),
    },
    daily,
  };
}

module.exports = { computeAudience, RANGES, WHO, TZ };
