'use strict';

/**
 * Imports a global list of universities (~10,000 across ~200 countries) from the
 * open Hipolabs "world universities and domains" dataset and writes it to
 * data/seed/global-universities.json as app-shaped records.
 *
 * Source: https://github.com/Hipo/university-domains-list (public/open data)
 *
 * Run with:  npm run import:global
 *
 * Notes / caveats (see README):
 *  - This dataset is a name + country + website/domain list. It has NO city,
 *    enrollment, tuition, programs, or type. European records get enriched from
 *    the richer ETER import at build time (see lib/dataset.js); the rest show
 *    country + website only. Logos derive from the domain; cover photos come
 *    lazily from Wikipedia.
 *  - It is community-maintained public data — names/domains are generally good
 *    but unverified. Every record carries data_verified:false.
 */

const fs = require('fs');
const path = require('path');
const manifest = require('../lib/manifest');

const SOURCE_URL = process.env.GLOBAL_UNIS_URL
  || 'https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json';

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(url.includes('://') ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function run() {
  console.log(`[import-global] Fetching global universities from Hipolabs…`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Source returned ${res.status}`);
  const rows = await res.json();
  console.log(`[import-global] Received ${rows.length} universities.`);

  const out = [];
  const usedIds = new Set();

  for (const r of rows) {
    const name = (r.name || '').trim();
    if (!name) continue;

    const website = (r.web_pages && r.web_pages[0]) || '';
    const domain = (r.domains && r.domains[0]) || hostOf(website);
    if (!domain) continue; // no domain => no logo, no dedup key; skip

    // Stable, unique id derived from the domain.
    let id = `g-${slug(domain)}`;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    const region = (r['state-province'] || '').trim();
    const country = (r.country || '').trim() || 'Unknown';

    out.push({
      id,
      source: 'global',
      name,
      country,
      country_code: r.alpha_two_code || '',
      region,
      city: '', // Hipolabs has no city (only state/province, kept as `region`)
      website: website || `https://${domain}`,
      domain,
      institution_type: '',
      legal_status: '',
      founded: null,
      student_count: null,
      coords: null,
      programs_offered: [],
      degree_levels: [],
      language_of_instruction: [],
      fields_of_study: [],
      tuition_range: null,
      estimated_living_cost: null,
      application_deadline: '',
      acceptance_requirements: '',
      application_link: website || `https://${domain}`,
      short_description: `University in ${region ? region + ', ' : ''}${country}.`,
      click_count: 0,
      data_verified: false,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));

  // Fail loudly if the source shrank drastically or lost its domains.
  manifest.assertQuality(out, { source: 'global', minCount: 8000, requireField: 'domain' });

  const target = path.join(__dirname, '..', 'data', 'seed', 'global-universities.json');
  fs.writeFileSync(target, JSON.stringify(out, null, 2));
  manifest.write('global', out, { source_url: SOURCE_URL });

  console.log(`[import-global] Wrote ${out.length} records to ${path.relative(process.cwd(), target)}`);
  console.log(`[import-global]   countries: ${new Set(out.map((r) => r.country)).size}`);
}

run().catch((e) => {
  console.error('[import-global] FAILED:', e.message);
  process.exit(1);
});
