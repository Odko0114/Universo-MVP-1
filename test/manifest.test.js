'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const manifest = require('../lib/manifest');

test('assertQuality throws when the record count is below the minimum', () => {
  assert.throws(
    () => manifest.assertQuality([{ name: 'a' }], { source: 'x', minCount: 10, requireField: 'name' }),
    /sanity check failed/,
  );
});

test('assertQuality throws when too many records are missing the required field', () => {
  const records = [{ name: 'a' }, { name: '' }, {}, {}, {}]; // 1/5 = 20% have `name`
  assert.throws(
    () => manifest.assertQuality(records, { source: 'x', minCount: 1, requireField: 'name', minFieldRatio: 0.9 }),
    /only 20\.0%/,
  );
});

test('assertQuality passes when count and field coverage are both healthy', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ name: `u${i}` }));
  assert.doesNotThrow(() => manifest.assertQuality(records, { source: 'x', minCount: 5, requireField: 'name' }));
});

// write()/read() touch the real manifest.json (there's no injectable path) —
// back up whatever is there, use a throwaway source key, and always restore.
test('write() then read() round-trips fetched_at, count, checksum and extra fields', () => {
  const original = fs.existsSync(manifest.FILE) ? fs.readFileSync(manifest.FILE, 'utf8') : null;
  try {
    const entry = manifest.write('__test_source__', [{ a: 1 }, { a: 2 }], { ref_year: 2099 });
    assert.equal(entry.count, 2);
    assert.equal(entry.ref_year, 2099);
    assert.ok(entry.checksum);
    assert.ok(Date.parse(entry.fetched_at)); // valid ISO timestamp

    const reread = manifest.read();
    assert.deepEqual(reread.__test_source__, entry);
  } finally {
    if (original !== null) fs.writeFileSync(manifest.FILE, original);
    else if (fs.existsSync(manifest.FILE)) fs.unlinkSync(manifest.FILE);
  }
});

test('write() with the same records produces the same checksum (deterministic)', () => {
  const original = fs.existsSync(manifest.FILE) ? fs.readFileSync(manifest.FILE, 'utf8') : null;
  try {
    const a = manifest.write('__test_source__', [{ a: 1 }]);
    const b = manifest.write('__test_source__', [{ a: 1 }]);
    assert.equal(a.checksum, b.checksum);
  } finally {
    if (original !== null) fs.writeFileSync(manifest.FILE, original);
    else if (fs.existsSync(manifest.FILE)) fs.unlinkSync(manifest.FILE);
  }
});

test('read() returns an empty object when no manifest file exists', () => {
  const original = fs.existsSync(manifest.FILE) ? fs.readFileSync(manifest.FILE, 'utf8') : null;
  try {
    if (fs.existsSync(manifest.FILE)) fs.unlinkSync(manifest.FILE);
    assert.deepEqual(manifest.read(), {});
  } finally {
    if (original !== null) fs.writeFileSync(manifest.FILE, original);
  }
});
