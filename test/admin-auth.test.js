'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');
const store = require('../lib/store');
const adminAuth = require('../lib/admin-auth');

let server, base;
const jar = {};
const email = `admin_test_${Date.now()}@example.com`;
const password = 'a very strong test password';

function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function stash(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
}
async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  stash(res);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await adminAuth.createAdmin(email, password); // seed directly — same in-process store the server reads
});

after(async () => {
  // Clean up the test admin so repeated local runs don't accumulate rows.
  const admins = store.read('admins').filter((a) => a.email !== email);
  await store.write('admins', admins);
  server && server.close();
});

test('GET /api/admin/me without a session is 401', async () => {
  const r = await req('GET', '/api/admin/me');
  assert.equal(r.status, 401);
});

test('GET /api/admin/stats without a session is 401 (dashboard data is protected)', async () => {
  const r = await req('GET', '/api/admin/stats');
  assert.equal(r.status, 401);
});

test('POST /api/admin/login rejects a wrong password', async () => {
  const r = await req('POST', '/api/admin/login', { email, password: 'not the password' });
  assert.equal(r.status, 401);
});

test('POST /api/admin/login rejects an unknown email without leaking which emails exist', async () => {
  const r = await req('POST', '/api/admin/login', { email: 'nope@example.com', password: 'whatever12345' });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'Incorrect email or password.');
});

test('POST /api/admin/login with correct credentials sets a session cookie', async () => {
  const r = await req('POST', '/api/admin/login', { email, password });
  assert.equal(r.status, 200);
  assert.equal(r.json.admin.email, email);
  assert.ok(jar.uv_admin, 'admin session cookie set');
});

test('GET /api/admin/me now succeeds with the session cookie', async () => {
  const r = await req('GET', '/api/admin/me');
  assert.equal(r.status, 200);
  assert.equal(r.json.admin.email, email);
});

test('GET /api/admin/stats succeeds and returns the expected shape', async () => {
  const r = await req('GET', '/api/admin/stats');
  assert.equal(r.status, 200);
  assert.ok(typeof r.json.totals.universities === 'number');
  assert.ok(Array.isArray(r.json.top_universities_by_apply_clicks));
});

test('GET /api/admin/funnel and /api/admin/retention are reachable with a session', async () => {
  const f = await req('GET', '/api/admin/funnel?days=7');
  assert.equal(f.status, 200);
  assert.equal(f.json.stages.length, 5);

  const r = await req('GET', '/api/admin/retention?weeks=4');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.cohorts));
});

test('a student session cannot access admin routes', async () => {
  // Register a student in a fresh cookie jar (simulated by clearing uv_admin only).
  delete jar.uv_admin;
  const reg = await req('POST', '/api/auth/register', {
    full_name: 'Not An Admin', email: `student_${Date.now()}@example.com`, password: 'password123', consent: true,
  });
  assert.equal(reg.status, 201);
  const r = await req('GET', '/api/admin/stats'); // has uv_token but no uv_admin
  assert.equal(r.status, 401);
  await req('DELETE', '/api/me'); // cleanup the student account
});

test('POST /api/admin/logout clears the session', async () => {
  await req('POST', '/api/admin/login', { email, password });
  const out = await req('POST', '/api/admin/logout');
  assert.equal(out.status, 200);
  const me = await req('GET', '/api/admin/me');
  assert.equal(me.status, 401);
});
