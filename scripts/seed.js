'use strict';

/**
 * Seeds data/universities.json from the combined dataset (curated + ETER).
 *
 * Runs automatically on server start if the file is missing (see server.js).
 * Run manually with `npm run seed` (adds --force to overwrite existing data,
 * which resets click_count values). Refresh the ETER portion with
 * `npm run import:eter` first if you want the latest register data.
 */

const fs = require('fs');
const path = require('path');

const { buildDataset } = require('../lib/dataset');
const seed = buildDataset();

const DATA_DIR = path.join(__dirname, '..', 'data');
const target = path.join(DATA_DIR, 'universities.json');
const force = process.argv.includes('--force');

function run() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(target) && !force) {
    console.log(`[seed] ${path.relative(process.cwd(), target)} already exists — skipping (use --force to overwrite).`);
    return;
  }

  fs.writeFileSync(target, JSON.stringify(seed, null, 2));
  const by = seed.reduce((m, u) => ((m[u.source || 'curated'] = (m[u.source || 'curated'] || 0) + 1), m), {});
  const parts = ['curated', 'eter', 'global'].filter((s) => by[s]).map((s) => `${by[s]} ${s}`).join(' + ');
  console.log(`[seed] Wrote ${seed.length} universities (${parts}) to ${path.relative(process.cwd(), target)}${force ? ' (forced overwrite)' : ''}.`);
}

run();
