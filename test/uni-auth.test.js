'use strict';

/**
 * University-partner accounts: the claim flow and — most importantly — the
 * server-side scoping guarantee (this stack's row-level security): a partner
 * session can only ever read its OWN university's analytics, no matter what
 * the client sends.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');
const store = require('../lib/store');
const adminAuth = require('../lib/admin-auth');
const events = require('../lib/events');

let server, base;
const adminEmail = `uniauth_admin_${Date.now()}@example.com`;
const adminPassword = 'a very strong test password';
const emailA = `partner_a_${Date.now()}@example.edu`;
const emailB = `partner_b_${Date.now()}@example.edu`;
const partnerPassword = 'partner password 123';
const TEST_ANON = `uniauth-test-anon-${Date.now()}`;

// Three separate cookie jars: admin, partner A, partner B.
const jars = { admin: {}, a: {}, b: {} };
function header(jar) { return Object.entries(jars[jar]).map(([k, v]) => `${k}=${v}`).join('; '); }
async function req(jar, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: header(jar) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) { const [kv] = c.split(';'); const i = kv.indexOf('='); jars[jar][kv.slice(0, i)] = kv.slice(i + 1); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

let uniA, uniB;

before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await adminAuth.createAdmin(adminEmail, adminPassword);
  const login = await req('admin', 'POST', '/api/admin/login', { email: adminEmail, password: adminPassword });
  assert.equal(login.status, 200);

  const two = await req('admin', 'GET', '/api/universities?limit=2');
  [uniA, uniB] = two.json.universities;
});

after(async () => {
  // Remove everything this file created: partner accounts, claims, the test
  // admin, and the synthetic analytics events.
  await store.write('uni_accounts', store.read('uni_accounts').filter((a) => ![emailA, emailB].includes(a.email)));
  const claims = { ...store.read('claims') };
  delete claims[uniA.id]; delete claims[uniB.id];
  await store.write('claims', claims);
  await store.write('admins', store.read('admins').filter((a) => a.email !== adminEmail));
  await events.purgeAnon([TEST_ANON]);
  server && server.close();
});

test('universities are unclaimed by default', async () => {
  const r = await req('admin', 'GET', `/api/universities/${uniA.id}`);
  assert.equal(r.json.university.claimed_status, 'unclaimed');
});

test('admin creates a partner account, which marks the university claimed', async () => {
  const r = await req('admin', 'POST', '/api/admin/uni-accounts', {
    email: emailA, password: partnerPassword, university_id: uniA.id,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.university.claimed_status, 'claimed');
  assert.equal('password_hash' in r.json.account, false, 'no hash leaked');

  const check = await req('admin', 'GET', `/api/universities/${uniA.id}`);
  assert.equal(check.json.university.claimed_status, 'claimed');
});

test('creating a partner account requires an admin session', async () => {
  const r = await req('a', 'POST', '/api/admin/uni-accounts', {
    email: 'nope@example.edu', password: 'whatever12345', university_id: uniB.id,
  });
  assert.equal(r.status, 401);
});

test('partner stats require a session and are scoped to the session university only', async () => {
  const anon = await fetch(base + '/api/uni/stats');
  assert.equal(anon.status, 401);

  // Synthetic engagement for university A only.
  events.record('profile_view', { uni: uniA.id, anon: TEST_ANON });
  events.record('save', { uni: uniA.id, anon: TEST_ANON });
  await events.flush();

  const loginA = await req('a', 'POST', '/api/uni/login', { email: emailA, password: partnerPassword });
  assert.equal(loginA.status, 200);

  const statsA = await req('a', 'GET', '/api/uni/stats?days=30');
  assert.equal(statsA.status, 200);
  assert.equal(statsA.json.university.id, uniA.id);
  assert.ok(statsA.json.totals.views >= 1);
  assert.ok(statsA.json.totals.saves >= 1);
  assert.equal(statsA.json.series.length, 30);

  // Partner B exists too — and can NOT see A's numbers, even when the client
  // tries to ask for them explicitly: the query param is simply ignored.
  const mk = await req('admin', 'POST', '/api/admin/uni-accounts', { email: emailB, password: partnerPassword, university_id: uniB.id });
  assert.equal(mk.status, 201);
  await req('b', 'POST', '/api/uni/login', { email: emailB, password: partnerPassword });
  const statsB = await req('b', 'GET', `/api/uni/stats?days=30&university_id=${encodeURIComponent(uniA.id)}`);
  assert.equal(statsB.json.university.id, uniB.id, 'client-supplied id is ignored — session decides');
  assert.equal(statsB.json.totals.views, 0, "B sees none of A's events");
});

test('a duplicate partner email is rejected', async () => {
  const r = await req('admin', 'POST', '/api/admin/uni-accounts', {
    email: emailA, password: partnerPassword, university_id: uniB.id,
  });
  assert.equal(r.status, 400);
});
