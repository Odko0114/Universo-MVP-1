'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dq = require('../lib/data-quality');

const FULL = {
  name: 'X', country: 'Germany', city: 'Berlin', website: 'https://x.de', founded: 1900,
  student_count: 20000, institution_type: 'University', degree_levels: ['Bachelor', 'Master'],
  fields_of_study: ['Engineering'], language_of_instruction: ['German', 'English'],
  coords: { lat: 52.5, lon: 13.4 }, short_description: 'A university.',
};

test('scoreRecord: a fully-populated record scores 100 / Excellent with no missing', () => {
  const r = dq.scoreRecord(FULL);
  assert.equal(r.score, 100);
  assert.equal(r.band, 'Excellent');
  assert.deepEqual(r.missing, []);
});

test('scoreRecord: an empty record scores 0 / Incomplete and lists every dimension missing', () => {
  const r = dq.scoreRecord({ name: 'X', country: 'Germany' });
  assert.equal(r.score, 0);
  assert.equal(r.band, 'Incomplete');
  assert.equal(r.missing.length, dq.DIMENSIONS.length);
});

test('scoreRecord: deductions are explained (missing website is worth its weight)', () => {
  const noSite = { ...FULL, website: '' };
  const r = dq.scoreRecord(noSite);
  const websiteDim = dq.DIMENSIONS.find((d) => d.key === 'website');
  assert.equal(r.score, 100 - websiteDim.weight);
  assert.ok(r.missing.some((m) => m.key === 'website'));
});

test('bandFor thresholds', () => {
  assert.equal(dq.bandFor(90), 'Excellent');
  assert.equal(dq.bandFor(70), 'Good');
  assert.equal(dq.bandFor(50), 'Needs Improvement');
  assert.equal(dq.bandFor(20), 'Incomplete');
});

test('verificationStatus is honest by source authority', () => {
  assert.equal(dq.verificationStatus({ source: 'curated' }), 'Verified');
  assert.equal(dq.verificationStatus({ source: 'eter' }), 'Verified');
  assert.equal(dq.verificationStatus({ source: 'global' }), 'Unknown');
});

test('lastVerifiedAt uses real provenance, never invents a date', () => {
  assert.equal(dq.lastVerifiedAt({ source: 'curated' }, '2026-07-16'), '2026-07-16');
  assert.equal(dq.lastVerifiedAt({ source: 'eter', ref_year: 2022 }), '2022-01-01');
  assert.equal(dq.lastVerifiedAt({ source: 'global' }), null, 'no source date → null, not fabricated');
});

test('isStale: an ETER record behind the latest available ref year is stale; at latest it is not', () => {
  const latest = dq.SOURCE_LATEST_REFYEAR.eter;
  assert.equal(dq.isStale({ source: 'eter', ref_year: latest - 1 }), true, 'a newer snapshot exists → refreshable');
  assert.equal(dq.isStale({ source: 'eter', ref_year: latest }), false, 'already on the newest ETER snapshot');
  // Undated/community sources are surfaced via verification_status=Unknown, not
  // as "stale" — there is no newer versioned snapshot to refresh them to.
  assert.equal(dq.isStale({ source: 'global' }), false);
  assert.equal(dq.isStale({ source: 'curated' }), false);
});

test('auditDataset aggregates distribution, status, staleness and missing counts', () => {
  const list = [
    { ...FULL, source: 'curated', verification_status: 'Verified', stale: false, tuition_source: 'curated_research' },
    { name: 'Y', country: 'Spain', source: 'eter', verification_status: 'Verified', stale: true, tuition_source: 'country_estimate' },
    { name: 'Z', country: 'Italy', source: 'global', verification_status: 'Unknown', stale: true },
  ];
  const a = dq.auditDataset(list);
  assert.equal(a.count, 3);
  assert.equal(a.by_status.Verified, 2);
  assert.equal(a.by_status.Unknown, 1);
  assert.equal(a.stale_count, 2);
  assert.equal(a.researched_tuition, 1);
  assert.ok(a.average_score >= 0 && a.average_score <= 100);
  assert.ok(Array.isArray(a.structurally_unavailable) && a.structurally_unavailable.length > 0);
  // most-missing field is ranked first
  assert.ok(a.missing_fields[0].missing >= a.missing_fields[a.missing_fields.length - 1].missing);
});

test('performance: audits the full ~4,000-record dataset well under a second', () => {
  const { buildDataset } = require('../lib/dataset');
  const list = buildDataset();
  assert.ok(list.length > 3000, 'sanity: real dataset loaded');
  const t0 = Date.now();
  const a = dq.auditDataset(list);
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `audit took ${ms}ms — should be well under 500ms for one boot-time pass`);
  assert.equal(a.count, list.length);
  // Every record got honest metadata during the build.
  assert.ok(list.every((u) => u.data_source && u.verification_status && 'last_verified_at' in u));
});
