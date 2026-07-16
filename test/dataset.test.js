'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeSources, hostKey } = require('../lib/dataset');

test('hostKey normalizes protocol and www', () => {
  assert.equal(hostKey({ website: 'https://www.TUM.de/en/apply' }), 'tum.de');
  assert.equal(hostKey({ domain: 'harvard.edu' }), 'harvard.edu');
  assert.equal(hostKey({}), '');
});

test('higher-priority source wins on a domain clash', () => {
  const curated = [{ id: 'cur', source: 'curated', application_link: 'https://www.tum.de/apply' }];
  const eter = [{ id: 'eter', source: 'eter', domain: 'tum.de' }];
  const global = [{ id: 'glob', source: 'global', domain: 'tum.de' }];
  const merged = mergeSources([curated, eter, global]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'cur'); // curated kept, eter+global dropped
});

test('distinct institutions sharing a domain are NOT deduped within a source', () => {
  // Real ETER case: a faculty and its parent university share one host.
  const eter = [
    { id: 'parent', source: 'eter', domain: 'uni-trier.de' },
    { id: 'faculty', source: 'eter', domain: 'uni-trier.de' },
  ];
  const merged = mergeSources([[], eter, []]);
  assert.equal(merged.length, 2); // both kept
});

test('records without a host are always kept (no false dedup)', () => {
  const eter = [
    { id: 'x', source: 'eter', domain: '' },
    { id: 'y', source: 'eter', domain: '' },
  ];
  const merged = mergeSources([[], eter, []]);
  assert.equal(merged.length, 2);
});

test('global records survive when not overlapping Europe', () => {
  const eter = [{ id: 'e', source: 'eter', domain: 'tum.de' }];
  const global = [{ id: 'g', source: 'global', domain: 'harvard.edu' }];
  const merged = mergeSources([[], eter, global]);
  assert.equal(merged.length, 2);
});
