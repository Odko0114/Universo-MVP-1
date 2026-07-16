'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const estimates = require('../lib/estimates');
const { applyRankings } = require('../lib/dataset');

test('estimates fill missing tuition/living/language and flag them', () => {
  const u = estimates.enrich({ country: 'Germany' });
  assert.equal(u.tuition_range.estimated, true);
  assert.equal(u.estimated_living_cost.estimated, true);
  assert.ok(u.language_of_instruction.includes('German'));
  assert.equal(u.language_estimated, true);
});

test('estimates never overwrite real (curated) values', () => {
  const real = { min: 2500, max: 2500, currency: 'EUR', period: 'year' };
  const u = estimates.enrich({ country: 'Netherlands', tuition_range: real, language_of_instruction: ['English'] });
  assert.equal(u.tuition_range, real);          // untouched
  assert.equal(u.tuition_range.estimated, undefined);
  assert.deepEqual(u.language_of_instruction, ['English']);
  assert.equal(u.language_estimated, undefined);
});

test('unknown country falls back to a default band', () => {
  const u = estimates.enrich({ country: 'Neverland' });
  assert.ok(u.tuition_range.min >= 0 && u.tuition_range.max > u.tuition_range.min);
});

test('rankings attach only on name + compatible country', () => {
  const unis = [
    { name: 'Harvard University', country: 'United States' },
    { name: 'Harvard University', country: 'Germany' }, // same name, wrong country
    { name: 'Nowhere College', country: 'United States' },
  ];
  applyRankings(unis, { 'harvard university': { world_rank: 1, national_rank: 1, country: 'USA' } });
  assert.equal(unis[0].ranking.world_rank, 1);        // matched (USA ~ United States)
  assert.equal(unis[1].ranking, undefined);           // country mismatch → not attached
  assert.equal(unis[2].ranking, undefined);           // unranked
});
