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
const { canonicalCountry } = require('./countries');

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

function buildDataset() {
  const curatedTagged = curated.map((c) => ({ source: 'curated', ...c }));
  const merged = mergeSources([curatedTagged, loadJson('eter-universities.json'), loadJson('global-universities.json')]);

  // Normalise country spelling FIRST — sources disagree ("Czechia" vs "Czech
  // Republic", "Vietnam" vs "Viet Nam"), which would otherwise silently split
  // one country into two filter buckets and break EU-membership checks.
  for (const u of merged) u.country = canonicalCountry(u.country);

  // Real rankings where they exist…
  applyRankings(merged, loadJson('rankings.json'));
  // …and country-level estimates to fill tuition/living/language gaps (flagged).
  for (const u of merged) estimates.enrich(u);
  // …and named national/EU scholarship pointers (real programs, not amounts).
  for (const u of merged) u.scholarships = scholarships.scholarshipsFor(u.country);

  // Freshness stamp — when THIS record's data was actually fetched/reviewed,
  // not "today". Shown on every profile so students can judge how current the
  // numbers are (a stale ranking or price presented as current is the single
  // fastest way to lose trust — see README's data-accuracy section).
  const man = manifest.read();
  for (const u of merged) {
    u.data_fetched_at = u.source === 'curated'
      ? CURATED_LAST_REVIEWED
      : (man[u.source]?.fetched_at || null);
  }

  return merged;
}

module.exports = { buildDataset, mergeSources, hostKey, applyRankings };
