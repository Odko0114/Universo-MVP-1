"use strict";

/**
 * "Who came?" for the admin Usage screen.
 *
 *  - Accounts: NEW = signed up inside the window; RETURNING = signed up earlier
 *    and was active inside it.
 *  - Visitors: NEW = first-ever event inside the window; RETURNING = seen before.
 *    A visitor who has an account counts once however many devices they used
 *    (their anonymous ids are folded into the account).
 * Every figure also comes with the same-length window just before it, so a number
 * always has something to be compared to. Days are counted in the founder's time
 * zone, so "today" means today for them.
 *
 * Counts only by default. `withPeople` (admin route only) adds a short list of
 * accounts so the founder can see who is new — never emails or passwords.
 */

const DAY = 24 * 60 * 60 * 1000;
const TZ = "Europe/Helsinki";
const RANGES = { today: 1, "7d": 7, "30d": 30 };
const WHO = ["all", "new", "returning"];
const PEOPLE_MAX = 50;

const dayKey = (t) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(t)); // YYYY-MM-DD, sorts as text
const keyOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? dayKey(t) : "";
};

function top(counts, n = 6) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([label, count]) => ({ label, count }));
}

/** Accounts that are new / returning in [startKey, endKey]. */
function accountsIn(students, startKey, endKey) {
  const out = { new: [], returning: [] };
  for (const s of students) {
    const su = keyOf(s.signup_date);
    const la = keyOf(s.last_active_date);
    if (su && su >= startKey && su <= endKey) out.new.push(s);
    else if (su < startKey && la >= startKey && la <= endKey)
      out.returning.push(s);
  }
  return out;
}

/**
 * @param {{students:any[], events:any[], now?:number, range?:string, who?:string, withPeople?:boolean}} o
 */
function computeAudience({
  students,
  events,
  now = Date.now(),
  range,
  who,
  withPeople = false,
}) {
  const r = RANGES[range] ? range : "today";
  const w = WHO.includes(who) ? who : "all";
  const days = RANGES[r];
  const today = dayKey(now);
  const startKey = dayKey(now - (days - 1) * DAY);
  const prevEnd = dayKey(now - days * DAY);
  const prevStart = dayKey(now - (2 * days - 1) * DAY);

  // ---- accounts ----
  const acc = accountsIn(students, startKey, today);
  const prevAcc = accountsIn(students, prevStart, prevEnd);
  const picked =
    w === "new"
      ? acc.new
      : w === "returning"
        ? acc.returning
        : [...acc.new, ...acc.returning];
  const tally = (get) => {
    const m = new Map();
    let unknown = 0;
    for (const s of picked) {
      const v = String(get(s) || "")
        .trim()
        .slice(0, 60);
      if (v) m.set(v, (m.get(v) || 0) + 1);
      else unknown++;
    }
    return { rows: top(m), unknown };
  };

  // ---- visitors (one identity per person where we can tell) ----
  const owner = new Map(); // anon id -> student id
  for (const s of students)
    for (const a of s.anon_ids || []) owner.set(a, s.student_id);
  const first = new Map(); // identity -> first day ever seen
  const seen = new Map(); // identity -> Set of days
  for (const e of events) {
    if (!e.anon) continue;
    const k = keyOf(e.ts);
    if (!k) continue;
    const id = owner.get(e.anon) || e.anon;
    if (!first.has(id) || k < first.get(id)) first.set(id, k);
    if (!seen.has(id)) seen.set(id, new Set());
    seen.get(id).add(k);
  }
  const visitorsIn = (a, b) => {
    let nw = 0;
    let total = 0;
    for (const [id, set] of seen) {
      if (![...set].some((k) => k >= a && k <= b)) continue;
      total++;
      if (first.get(id) >= a) nw++;
    }
    return { new: nw, returning: total - nw, total };
  };
  const visitors = visitorsIn(startKey, today);
  const prevVisitors = visitorsIn(prevStart, prevEnd);

  // ---- last 7 days, one row per day ----
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const k = dayKey(now - i * DAY);
    let v = 0;
    for (const set of seen.values()) if (set.has(k)) v++;
    daily.push({
      day: k,
      newAccounts: students.filter((s) => keyOf(s.signup_date) === k).length,
      visitors: v,
    });
  }

  const out = {
    range: r,
    who: w,
    totalAccounts: students.length,
    accounts: {
      new: acc.new.length,
      returning: acc.returning.length,
      total: acc.new.length + acc.returning.length,
    },
    visitors,
    previous: {
      accounts: {
        new: prevAcc.new.length,
        total: prevAcc.new.length + prevAcc.returning.length,
      },
      visitors: prevVisitors,
    },
    breakdown: {
      countries: tally((s) => s.country_of_origin),
      fields: tally((s) => s.field_of_interest),
      degrees: tally((s) => s.target_degree_level),
    },
    daily,
  };

  if (withPeople) {
    const tag = new Map();
    acc.new.forEach((s) => tag.set(s, "new"));
    acc.returning.forEach((s) => tag.set(s, "returning"));
    out.people = picked
      .slice()
      .sort((a, b) =>
        String(b.last_active_date || b.signup_date).localeCompare(
          String(a.last_active_date || a.signup_date),
        ),
      )
      .slice(0, PEOPLE_MAX)
      .map((s) => ({
        name: String(s.full_name || "").slice(0, 80),
        status: tag.get(s),
        country: String(s.country_of_origin || "").slice(0, 60),
        field: String(s.field_of_interest || "").slice(0, 60),
        signedUp: s.signup_date || "",
        lastActive: s.last_active_date || "",
        saved: (s.saved_universities || []).length,
      }));
    out.peopleTotal = picked.length;
  }
  return out;
}

module.exports = { computeAudience, RANGES, WHO, TZ };
