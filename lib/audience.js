"use strict";

/**
 * "Who came?" for the admin Usage screen.
 *
 *  - Accounts: NEW = signed up inside the window; RETURNING = signed up earlier
 *    and was active inside it.
 *  - Visitors: people WITHOUT an account, counted only when their browser showed
 *    a real action (tap, click, key, scroll, mouse — the "human" event).
 *    NEW = first-ever event inside the window; RETURNING = seen before.
 *    Browsers that opened a page and did nothing are reported apart ("quiet").
 *    Before the first "human" event nothing can be told apart, so those days
 *    have no visitor number — only "mixed" (people and bots together).
 *    Browsers belonging to an account are never visitors; they are students.
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

/** Move a YYYY-MM-DD day by n days (calendar arithmetic, immune to DST). */
const shiftKey = (key, n) =>
  new Date(Date.parse(key + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);

function top(counts, n = 6) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([label, count]) => ({ label, count }));
}

/** anon id -> student id, so one person on two devices is one person. */
function ownerMap(students) {
  const owner = new Map();
  for (const s of students)
    for (const a of s.anon_ids || []) owner.set(a, s.student_id);
  return owner;
}

/**
 * Every browser that has no account, split by whether a person was observed.
 * `since` is the first "human" event ever recorded (ms, Infinity if none yet).
 */
function browsers(events, owner) {
  let since = Infinity;
  for (const e of events)
    if (e.type === "human") since = Math.min(since, Date.parse(e.ts) || since);
  const first = new Map(); // browser -> first day ever seen
  const before = new Map(); // browser -> days seen before counting began
  const after = new Map(); // browser -> days seen since
  const human = new Map(); // browser -> days a person was observed
  const add = (m, id, k) => (m.get(id) || m.set(id, new Set()).get(id)).add(k);
  for (const e of events) {
    if (!e.anon || owner.has(e.anon)) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const k = dayKey(t);
    if (!first.has(e.anon) || k < first.get(e.anon)) first.set(e.anon, k);
    add(t < since ? before : after, e.anon, k);
    if (e.type === "human") add(human, e.anon, k);
  }
  return { since, first, before, after, human };
}

const idsIn = (map, a, b) =>
  [...map].filter(([, days]) => [...days].some((k) => k >= a && k <= b));

/** Accounts that are new / returning in [startKey, endKey]. */
function accountsIn(students, startKey, endKey) {
  const out = { new: [], returning: [] };
  for (const s of students) {
    const su = keyOf(s.signup_date);
    const la = keyOf(s.last_active_date);
    if (su && su >= startKey && su <= endKey) out.new.push(s);
    else if (su < startKey) {
      // came back in the window: either logged that day, or it is their latest visit
      const logged = (s.active_days || []).some(
        (d) => d >= startKey && d <= endKey,
      );
      if (logged || (la >= startKey && la <= endKey)) out.returning.push(s);
    }
  }
  return out;
}

/**
 * @param {{students:any[], events:any[], now?:number, range?:string, who?:string, day?:string, withPeople?:boolean}} o
 */
function computeAudience({
  students,
  events,
  now = Date.now(),
  range,
  who,
  day,
  withPeople = false,
}) {
  const r = RANGES[range] ? range : "today";
  const w = WHO.includes(who) ? who : "all";
  const today = dayKey(now);
  // A specific past day (any date the founder picks) replaces the rolling range.
  const pickedDay =
    /^\d{4}-\d{2}-\d{2}$/.test(String(day)) && day <= today ? String(day) : "";
  const days = pickedDay ? 1 : RANGES[r];
  const endKey = pickedDay || today;
  const startKey = shiftKey(endKey, -(days - 1));
  const prevEnd = shiftKey(startKey, -1);
  const prevStart = shiftKey(startKey, -days);

  // ---- accounts ----
  const acc = accountsIn(students, startKey, endKey);
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

  // ---- visitors without an account ----
  const web = browsers(events, ownerMap(students));
  const sinceKey = Number.isFinite(web.since) ? dayKey(web.since) : "";
  const visitorsIn = (a, b) => {
    if (!sinceKey || b < sinceKey) return null; // not recorded back then
    const people = idsIn(web.human, a, b);
    const nw = people.filter(([id]) => web.first.get(id) >= a).length;
    return { new: nw, returning: people.length - nw, total: people.length };
  };
  const visitors = visitorsIn(startKey, endKey);
  // "Did nothing": seen since counting began, never observed acting in the window.
  const quiet =
    visitors && idsIn(web.after, startKey, endKey).length - visitors.total;
  // Days with no visitor number: everything seen, people and bots together.
  const mixed = visitors ? null : idsIn(web.before, startKey, endKey).length;
  // Only compare against a window that was counted from start to finish.
  const prevVisitors =
    sinceKey && prevStart > sinceKey ? visitorsIn(prevStart, prevEnd) : null;

  // ---- last 7 days, one row per day ----
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const k = shiftKey(today, -i);
    const v = visitorsIn(k, k);
    daily.push({
      day: k,
      newAccounts: students.filter((s) => keyOf(s.signup_date) === k).length,
      visitors: v && v.total,
    });
  }

  // Days are logged per student from the moment this shipped; before that only
  // each student's latest visit is known, so older "returning" can read low.
  let trackedSince = "";
  for (const s of students) {
    const d = (s.active_days || [])[0];
    if (d && (!trackedSince || d < trackedSince)) trackedSince = d;
  }

  const out = {
    range: r,
    day: pickedDay,
    trackedSince,
    who: w,
    totalAccounts: students.length,
    accounts: {
      new: acc.new.length,
      returning: acc.returning.length,
      total: acc.new.length + acc.returning.length,
    },
    visitors,
    quiet,
    mixed,
    // Set when the shown period began before visitors could be counted.
    countingSince:
      sinceKey && startKey <= sinceKey ? new Date(web.since).toISOString() : "",
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

module.exports = {
  computeAudience,
  ownerMap,
  browsers,
  dayKey,
  RANGES,
  WHO,
  TZ,
};
