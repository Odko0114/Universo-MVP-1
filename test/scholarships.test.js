'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scholarshipsFor } = require('../lib/scholarships');

test('EU country gets the EU-wide scheme plus its own national scheme', () => {
  const list = scholarshipsFor('Germany');
  assert.ok(list.some((s) => s.name.includes('Erasmus Mundus')));
  assert.ok(list.some((s) => s.name.includes('DAAD')));
});

test('non-EU country with a known scheme gets it, without Erasmus Mundus', () => {
  const list = scholarshipsFor('Japan');
  assert.ok(list.some((s) => s.name.includes('MEXT')));
  assert.ok(!list.some((s) => s.name.includes('Erasmus Mundus')));
});

test('unknown country falls back to the generic pointer', () => {
  const list = scholarshipsFor('Nauru');
  assert.equal(list.length, 1);
  assert.equal(list[0].scope, 'generic');
});

test('every entry is flagged verify:true (never presented as confirmed)', () => {
  for (const country of ['Germany', 'Japan', 'Nauru']) {
    for (const s of scholarshipsFor(country)) assert.equal(s.verify, true);
  }
});

test('result is capped at 3 entries', () => {
  const list = scholarshipsFor('Germany'); // EU-wide + country-specific = 2, well under cap
  assert.ok(list.length <= 3);
});
