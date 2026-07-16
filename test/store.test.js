'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store');

const NAME = `__test_${process.pid}`;
const file = path.join(store.DATA_DIR, `${NAME}.json`);
after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

test('init creates the file with a fallback and read returns it', () => {
  const v = store.init(NAME, { n: 1 });
  assert.deepEqual(v, { n: 1 });
  assert.ok(fs.existsSync(file));
});

test('write persists immediately and updates the cache', async () => {
  await store.write(NAME, { n: 2 });
  assert.equal(store.read(NAME).n, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 2);
});

test('writeDebounced updates cache immediately; flushAll persists', () => {
  store.writeDebounced(NAME, { n: 3 }, 10_000);
  assert.equal(store.read(NAME).n, 3, 'cache updated synchronously');
  store.flushAll();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 3, 'flushed to disk');
});
