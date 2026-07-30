'use strict';

/**
 * Builds the combined university dataset from three sources, deduped by web host:
 *
 *   1. curated  (40)      — hand-built, richest: tuition, programs, requirements…
 *   2. ETER     (~3,400)  — European register: city, coords, enrollment, type…
 *   3. global   (~10,000) — worldwide list: name, country, website only
 *
 * Priority (highest wins on a domain clash): curated > ETER > global. So a
 * university that appears in several sources is kept once, at its richest.
 * Sources 2 and 3 are optional — if their seed files haven't been generated yet
 * (`npm run import:eter` / `npm run import:global`) the app still runs with what
 * is present.
 */

const fs = require('fs');
const path = require('path');

const curated = require('../data/seed/universities');
const estimates = require('./estimates');
const scholarships = require('./scholarships');
const manifest = require('./manifest');
const dataQuality = require('./data-quality');
const { canonicalCountry, isEU, isEuropeanScope } = require('./countries');
const { canonicalFields, inferFieldsFromName } = require('./fields');
const { applyNameFixes, httpsify, AMBIGUOUS_REVIEW } = require('./name-fixes');
const { citySizeCategory } = require('./geo');

// Curated data has no import manifest (it's hand-written, not fetched) — stamp
// it with the date this set was last reviewed/edited.
const CURATED_LAST_REVIEWED = '2026-07-16';

// Normalised institution name for joining rankings (must match import-rankings.js).
const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Loose country compatibility so a ranking row isn't attached to a same-named
// university in a different country.
const CTRY_ALIAS = { usa: 'united states', 'united states of america': 'united states', uk: 'united kingdom', 'south korea': 'korea republic of', 'russia': 'russian federation' };
const ctryKey = (c) => { const k = String(c || '').toLowerCase().replace(/[^a-z ]/g, '').trim(); return CTRY_ALIAS[k] || k; };
function countriesCompatible(a, b) {
  if (!a || !b) return true;
  return ctryKey(a) === ctryKey(b);
}

function loadJson(file) {
  const p = path.join(__dirname, '..', 'data', 'seed', file);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`[dataset] Could not parse ${file}:`, e.message);
    return [];
  }
}

// Normalised web host (without www) — the dedup key across sources.
function hostKey(u) {
  const raw = u.domain || u.website || u.application_link || '';
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(raw).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

/**
 * Merge priority layers (highest first). Dedup is CROSS-source only: a
 * lower-priority record is dropped when its host was already claimed by a
 * higher-priority source (same university, richer copy kept). Records are NOT
 * deduped within a source — distinct institutions that legitimately share a
 * domain (a faculty + its parent, multiple campuses) are all kept, so we don't
 * silently lose real universities.
 *
 * Host matching alone is NOT sufficient — sources record different domains for
 * the same institution (ETER lists "au.dk", the global list "bachelor.au.dk",
 * a curated record its application URL), which let ~65 real duplicates
 * through. A second pass (dedupeByNameCountry below) catches those.
 * @param {Array<Array<object>>} layers  ordered highest → lowest priority
 */
function mergeSources(layers) {
  const claimed = new Set();
  const result = [];
  for (const layer of layers) {
    const hostsThisLayer = [];
    for (const u of layer) {
      const key = hostKey(u);
      if (key && claimed.has(key)) continue; // duplicate of a higher-priority source
      result.push(u);
      if (key) hostsThisLayer.push(key);
    }
    // Claim this layer's hosts only after it's fully added, so intra-layer
    // domain clashes survive but the next (lower) layer still dedups against them.
    for (const h of hostsThisLayer) claimed.add(h);
  }
  return result;
}

// Source priority for the name+country dedup pass (lower number wins).
const SOURCE_RANK = { curated: 0, eter: 1, global: 2 };

/**
 * Second dedup pass: collapse records that share a normalized name + country,
 * keeping the highest-priority source (curated > ETER > global). Returns the
 * survivors plus a { droppedId: survivorId } map so the server can 301 old
 * profile URLs instead of 404ing them — links already shared or indexed keep
 * working.
 */
function dedupeByNameCountry(merged) {
  const byKey = new Map(); // normName|country -> surviving record
  for (const u of merged) {
    const key = `${normName(u.name)}|${u.country}`;
    const cur = byKey.get(key);
    if (!cur || (SOURCE_RANK[u.source] ?? 9) < (SOURCE_RANK[cur.source] ?? 9)) byKey.set(key, u);
  }
  const redirects = {};
  const kept = [];
  for (const u of merged) {
    const winner = byKey.get(`${normName(u.name)}|${u.country}`);
    if (winner === u) kept.push(u);
    else redirects[u.id] = winner.id;
  }
  return { kept, redirects };
}

// Redirect map from the most recent buildDataset() run. Derived data, like the
// dataset itself — deterministic per boot, never persisted.
let LAST_REDIRECTS = {};
const slugRedirects = () => LAST_REDIRECTS;

/** Attach CWUR world + national rank to matching universities (by name+country). */
function applyRankings(universities, rankings) {
  if (!rankings || !Object.keys(rankings).length) return;
  for (const u of universities) {
    const rk = rankings[normName(u.name)];
    if (rk && countriesCompatible(u.country, rk.country)) {
      u.ranking = { world_rank: rk.world_rank, national_rank: rk.national_rank, provider: 'CWUR', year: rk.year };
    }
  }
}

/**
 * Strip data-source artifacts from institution names. ETER/registry names keep
 * honorific quote conventions ('"Agora" University of Oradea') that read as
 * display bugs to anyone who doesn't know the convention.
 */
function cleanName(name) {
  return String(name || '').replace(/["“”„]/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Human description for register-sourced records. The imported one-liners read
 * like a database dump ("University in X, founded Y. Around N students
 * enrolled."); rebuild them here (not at import time) so improving the phrasing
 * never requires re-hitting the ETER API.
 */
function describeEter(u) {
  const kind = u.legal_status === 'Public' ? 'public' : u.legal_status ? u.legal_status.toLowerCase() : '';
  const type = (u.institution_type || 'university').replace('Other institution', 'higher-education institution');
  const where = [u.city, u.country].filter(Boolean).join(', ');
  let s = `A ${[kind, type.toLowerCase()].filter(Boolean).join(' ')} in ${where}`;
  if (u.founded) s += `, established ${u.founded}`;
  s += '.';
  if (u.student_count) s += ` Home to around ${Number(u.student_count).toLocaleString('en-US')} students.`;
  return s;
}

// ---------------------------------------------------------------------------
// Verified tier
// ---------------------------------------------------------------------------
// The default Discover view shows only "verified profiles": hand-curated
// records plus the largest EU institutions whose profile is complete in the
// official ETER register (website, city, enrollment, founding year). Everything
// else stays searchable behind an explicit "include directory listings" toggle
// — a first impression of a few hundred real, complete profiles beats a wall
// of 12k thin records.
//
// "Verified" here means the PROFILE (institution, location, enrollment, type —
// official register facts). It does NOT override the per-fact estimate flags:
// tuition/requirements remain marked as country-level estimates wherever they
// are one. That distinction is the app's core honesty rule — don't collapse it.
const VERIFIED_CAP = 300; // curated + top ETER records, total

function assignVerifiedTier(merged) {
  const curatedCount = merged.filter((u) => u.source === 'curated').length;
  const eligible = merged
    .filter((u) => u.source === 'eter' && isEU(u.country)
      && u.website && u.city && u.student_count && u.founded)
    .sort((a, b) => b.student_count - a.student_count)
    .slice(0, Math.max(0, VERIFIED_CAP - curatedCount));
  const cut = new Set(eligible.map((u) => u.id));
  for (const u of merged) u.verified = u.source === 'curated' || cut.has(u.id);
}

function buildDataset() {
  const curatedTagged = curated.map((c) => ({ source: 'curated', ...c }));
  let merged = mergeSources([curatedTagged, loadJson('eter-universities.json'), loadJson('global-universities.json')]);

  // Normalise country spelling FIRST — sources disagree ("Czechia" vs "Czech
  // Republic", "Vietnam" vs "Viet Nam"), which would otherwise silently split
  // one country into two filter buckets and break EU-membership checks.
  for (const u of merged) u.country = canonicalCountry(u.country);

  // Europe-only scope: the platform ships EU/EEA + UK + Switzerland today.
  // Rows outside that set are dropped HERE (after canonicalisation, so a
  // "Czech Republic"-spelled row isn't accidentally lost), and every kept
  // record carries region:'europe' — global expansion later means widening
  // this filter and adding region values, not migrating the schema.
  merged = merged.filter((u) => isEuropeanScope(u.country));
  for (const u of merged) u.region = 'europe';

  // Correct truncated/ambiguous register names BEFORE the name-based dedup, so
  // a corrected name that now matches another record gets collapsed properly
  // and the uniqueness assertion below actually covers the fixed names.
  applyNameFixes(merged, hostKey);
  // Outbound links to https (the register stores ~2,700 as plain http).
  for (const u of merged) {
    u.website = httpsify(u.website);
    u.application_link = httpsify(u.application_link);
  }

  // Collapse same-institution records the host dedup missed (different domains
  // recorded per source). The uniqueness assertion below is the forward guard:
  // a future import reintroducing duplicates fails loudly at boot, not
  // silently in production.
  const deduped = dedupeByNameCountry(merged);
  merged = deduped.kept;
  LAST_REDIRECTS = deduped.redirects;
  {
    const seen = new Set();
    for (const u of merged) {
      const key = `${normName(u.name)}|${u.country}`;
      if (seen.has(key)) throw new Error(`[dataset] duplicate university after dedup: ${key}`);
      seen.add(key);
    }
  }
  // Clean name artifacts and regenerate register-sourced descriptions.
  for (const u of merged) {
    u.name = cleanName(u.name);
    if (u.name_native) u.name_native = cleanName(u.name_native);
    if (u.source === 'eter') u.short_description = describeEter(u);
  }

  // Real rankings where they exist…
  applyRankings(merged, loadJson('rankings.json'));
  // …and country-level estimates to fill tuition/living/language gaps (flagged).
  for (const u of merged) estimates.enrich(u);
  // Auditable provenance for every tuition figure. Only 'curated_research'
  // numbers are DISPLAYED as figures — estimate-filled ranges stay internal
  // (they still power the budget filter as a discovery heuristic) while the
  // UI shows "check official site" instead of a number nobody verified.
  for (const u of merged) {
    u.tuition_source = u.source === 'curated' ? 'curated_research'
      : u.tuition_range && u.tuition_range.estimated ? 'country_estimate'
      : u.tuition_range ? 'source_data'
      : 'unknown';
  }

  // ---- Program-level fields for matching -----------------------------------
  // These are what let the matcher produce a SPECIFIC reason instead of
  // institution trivia. Curated records are `confirmed`; everything else is
  // `inferred` (mapped taxonomy, or a conservative name guess) — inferred data
  // only ever feeds soft scoring, never a hard filter (see lib/match.js).
  for (const u of merged) {
    const mapped = canonicalFields(u.fields_of_study);
    if (mapped.length) {
      u.fields_offered = mapped;
      u.field_source = u.source === 'curated' ? 'confirmed' : 'inferred';
    } else {
      u.fields_offered = inferFieldsFromName(u.name); // may be []
      u.field_source = 'inferred';
    }
    // Structured, comparable tuition mirrors of the display range.
    u.tuition_intl_min = u.tuition_range ? (u.tuition_range.min ?? null) : null;
    u.tuition_intl_max = u.tuition_range ? (u.tuition_range.max ?? null) : null;
    u.city_size_category = citySizeCategory(u);
  }
  // …and named national/EU scholarship pointers (real programs, not amounts).
  for (const u of merged) u.scholarships = scholarships.scholarshipsFor(u.country);

  assignVerifiedTier(merged);

  // Freshness stamp — when THIS record's data was actually fetched/reviewed,
  // not "today". Shown on every profile so students can judge how current the
  // numbers are (a stale ranking or price presented as current is the single
  // fastest way to lose trust — see README's data-accuracy section).
  const man = manifest.read();
  for (const u of merged) {
    u.data_fetched_at = u.source === 'curated'
      ? CURATED_LAST_REVIEWED
      : (man[u.source]?.fetched_at || null);

    // Explicit provenance/trust metadata (brief requirement). All honest,
    // derived from real source facts — never invented:
    //   data_source        human label for where this record came from
    //   verification_status Verified | Needs Review | Unknown (by source authority)
    //   last_verified_at    when the FACTS were verified at source (ETER ref year,
    //                       curated review date) — null when the source gives none
    //   last_updated_at     when WE last imported/refreshed it (manifest fetch)
    //   stale               last verification older than the freshness window,
    //                       so the admin audit can surface it for review
    u.data_source = dataQuality.dataSourceLabel(u.source);
    u.verification_status = dataQuality.verificationStatus(u);
    u.last_verified_at = dataQuality.lastVerifiedAt(u, CURATED_LAST_REVIEWED);
    u.last_updated_at = u.data_fetched_at;
    u.stale = dataQuality.isStale(u);
  }

  return merged;
}

module.exports = { buildDataset, mergeSources, hostKey, applyRankings, cleanName, describeEter, assignVerifiedTier, VERIFIED_CAP, dedupeByNameCountry, slugRedirects };
