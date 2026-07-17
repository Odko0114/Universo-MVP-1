'use strict';

/**
 * File-based JSON store for the MVP.
 *
 * Each "collection" is a single JSON file under /data. Reads are served from an
 * in-memory cache; writes are serialized per-file and flushed atomically
 * (write temp file + rename) so a crash mid-write can't corrupt the data file.
 *
 * Two write modes:
 *   write(name, value)          — persist now (chained per file)
 *   writeDebounced(name, ...)   — coalesce rapid writes into one flush, so hot
 *                                 paths (last-active touches, click counts) don't
 *                                 rewrite a file on every request.
 * flushAll() persists pending debounced writes synchronously — call it on
 * shutdown so in-flight changes aren't lost.
 *
 * This is deliberately simple. It is a genuine repository seam: the app only
 * touches init/read/write/writeDebounced, so swapping this for SQLite/Postgres
 * is a localized change. Note the ceilings: single-process only, whole-collection
 * serialization, and a host with an ephemeral filesystem will not persist data
 * across restarts — move to a database before real traffic.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Runtime data lives here (accounts, clicks, events, photo cache…). In
// production this should point at a persistent volume via UNIVERSO_DATA_DIR —
// most PaaS hosts wipe the app filesystem on every deploy, and mounting the
// volume at the repo's own data/ would hide the seed files baked into the
// image. Seed data (data/seed/*) is deliberately NOT under this env var: it's
// read-only input that ships with the code (see lib/dataset.js).
const DATA_DIR = process.env.UNIVERSO_DATA_DIR || path.join(__dirname, '..', 'data');

const cache = new Map();        // name -> parsed JSON
const writeChains = new Map();  // name -> Promise (serializes writes per file)
const dirty = new Set();        // names with unpersisted debounced changes
const timers = new Map();       // name -> pending flush timer

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function init(name, fallback) {
  ensureDataDir();
  const p = filePath(name);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(fallback, null, 2));
    cache.set(name, fallback);
  } else {
    cache.set(name, JSON.parse(fs.readFileSync(p, 'utf8')));
  }
  return cache.get(name);
}

/**
 * Like init(), but always replaces the on-disk file with `value`. For DERIVED
 * collections only (e.g. the universities dataset, rebuilt from seed files at
 * every boot) — using init() for those would let a stale copy on a persistent
 * volume shadow fresh seed data forever after a deploy. Never use this for
 * user-generated collections (students, clicks, events): it would wipe them.
 */
function initFresh(name, value) {
  ensureDataDir();
  fs.writeFileSync(filePath(name), JSON.stringify(value, null, 2));
  cache.set(name, value);
  return value;
}

function read(name) {
  if (!cache.has(name)) {
    throw new Error(`Collection "${name}" not initialised. Call store.init() first.`);
  }
  return cache.get(name);
}

function write(name, value) {
  cache.set(name, value);
  dirty.delete(name); // this write supersedes any pending debounced flush
  const p = filePath(name);
  const tmp = `${p}.${process.pid}.tmp`;

  const prev = writeChains.get(name) || Promise.resolve();
  const next = prev
    .catch(() => {}) // don't let an earlier failure break the chain
    .then(async () => {
      await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
      await fsp.rename(tmp, p);
    });

  writeChains.set(name, next);
  return next;
}

/**
 * Coalesce writes: update the cache immediately but persist at most once per
 * `delay`. Multiple mutations within the window collapse into a single disk flush.
 */
function writeDebounced(name, value, delay = 1500) {
  cache.set(name, value);
  dirty.add(name);
  if (timers.has(name)) return;
  const t = setTimeout(() => {
    timers.delete(name);
    if (dirty.has(name)) { dirty.delete(name); write(name, cache.get(name)); }
  }, delay);
  t.unref?.();
  timers.set(name, t);
}

/** Persist all pending debounced changes synchronously (for graceful shutdown). */
function flushAll() {
  for (const [name, t] of timers) clearTimeout(t);
  timers.clear();
  for (const name of dirty) {
    try {
      fs.writeFileSync(filePath(name), JSON.stringify(cache.get(name), null, 2));
    } catch { /* best effort on shutdown */ }
  }
  dirty.clear();
}

module.exports = { init, initFresh, read, write, writeDebounced, flushAll, DATA_DIR };
