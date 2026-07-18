'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');
const store = require('../lib/store');

let server, base;
const jar = {};

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
  return { status: res.status, json, text, headers: res.headers };
}

before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('GET /healthz reports ok', async () => {
  const r = await req('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
  assert.ok(r.json.universities > 0);
});

test('GET /api/universities paginates', async () => {
  const r = await req('GET', '/api/universities?limit=5');
  assert.equal(r.status, 200);
  assert.equal(r.json.universities.length, 5);
  assert.ok(r.json.count > 5);
  assert.equal(r.json.has_more, true);
});

test('GET /api/universities/filters returns facets', async () => {
  const r = await req('GET', '/api/universities/filters');
  assert.ok(Array.isArray(r.json.countries));
  assert.ok(r.json.institution_types.length >= 1);
});

test('GET / serves the marketing landing page for anonymous visitors', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Universo/);
  assert.match(r.text, /Sign up free/);
});

test('GET /discover bounces anonymous visitors to sign-up (the app is account-gated)', async () => {
  const res = await fetch(base + '/discover', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/account\?mode=register/);
});

test('GET /discover is server-rendered for a logged-in student', async () => {
  const email = `disc_${Date.now()}@example.com`;
  const reg = await req('POST', '/api/auth/register', { full_name: 'Discover Test', email, password: 'password123', consent: true });
  assert.equal(reg.status, 201);

  const r = await req('GET', '/discover');
  assert.match(r.text, /<title>Discover universities abroad/);
  assert.match(r.text, /rel="canonical"/);

  await req('DELETE', '/api/me'); // clean up
});

test('university profile pages stay public for anonymous visitors (SEO surface)', async () => {
  const anyId = (await req('GET', '/api/universities?limit=1')).json.universities[0].id;
  const res = await fetch(`${base}/university/${anyId}`); // no cookies
  assert.equal(res.status, 200);
  assert.match(await res.text(), /rel="canonical"/);
});

test('/ stays reachable (200, not a redirect) for a logged-in visitor', async () => {
  // The landing page used to force-redirect logged-in visitors straight into
  // /discover — which meant there was no way to ever see it again once
  // you'd signed in even once. It's a real page for both audiences now; the
  // page itself swaps its CTAs client-side based on auth state.
  const email = `landing_${Date.now()}@example.com`;
  const reg = await req('POST', '/api/auth/register', { full_name: 'Landing Test', email, password: 'password123', consent: true });
  assert.equal(reg.status, 201);

  const res = await fetch(base + '/', { headers: { Cookie: cookieHeader() }, redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Study in Europe/);

  await req('DELETE', '/api/me'); // clean up the test account
});

test('GET /robots.txt references the sitemap', async () => {
  const r = await req('GET', '/robots.txt');
  assert.match(r.text, /Sitemap:/);
});

test('unknown API route 404s as JSON', async () => {
  const r = await req('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Not found.');
});

test('auth round-trip: register → me → save → export → delete', async () => {
  const email = `test_${Date.now()}@example.com`;

  const reg = await req('POST', '/api/auth/register', { full_name: 'Test User', email, password: 'password123', consent: true });
  assert.equal(reg.status, 201);
  assert.ok(jar.uv_token, 'auth cookie set');
  assert.equal('password_hash' in reg.json.student, false, 'no password hash leaked');

  const me = await req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.student.email, email);

  const anyId = (await req('GET', '/api/universities?limit=1')).json.universities[0].id;
  const save = await req('POST', `/api/me/saved/${anyId}`);
  assert.deepEqual(save.json.saved_universities, [anyId]);

  const exp = await req('GET', '/api/me/export');
  assert.equal(exp.json.account.email, email);

  const del = await req('DELETE', '/api/me');
  assert.equal(del.status, 200);
  const meGone = await req('GET', '/api/auth/me');
  assert.equal(meGone.status, 401); // session cleared + account gone
});

test('register requires consent', async () => {
  const r = await req('POST', '/api/auth/register', { full_name: 'X Y', email: `n_${Date.now()}@e.com`, password: 'password123', consent: false });
  assert.equal(r.status, 400);
});

test('POST /api/waitlist accepts a valid email and is idempotent on resubmit', async () => {
  const email = `waitlist_${Date.now()}@example.com`;
  const first = await req('POST', '/api/waitlist', { email });
  assert.equal(first.status, 201);
  const second = await req('POST', '/api/waitlist', { email }); // same email again
  assert.equal(second.status, 201); // no error — just doesn't duplicate the entry
});

test('POST /api/waitlist rejects an invalid email', async () => {
  const r = await req('POST', '/api/waitlist', { email: 'not-an-email' });
  assert.equal(r.status, 400);
});

test('POST /api/pilot-leads requires name, work email and university name', async () => {
  const missing = await req('POST', '/api/pilot-leads', { contact_name: 'A B' });
  assert.equal(missing.status, 400);

  const ok = await req('POST', '/api/pilot-leads', {
    contact_name: 'Admissions Lead',
    work_email: `pilot_${Date.now()}@example.edu`,
    university_name: 'Test University',
    country: 'Finland',
  });
  assert.equal(ok.status, 201);
});

test('a filled honeypot field is accepted (looks like success) but not persisted', async () => {
  const before = store.read('waitlist').length;
  const r = await req('POST', '/api/waitlist', {
    email: `bot_${Date.now()}@example.com`,
    company_website: 'http://spam.example', // a real bot fills every field it finds
  });
  assert.equal(r.status, 201); // never reveal the trap was tripped
  assert.equal(store.read('waitlist').length, before); // ...but nothing was actually stored
});

test('GET /join serves the built pitch page when present', async () => {
  const r = await req('GET', '/join');
  // The join-app build is a separate step (npm run build:join) — if it hasn't
  // run, the route responds 503 rather than crashing; either is a valid state
  // for this test to assert on, but a 200 must be the real built page.
  assert.ok([200, 503].includes(r.status));
  if (r.status === 200) assert.match(r.text, /<div id="root">/);
});
