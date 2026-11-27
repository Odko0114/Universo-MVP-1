"use strict";

/**
 * All-time picture for the admin: how many people, what they did, where they stop.
 * Pure — events and students in, counts out (no names, no emails).
 *
 * `visitors`: browsers without an account where a person was observed acting,
 * counted from the first such signal (null until then). `browsers`: every
 * browser without an account ever seen — bots included, so not a head count.
 */

const { ownerMap, browsers, dayKey } = require("./audience");

const DAY = 24 * 60 * 60 * 1000;
const ACTIONS = {
  searches: ["search"],
  profileViews: ["profile_view"],
  saves: ["save"],
  compares: ["compare"],
  applyClicks: ["apply_click"],
  planUpdates: ["application_status", "application_update"],
  scholarships: ["scholarship"],
  logins: ["login"],
};
const ACTION_OF = new Map(
  Object.entries(ACTIONS).flatMap(([k, types]) => types.map((t) => [t, k])),
);

/** @param {{events:any[], students:any[], now?:number, months?:number}} o */
function computeOverall({ events, students, now = Date.now(), months = 12 }) {
  const zero = () =>
    Object.fromEntries(Object.keys(ACTIONS).map((k) => [k, 0]));
  const total = zero();
  const last30 = zero();
  const prev30 = zero();
  let first = Infinity;

  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t > now) continue;
    if (t < first) first = t;
    const action = ACTION_OF.get(e.type);
    if (action) {
      total[action]++;
      if (now - t < 30 * DAY) last30[action]++;
      else if (now - t < 60 * DAY) prev30[action]++;
    }
  }

  const past = events.filter((e) => Date.parse(e.ts) <= now);
  const web = browsers(past, ownerMap(students));

  // ---- students ----
  const started = (s) =>
    Object.values(s.applications || {}).some(
      (a) => a && a.status && a.status !== "planning",
    );
  const visitDays = (s) =>
    new Set(
      [s.signup_date, s.last_active_date]
        .filter((x) => Number.isFinite(Date.parse(x)))
        .map((x) => dayKey(x))
        .concat(s.active_days || []),
    );
  const activeIn = (d) => {
    const from = dayKey(now - (d - 1) * DAY);
    const to = dayKey(now);
    return students.filter((s) =>
      [...visitDays(s)].some((k) => k >= from && k <= to),
    ).length;
  };
  const saved = students.filter((s) => (s.saved_universities || []).length);
  const st = {
    total: students.length,
    verified: students.filter((s) => s.email_verified).length,
    saved: saved.length,
    started: students.filter(started).length,
    active1: activeIn(1),
    active7: activeIn(7),
    active30: activeIn(30),
    cameBack: students.filter((s) => visitDays(s).size > 1).length,
    joined30: students.filter((s) => now - Date.parse(s.signup_date) < 30 * DAY)
      .length,
    savedPerStudent: saved.length
      ? Math.round(
          (saved.reduce((n, s) => n + s.saved_universities.length, 0) /
            saved.length) *
            10,
        ) / 10
      : 0,
  };

  // ---- growth by month (calendar months, founder's time zone) ----
  const monthOf = (x) => dayKey(x).slice(0, 7);
  const start = Math.min(
    first,
    ...students
      .map((s) => Date.parse(s.signup_date))
      .filter((t) => Number.isFinite(t)),
  );
  const growth = [];
  if (Number.isFinite(start)) {
    let [y, m] = monthOf(now).split("-").map(Number);
    const firstMonth = monthOf(start);
    for (let i = 0; i < months; i++) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      if (key < firstMonth) break;
      growth.unshift({ month: key, students: 0, totalStudents: 0 });
      if (--m === 0) {
        m = 12;
        y--;
      }
    }
    const by = new Map(growth.map((g) => [g.month, g]));
    for (const s of students) {
      if (!Number.isFinite(Date.parse(s.signup_date))) continue;
      const k = monthOf(s.signup_date);
      if (by.has(k)) by.get(k).students++;
      for (const g of growth) if (k <= g.month) g.totalStudents++;
    }
  }

  return {
    since: Number.isFinite(start) ? new Date(start).toISOString() : null,
    browsers: web.first.size,
    visitors: Number.isFinite(web.since)
      ? { count: web.human.size, since: new Date(web.since).toISOString() }
      : null,
    students: st,
    usage: { total, last30, prev30 },
    funnel: [
      { key: "students", label: "Made an account", count: st.total },
      { key: "verified", label: "Verified their email", count: st.verified },
      { key: "saved", label: "Saved a university", count: st.saved },
      { key: "started", label: "Started an application", count: st.started },
    ],
    growth,
  };
}

module.exports = { computeOverall };
