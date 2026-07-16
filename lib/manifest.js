'use strict';

/**
 * Records provenance for each imported data source in data/seed/manifest.json:
 * when it was fetched, how many records, a content checksum, and any extra
 * fields (e.g. ETER reference year). Gives us data versioning and a paper trail.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'seed', 'manifest.json');

function read() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function checksum(records) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 16);
}

function write(source, records, extra = {}) {
  const manifest = read();
  manifest[source] = {
    fetched_at: new Date().toISOString(),
    count: records.length,
    checksum: checksum(records),
    ...extra,
  };
  fs.writeFileSync(FILE, JSON.stringify(manifest, null, 2));
  return manifest[source];
}

/**
 * Guard against a silently-broken upstream: fail loudly if the fetch returned
 * far fewer records than expected or key fields are mostly empty.
 * @param {object[]} records
 * @param {{ source:string, minCount:number, requireField:string, minFieldRatio?:number }} rules
 */
function assertQuality(records, { source, minCount, requireField, minFieldRatio = 0.9 }) {
  if (records.length < minCount) {
    throw new Error(`[${source}] sanity check failed: got ${records.length} records, expected ≥ ${minCount}. Aborting so we don't ship broken data.`);
  }
  const withField = records.filter((r) => r[requireField] != null && r[requireField] !== '').length;
  const ratio = withField / records.length;
  if (ratio < minFieldRatio) {
    throw new Error(`[${source}] sanity check failed: only ${(ratio * 100).toFixed(1)}% of records have "${requireField}" (expected ≥ ${minFieldRatio * 100}%).`);
  }
}

module.exports = { read, write, assertQuality, FILE };
