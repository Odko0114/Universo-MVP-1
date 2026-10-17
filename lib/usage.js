"use strict";

/**
 * Usage numbers for the admin "Usage" screen — plain counts, no cohorts.
 *
 * Everything here answers one question: "what should I curate next?" So the
 * emphasis is on DEMAND (what students search for, which universities they save)
 * and on UNMET demand (searches that found little or nothing).
 *
 * Privacy: events carry a random anonymous id and filter choices — never a name
 * or email. Account aggregates (summarizeAccounts) are counts only.
 */

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

const BUDGET_BANDS = [
  { key: "to3", label: "Up to €3k", max: 3000 },
  { key: "to6", label: "€3k – €6k", max: 6000 },
  { key: "to12", label: "€6k – €12k", max: 12000 },
  { key: "to20", label: "€12k – €20k", max: 20000 },
  { key: "over", label: "Over €20k", max: Infinity },
];
const bandOf = (n) => BUDGET_BANDS.find((b) => n <= b.max);

/**
 * What a list request tells us about what the student looked for. Values are
 * checked against the real filter vocabulary so junk can't pollute the log.
 * Returns null when the request carried no real search intent (a bare page load).
 *
 * @param {Record<string, any>} query  req.query
 * @param {{countries?:Set<string>, fields?:Set<string>, degrees?:Set<string>, languages?:Set<string>}} [vocab]
 */
function searchMeta(query, vocab = {}) {
  const q = query || {};
  const one = (v, set) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s && (!set || set.has(s)) ? s : "";
  };
  const list = (v, set, max) =>
    String(typeof v === "string" ? v : "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && (!set || set.has(x)))
      .slice(0, max);

  const country =
    one(q.country, vocab.countries) ||
    list(q.fitCountry, vocab.countries, 1)[0] ||
    "";
  const fields = q.field
    ? [one(q.field, vocab.fields)].filter(Boolean)
    : list(q.fitFields, vocab.fields, 3);
  const degree =
    one(q.degree, vocab.degrees) || one(q.fitDegree, vocab.degrees);
  const language =
    one(q.language, vocab.languages) ||
    list(q.fitLang, vocab.languages, 1)[0] ||
    "";
  const b = Number(q.maxTuition || q.fitBudget);
  const budget = Number.isFinite(b) && b > 0 && b <= 200000 ? Math.round(b) : 0;
  // Fewer than 3 characters is a half-typed word, not a search.
  const text =
    typeof q.q === "string" && q.q.trim().length >= 3
      ? q.q.trim().slice(0, 80)
      : "";

  if (!text && !country && !fields.length && !degree && !language && !budget)
    return null;
  const meta = {};
  if (text) meta.q = text;
  if (country) meta.country = country;
  if (fields.length) meta.field = fields.join("|");
  if (degree) meta.degree = degree;
  if (language) meta.language = language;
  if (budget) meta.budget = budget;
  return meta;
}

function tally(map, key, n = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + n);
}
const top = (map, limit) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit);

const METRICS = [
  "visitors",
  "accounts",
  "verified",
  "searches",
  "saves",
  "applyClicks",
  "plans",
  "scholarships",
  "compares",
  "deletions",
];

/**
 * @param {object[]} events
 * @param {{ now?: number, weeks?: number, listDays?: number }} [opts]
 */
function computeUsage(
  events,
  { now = Date.now(), weeks = 8, listDays = 30 } = {},
) {
  const series = Object.fromEntries(
    METRICS.map((m) => [m, new Array(weeks).fill(0)]),
  );
  const visitorSets = Array.from({ length: weeks }, () => new Set());
  const planSets = Array.from({ length: weeks }, () => new Set());

  const fields = new Map();
  const countries = new Map();
  const degrees = new Map();
  const budgets = new Map();
  const saved = new Map();
  const viewed = new Map();
  const applied = new Map();
  const gaps = new Map();
  let searchTotal = 0;
  let searchZero = 0;
  let searchLow = 0;

  const listSince = now - listDays * DAY;

  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t > now) continue;
    const age = now - t;
    const w = age < weeks * WEEK ? weeks - 1 - Math.floor(age / WEEK) : -1;

    if (w >= 0) {
      switch (e.type) {
        case "pageview":
        case "profile_view":
          if (e.anon) visitorSets[w].add(e.anon);
          break;
        case "signup":
          series.accounts[w]++;
          break;
        case "email_verified":
          series.verified[w]++;
          break;
        case "search":
          series.searches[w]++;
          break;
        case "save":
          series.saves[w]++;
          break;
        case "apply_click":
          series.applyClicks[w]++;
          break;
        case "application_status":
        case "application_update":
          if (e.anon) planSets[w].add(e.anon);
          break;
        case "scholarship":
          series.scholarships[w]++;
          break;
        case "compare":
          series.compares[w]++;
          break;
        case "account_delete":
          series.deletions[w]++;
          break;
        default:
      }
    }

    if (t < listSince) continue;

    if (e.type === "search") {
      searchTotal++;
      const r = Number.isFinite(e.results) ? e.results : null;
      if (r === 0) searchZero++;
      if (r !== null && r <= 2) searchLow++;
      for (const f of String(e.field || "").split("|")) tally(fields, f);
      tally(countries, e.country);
      tally(degrees, e.degree);
      if (e.budget) tally(budgets, bandOf(Number(e.budget)).key);

      // Unmet demand: a search that found almost nothing.
      if (
        r !== null &&
        r <= 2 &&
        (e.q || e.field || e.country || e.degree || e.language || e.budget)
      ) {
        const g = {
          q: e.q ? String(e.q).toLowerCase() : "",
          field: e.field || "",
          country: e.country || "",
          degree: e.degree || "",
          language: e.language || "",
          // The exact ceiling they set: "Finland under €4,000" is a different
          // gap from "Finland" — and it's the one that says what data to add.
          budget: Number(e.budget) || 0,
        };
        const key = JSON.stringify(g);
        const cur = gaps.get(key) || { ...g, count: 0, results: r };
        cur.count++;
        cur.results = Math.min(cur.results, r);
        gaps.set(key, cur);
      }
    } else if (e.type === "filter_used") {
      // Legacy events (recorded before searches carried their filters).
      if (e.filter === "field") tally(fields, e.value);
      else if (e.filter === "country") tally(countries, e.value);
      else if (e.filter === "degree") tally(degrees, e.value);
    } else if (e.type === "save" && e.uni) tally(saved, e.uni);
    else if (e.type === "profile_view" && e.uni) tally(viewed, e.uni);
    else if (e.type === "apply_click" && e.uni) tally(applied, e.uni);
  }

  for (let i = 0; i < weeks; i++) {
    series.visitors[i] = visitorSets[i].size;
    series.plans[i] = planSets[i].size;
  }
  const at = (i) => Object.fromEntries(METRICS.map((m) => [m, series[m][i]]));

  return {
    weeks,
    series,
    current: at(weeks - 1),
    previous: weeks > 1 ? at(weeks - 2) : at(weeks - 1),
    lists: {
      days: listDays,
      fields: top(fields, 6).map(([name, count]) => ({ name, count })),
      countries: top(countries, 6).map(([name, count]) => ({ name, count })),
      degrees: top(degrees, 4).map(([name, count]) => ({ name, count })),
      budgets: BUDGET_BANDS.map((b) => ({
        name: b.label,
        count: budgets.get(b.key) || 0,
      })),
      savedUnis: top(saved, 6).map(([id, count]) => ({ id, count })),
      viewedUnis: top(viewed, 6).map(([id, count]) => ({ id, count })),
      appliedUnis: top(applied, 6).map(([id, count]) => ({ id, count })),
    },
    searchQuality: { total: searchTotal, zero: searchZero, low: searchLow },
    gaps: [...gaps.values()]
      .sort((a, b) => b.count - a.count || a.results - b.results)
      .slice(0, 8),
  };
}

/**
 * Account aggregates — counts only, never who. `students` is the stored list.
 * @param {object[]} students
 * @param {number} [now]
 */
function summarizeAccounts(students, now = Date.now()) {
  const list = Array.isArray(students) ? students : [];
  const homes = new Map();
  const display = new Map();
  let verified = 0;
  let profiled = 0;
  let saved = 0;
  let planning = 0;
  let last7 = 0;
  let last7Unverified = 0;
  for (const s of list) {
    if (s.email_verified) verified++;
    if (
      (s.fields_of_interest || []).length ||
      s.degree_level ||
      s.budget_max_eur_year != null
    )
      profiled++;
    if ((s.saved_universities || []).length) saved++;
    if (Object.keys(s.applications || {}).length) planning++;
    if (now - Date.parse(s.signup_date) < WEEK) {
      last7++;
      // New accounts still waiting to verify: if this piles up, emails aren't arriving.
      if (!s.email_verified) last7Unverified++;
    }
    const home = String(s.home_country || s.country_of_origin || "").trim();
    if (home) {
      const k = home.toLowerCase();
      if (!display.has(k)) display.set(k, home);
      tally(homes, k);
    }
  }
  const given = [...homes.values()].reduce((a, b) => a + b, 0);
  return {
    total: list.length,
    verified,
    profiled,
    saved,
    planning,
    last7,
    last7Unverified,
    homeCountries: top(homes, 8).map(([k, count]) => ({
      name: display.get(k),
      count,
    })),
    homeNotGiven: list.length - given,
  };
}

module.exports = { searchMeta, computeUsage, summarizeAccounts, BUDGET_BANDS };
