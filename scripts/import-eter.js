'use strict';

/**
 * Imports the full public ETER dataset (European Tertiary Education Register)
 * and writes it to data/seed/eter-universities.json as app-shaped records.
 *
 * Source: ETER v4 API — POST https://eter-project.com/api/4.0/HEIs/query/flattened
 *   body: { filter: <mongo query>, fieldIds: [...], searchTerms: [] }
 *
 * Run with:  npm run import:eter        (defaults to reference year 2022)
 *            npm run import:eter -- 2021 (override the year)
 *
 * Notes / caveats (see README):
 *  - ETER is a *statistical register*. It has NO images and NONE of the app's
 *    comparison fields (tuition, programs, admission requirements, application
 *    links, language of instruction, degree levels). Imported records therefore
 *    carry those fields empty; the UI hides the sections it can't fill.
 *  - Logos are derived at render time from each institution's website domain.
 *    Cover photos are fetched lazily from Wikipedia (see server.js).
 *  - Records are deduplicated against the 40 hand-curated universities by web
 *    domain and normalised name, so curated entries (with rich data) win.
 */

const fs = require('fs');
const path = require('path');
const curated = require('../data/seed/universities');
const manifest = require('../lib/manifest');

// Default to the newest ETER reference year known to be published (2023 as of
// 2026-07; 2024 not yet available). Override with `npm run import:eter -- 2024`
// once ETER releases it. Keep in sync with lib/data-quality.js SOURCE_LATEST_REFYEAR.
const YEAR = Number(process.argv[2]) || 2023;
const API = 'https://eter-project.com/api/4.0/HEIs/query/flattened';

// Field-of-education (ISCED-F) buckets → friendly "field of study" names.
const FOE = {
  '01': 'Education', '02': 'Arts & Humanities', '03': 'Social Sciences',
  '04': 'Business & Law', '05': 'Natural Sciences', '06': 'Computer Science & IT',
  '07': 'Engineering & Technology', '08': 'Agriculture & Veterinary',
  '09': 'Medicine & Health', '10': 'Services & Hospitality',
};
const FOE_CODES = Object.keys(FOE);

const FIELD_IDS = [
  'BAS.ETERID', 'BAS.INSTNAMEENGL', 'BAS.INSTNAME', 'BAS.ACRONYM',
  'BAS.COUNTRY', 'BAS.INSTCATENGL', 'BAS.INSTCATSTAND', 'BAS.LEGALSTAT',
  'BAS.FOUNDYEAR', 'BAS.WEBSITE', 'GEO.CITY', 'GEO.COORDLAT', 'GEO.COORDLON',
  'STUD.TOTALISCED5_7', 'STUD.ISCED6TOTAL', 'STUD.ISCED7TOTAL',
  // Bachelor (ISCED6) + Master (ISCED7) enrollment by field of education.
  ...FOE_CODES.map((c) => `STUD.ISCED6FOE${c}`),
  ...FOE_CODES.map((c) => `STUD.ISCED7FOE${c}`),
];

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

// Real degree levels from which ISCED levels have enrolled students (+ PhD for
// doctorate-granting universities).
function degreeLevels(r, standType) {
  const levels = [];
  if (num(r['STUD.ISCED6TOTAL'])) levels.push('Bachelor');
  if (num(r['STUD.ISCED7TOTAL'])) levels.push('Master');
  if (standType === 'University' && levels.length) levels.push('PhD');
  return levels;
}

// Real broad fields from the ISCED-F enrollment distribution (Bachelor+Master).
// Keep a field only if it's a meaningful share, so we list what a school
// actually teaches at scale rather than every trace enrollment.
function fieldsOfStudy(r) {
  const totals = {};
  let grand = 0;
  for (const c of FOE_CODES) {
    const n = num(r[`STUD.ISCED6FOE${c}`]) + num(r[`STUD.ISCED7FOE${c}`]);
    totals[c] = n; grand += n;
  }
  if (!grand) return [];
  const threshold = Math.max(40, grand * 0.03);
  return FOE_CODES
    .filter((c) => totals[c] >= threshold)
    .sort((a, b) => totals[b] - totals[a])
    .map((c) => FOE[c]);
}

const COUNTRY = {
  AD: 'Andorra', AL: 'Albania', AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria',
  CH: 'Switzerland', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany', DK: 'Denmark',
  EE: 'Estonia', EL: 'Greece', ES: 'Spain', FI: 'Finland', FR: 'France',
  GB: 'United Kingdom', GR: 'Greece', HR: 'Croatia', HU: 'Hungary', IE: 'Ireland',
  IS: 'Iceland', IT: 'Italy', LI: 'Liechtenstein', LT: 'Lithuania', LU: 'Luxembourg',
  LV: 'Latvia', ME: 'Montenegro', MK: 'North Macedonia', MT: 'Malta', NL: 'Netherlands',
  NO: 'Norway', PL: 'Poland', PT: 'Portugal', RO: 'Romania', RS: 'Serbia',
  SE: 'Sweden', SI: 'Slovenia', SK: 'Slovakia', TR: 'Türkiye', UK: 'United Kingdom',
  XK: 'Kosovo',
};

// ETER standardised institution category (BAS.INSTCATSTAND).
// Verified against the detailed BAS.INSTCATENGL labels: 1 = doctorate-granting
// universities (e.g. Heidelberg), 2 = universities of applied sciences,
// 0 = other/specialised institutions (arts, theology, education, vocational…).
const STAND_TYPE = { 1: 'University', 2: 'University of Applied Sciences', 0: 'Other institution' };
// ETER legal status (BAS.LEGALSTAT).
const LEGAL = { 0: 'Public', 1: 'Private government-dependent', 2: 'Private' };

// --- helpers ---------------------------------------------------------------

function domainOf(url) {
  if (!url) return '';
  try {
    const host = new URL(url.includes('://') ? url : `http://${url}`).hostname;
    return host.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

// Strict normalised name: lowercase, strip accents/punctuation, keep every word
// (so "University of Freiburg" stays distinct from "Freiburg University of Music").
const normName = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function normalizeWebsite(url) {
  if (!url) return '';
  let u = String(url).trim();
  // ETER uses single-letter/short flags for missing data ("m", "x", "a", "c",
  // "nc", "s"…). A real website always contains a dot — anything without one is
  // a missing marker, not a URL.
  if (!u.includes('.')) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function describe(rec) {
  const bits = [];
  bits.push(rec.institution_type || 'Higher education institution');
  bits.push(`in ${rec.city}, ${rec.country}`);
  let s = bits.join(' ');
  if (rec.founded) s += `, founded ${rec.founded}`;
  s += '.';
  if (rec.student_count) s += ` Around ${rec.student_count.toLocaleString('en-US')} students enrolled.`;
  return s;
}

async function fetchYear(year) {
  const body = JSON.stringify({ filter: { 'BAS.REFYEAR.v': year }, fieldIds: FIELD_IDS, searchTerms: [] });
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`ETER API returned ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.data || data.results || []);
}

// --- main ------------------------------------------------------------------

async function run() {
  console.log(`[import-eter] Fetching ETER HEIs for reference year ${YEAR}…`);
  let rows = await fetchYear(YEAR);
  if (!rows.length) {
    console.log(`[import-eter] No rows for ${YEAR}, retrying ${YEAR - 1}…`);
    rows = await fetchYear(YEAR - 1);
  }
  console.log(`[import-eter] Received ${rows.length} institutions.`);

  // Build dedup index from curated set (exact web host + strict full name).
  // Full-host equality avoids public-suffix over-matching (e.g. every UK
  // institution sharing "ac.uk"); curated wins because it has rich fields.
  const curatedDomains = new Set();
  const curatedNames = new Set();
  for (const c of curated) {
    const d = domainOf(c.application_link);
    if (d) curatedDomains.add(d);
    curatedNames.add(normName(c.name));
  }

  const out = [];
  let skippedDup = 0;
  let skippedNoName = 0;

  for (const r of rows) {
    const eterid = r['BAS.ETERID'];
    const name = r['BAS.INSTNAMEENGL'] || r['BAS.INSTNAME'];
    if (!eterid || !name) { skippedNoName++; continue; }

    const website = normalizeWebsite(r['BAS.WEBSITE']);
    const domain = domainOf(website);
    const nm = normName(name);

    // Dedup against curated data (curated wins — it has rich fields).
    if ((domain && curatedDomains.has(domain)) || (nm && curatedNames.has(nm))) {
      skippedDup++;
      continue;
    }

    const code = r['BAS.COUNTRY'];
    const lat = r['GEO.COORDLAT'];
    const lon = r['GEO.COORDLON'];
    const founded = Number.isFinite(r['BAS.FOUNDYEAR']) ? r['BAS.FOUNDYEAR'] : null;
    const students = Number.isFinite(r['STUD.TOTALISCED5_7']) && r['STUD.TOTALISCED5_7'] > 0
      ? Math.round(r['STUD.TOTALISCED5_7']) : null;
    const nativeName = r['BAS.INSTNAME'];

    const rec = {
      id: `eter-${String(eterid).toLowerCase()}`,
      eter_id: eterid,
      source: 'eter',
      ref_year: YEAR,
      name,
      name_native: nativeName && nativeName !== name ? nativeName : '',
      acronym: r['BAS.ACRONYM'] || '',
      country: COUNTRY[code] || code || 'Europe',
      country_code: code || '',
      city: r['GEO.CITY'] || '',
      coords: (typeof lat === 'number' && typeof lon === 'number') ? { lat, lon } : null,
      website,
      domain,
      institution_type: STAND_TYPE[r['BAS.INSTCATSTAND']] || 'Other institution',
      institution_category: r['BAS.INSTCATENGL'] || '',
      legal_status: LEGAL[r['BAS.LEGALSTAT']] || '',
      founded,
      student_count: students,
      // Real degree levels + broad fields, derived from ETER enrollment data.
      programs_offered: [],
      degree_levels: degreeLevels(r, STAND_TYPE[r['BAS.INSTCATSTAND']] || 'Other institution'),
      fields_of_study: fieldsOfStudy(r),
      // Language / tuition are filled with country estimates at build time.
      language_of_instruction: [],
      tuition_range: null,
      estimated_living_cost: null,
      application_deadline: '',
      acceptance_requirements: '',
      // Apply-Now falls back to the official website (ETER has no application link).
      application_link: website,
      click_count: 0,
      data_verified: false,
    };
    rec.short_description = describe(rec);
    out.push(rec);
  }

  out.sort((a, b) => a.name.localeCompare(b.name));

  // Fail loudly if the upstream shape changed and produced junk.
  manifest.assertQuality(out, { source: 'eter', minCount: 2500, requireField: 'name' });

  const target = path.join(__dirname, '..', 'data', 'seed', 'eter-universities.json');
  fs.writeFileSync(target, JSON.stringify(out, null, 2));
  manifest.write('eter', out, { ref_year: YEAR, source_api: API });

  console.log(`[import-eter] Wrote ${out.length} records to ${path.relative(process.cwd(), target)}`);
  console.log(`[import-eter]   deduped against curated: ${skippedDup} | skipped (no id/name): ${skippedNoName}`);
  const byType = out.reduce((m, r) => ((m[r.institution_type] = (m[r.institution_type] || 0) + 1), m), {});
  console.log('[import-eter]   by type:', JSON.stringify(byType));
  console.log(`[import-eter]   countries: ${new Set(out.map((r) => r.country)).size}`);
}

run().catch((e) => {
  console.error('[import-eter] FAILED:', e.message);
  process.exit(1);
});
