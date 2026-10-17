"use strict";

/**
 * What the admin "Data" screen needs to know about each record: is it a record
 * students care about, what is missing, and when did a person last confirm it.
 * Pure functions over the live dataset — no I/O.
 *
 * Scope matters. Of ~2,900 universities almost all are bare register entries
 * with estimated tuition and no deadline; flagging every one would make the
 * "needs attention" counts meaningless. So the work queue is the FEATURED set
 * (the ~300 profile-tier universities that students are actually shown in full)
 * ranked by how much students look at them.
 */

const DAY = 24 * 60 * 60 * 1000;
const STALE_MONTHS = 6;

function monthsSince(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / (30.4 * DAY) : Infinity;
}

/**
 * Interest = how much students engaged with each university in the last 90 days.
 * @param {object[]} events
 * @returns {Map<string, {views:number, saves:number, clicks:number, score:number}>}
 */
function interestIndex(events, now = Date.now(), days = 90) {
  const since = now - days * DAY;
  const m = new Map();
  const get = (id) => {
    if (!m.has(id)) m.set(id, { views: 0, saves: 0, clicks: 0, score: 0 });
    return m.get(id);
  };
  for (const e of events) {
    if (!e.uni) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t < since) continue;
    if (e.type === "profile_view") get(e.uni).views++;
    else if (e.type === "save") get(e.uni).saves++;
    else if (e.type === "apply_click") get(e.uni).clicks++;
  }
  for (const v of m.values()) v.score = v.views + v.saves * 2 + v.clicks * 3;
  return m;
}

/**
 * @param {object} u  university record (live, overrides already applied)
 * @param {string} verifiedAt  when a person last confirmed it ("" = never)
 */
function universityFlags(u, verifiedAt, now = Date.now()) {
  const t = u.tuition_range;
  const researched = u.tuition_source === "curated_research";
  return {
    featured: !!u.verified,
    missingDeadline: !u.application_deadline,
    estimatedTuition: !researched, // shows as "check the official site" to students
    stale: monthsSince(verifiedAt, now) > STALE_MONTHS,
    neverVerified: !verifiedAt,
    hasTuition: researched && !!t,
  };
}

function scholarshipFlags(s, verifiedAt, now = Date.now()) {
  const a = s.application || {};
  const dl = a.deadline || "";
  const passed = /^\d{4}-\d{2}-\d{2}$/.test(dl) && Date.parse(dl) < now;
  return {
    featured: true,
    missingDeadline: !dl && !a.deadline_note,
    deadlinePassed: passed,
    stale: monthsSince(verifiedAt, now) > STALE_MONTHS,
    neverVerified: !verifiedAt,
  };
}

/**
 * What is still missing, in plain words, most important first. Empty = nothing
 * to do. (Confirmation age is reported separately via `stale` / verified_at.)
 */
function needsFor(type, f) {
  const n = [];
  if (type === "university") {
    if (f.missingDeadline) n.push("deadline");
    if (f.estimatedTuition) n.push("tuition");
  } else if (f.deadlinePassed) n.push("a new deadline");
  else if (f.missingDeadline) n.push("deadline");
  return n;
}

const FILTERS = {
  missing_deadline: (f) => f.missingDeadline,
  estimated_tuition: (f) => f.estimatedTuition,
  stale: (f) => f.stale,
};

/**
 * @param {object} o
 * @param {object[]} o.universities
 * @param {object[]} o.scholarships
 * @param {(type:string,id:string)=>string} o.verifiedAt
 * @param {Map} o.interest
 * @param {{scope?:string,q?:string,country?:string,field?:string,filter?:string,offset?:any,limit?:any,all?:any}} [o.query]
 * @param {number} [o.now]
 */
function listRecords({
  universities,
  scholarships,
  verifiedAt,
  interest,
  query = {},
  now = Date.now(),
}) {
  const scope =
    query.scope === "all" || query.scope === "scholarships"
      ? query.scope
      : "featured";
  const q = String(query.q || "")
    .trim()
    .toLowerCase();
  const filter = FILTERS[query.filter] ? query.filter : "";
  const rows = [];

  const push = (type, rec, id, flags, extra) => {
    if (filter && !FILTERS[filter](flags)) return;
    rows.push({
      type,
      id,
      name: rec.name,
      country: rec.country || "",
      city: rec.city || "",
      interest: (interest.get(id) || { score: 0 }).score,
      verified_at: verifiedAt(type, id),
      needs: needsFor(type, flags),
      stale: flags.stale,
      ...extra,
    });
  };

  if (scope !== "scholarships") {
    for (const u of universities) {
      if (scope === "featured" && !u.verified) continue;
      if (query.country && u.country !== query.country) continue;
      if (query.field && !(u.fields_of_study || []).includes(query.field))
        continue;
      if (
        q &&
        !`${u.name} ${u.country} ${u.city || ""} ${u.acronym || ""}`
          .toLowerCase()
          .includes(q)
      )
        continue;
      push(
        "university",
        u,
        u.id,
        universityFlags(u, verifiedAt("university", u.id), now),
      );
    }
  }
  if (
    scope === "scholarships" ||
    (scope === "all" && !query.country && !query.field)
  ) {
    for (const s of scholarships) {
      if (
        q &&
        !`${s.name} ${s.country || ""} ${s.provider || ""}`
          .toLowerCase()
          .includes(q)
      )
        continue;
      push(
        "scholarship",
        s,
        s.key,
        scholarshipFlags(s, verifiedAt("scholarship", s.key), now),
      );
    }
  }

  // Most-wanted first, so the queue is "what students look at that is least complete".
  rows.sort((a, b) => b.interest - a.interest || a.name.localeCompare(b.name));
  const total = rows.length;
  const offset = Math.max(0, Number(query.offset) || 0);
  if (query.all) return { total, offset: 0, items: rows }; // spreadsheet export
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 40));
  return { total, offset, items: rows.slice(offset, offset + limit) };
}

/**
 * Headline numbers for the Data screen. `audit` is dataQuality.auditDataset().
 */
function datasetOverview({
  universities,
  scholarships,
  verifiedAt,
  audit,
  now = Date.now(),
}) {
  let featured = 0;
  let featuredVerified = 0;
  let missingDeadline = 0;
  let estimatedTuition = 0;
  let stale = 0;
  let withDeadline = 0;
  let researchedTuition = 0;
  for (const u of universities) {
    if (u.application_deadline) withDeadline++;
    if (u.tuition_source === "curated_research") researchedTuition++;
    if (!u.verified) continue;
    featured++;
    const f = universityFlags(u, verifiedAt("university", u.id), now);
    if (!f.neverVerified && !f.stale) featuredVerified++;
    if (f.missingDeadline) missingDeadline++;
    if (f.estimatedTuition) estimatedTuition++;
    if (f.stale) stale++;
  }
  let schStale = 0;
  let schNoDeadline = 0;
  for (const s of scholarships) {
    const f = scholarshipFlags(s, verifiedAt("scholarship", s.key), now);
    if (f.stale || f.deadlinePassed) schStale++;
    if (f.missingDeadline) schNoDeadline++;
  }
  return {
    total: universities.length,
    featured,
    featuredVerified,
    withDeadline,
    researchedTuition,
    missingDeadline,
    estimatedTuition,
    stale,
    scholarships: {
      total: scholarships.length,
      needCheck: schStale,
      noDeadline: schNoDeadline,
    },
    completeness: audit
      ? { avg: audit.average_score, distribution: audit.distribution }
      : null,
  };
}

module.exports = {
  interestIndex,
  universityFlags,
  scholarshipFlags,
  needsFor,
  listRecords,
  datasetOverview,
};
