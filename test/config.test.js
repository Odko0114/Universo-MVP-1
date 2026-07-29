'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');

function requireInSubprocess(modulePath, env) {
  return spawnSync(process.execPath, ['-e', `require('${modulePath}')`], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

for (const mod of ['./lib/store', './lib/events']) {
  test(`${mod} refuses to boot in production without UNIVERSO_DATA_DIR`, () => {
    const r = requireInSubprocess(mod, {
      NODE_ENV: 'production', UNIVERSO_DATA_DIR: '', UNIVERSO_JWT_SECRET: 'x'.repeat(32),
    });
    assert.notEqual(r.status, 0, 'process should exit non-zero');
    assert.match(r.stderr, /UNIVERSO_DATA_DIR must be set in production/);
  });

  test(`${mod} boots fine in production once UNIVERSO_DATA_DIR is set`, () => {
    const r = requireInSubprocess(mod, {
      NODE_ENV: 'production',
      UNIVERSO_DATA_DIR: '/tmp/universo-config-test-data-dir',
      UNIVERSO_JWT_SECRET: 'x'.repeat(32),
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test(`${mod} does not require UNIVERSO_DATA_DIR outside production`, () => {
    const r = requireInSubprocess(mod, { NODE_ENV: 'development', UNIVERSO_DATA_DIR: '' });
    assert.equal(r.status, 0, r.stderr);
  });
}

// Found during a security review of the email-verification/password-reset
// links: they must never be built from the request's spoofable Host header
// once real email is going out. Same fail-fast philosophy as the checks
// above, scoped to only matter once RESEND_API_KEY is actually set.
test('server.js refuses to boot in production once email is enabled without UNIVERSO_APP_URL', () => {
  const r = requireInSubprocess('./server', {
    NODE_ENV: 'production',
    UNIVERSO_JWT_SECRET: 'x'.repeat(32),
    UNIVERSO_DATA_DIR: '/tmp/universo-config-test-server-boot-1',
    RESEND_API_KEY: 'fake_key_for_boot_test',
    UNIVERSO_APP_URL: '',
  });
  assert.notEqual(r.status, 0, 'process should exit non-zero');
  assert.match(r.stderr, /UNIVERSO_APP_URL must be set in production/);
});

test('server.js boots fine in production with email enabled once UNIVERSO_APP_URL is set', () => {
  const r = requireInSubprocess('./server', {
    NODE_ENV: 'production',
    UNIVERSO_JWT_SECRET: 'x'.repeat(32),
    UNIVERSO_DATA_DIR: '/tmp/universo-config-test-server-boot-2',
    RESEND_API_KEY: 'fake_key_for_boot_test',
    UNIVERSO_APP_URL: 'https://universo.app',
  });
  assert.equal(r.status, 0, r.stderr);
});

test('server.js boots fine in production without UNIVERSO_APP_URL while email stays dormant', () => {
  const r = requireInSubprocess('./server', {
    NODE_ENV: 'production',
    UNIVERSO_JWT_SECRET: 'x'.repeat(32),
    UNIVERSO_DATA_DIR: '/tmp/universo-config-test-server-boot-3',
    RESEND_API_KEY: '',
    UNIVERSO_APP_URL: '',
  });
  assert.equal(r.status, 0, r.stderr);
});
