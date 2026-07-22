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

test('GET / permanently redirects to the public directory (the homepage IS the product)', async () => {
  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/discover');
});

test('GET /discover is public and server-rendered — no auth wall, no redirect', async () => {
  const res = await fetch(base + '/discover', { redirect: 'manual' }); // no cookies at all
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Discover universities in Europe/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /Same Start\. Equal Chance\./); // slim signup banner in the SSR snapshot
});

test('GET /for-universities serves the B2B page (mission + claim form)', async () => {
  const r = await req('GET', '/for-universities');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>For universities/);
  assert.match(r.text, /id="mission"/);
  assert.match(r.text, /id="claim"/);
  assert.match(r.text, /id="uni-form"/);
});

test('university profile pages stay public for anonymous visitors (SEO surface)', async () => {
  const anyId = (await req('GET', '/api/universities?limit=1')).json.universities[0].id;
  const res = await fetch(`${base}/university/${anyId}`); // no cookies
  assert.equal(res.status, 200);
  assert.match(await res.text(), /rel="canonical"/);
});

test('the dataset is Europe-only and every record carries region:europe', async () => {
  const r = await req('GET', '/api/universities?limit=200');
  assert.ok(r.json.universities.every((u) => u.region === 'europe'));
  const filters = await req('GET', '/api/universities/filters');
  assert.ok(!filters.json.countries.includes('United States'));
  assert.ok(!filters.json.countries.includes('Japan'));
  assert.ok(filters.json.countries.includes('Germany'));
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

test('register stores the product-updates opt-in when given', async () => {
  const email = `optin_${Date.now()}@example.com`;
  const reg = await req('POST', '/api/auth/register', {
    full_name: 'Opt In', email, password: 'password123', consent: true, updates_optin: true,
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.student.updates_optin, true);
  await req('DELETE', '/api/me'); // clean up
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
  const before = store.read('pilot_leads').length;
  const r = await req('POST', '/api/pilot-leads', {
    contact_name: 'Totally Real Person',
    work_email: `bot_${Date.now()}@example.edu`,
    university_name: 'Spam University',
    company_website: 'http://spam.example', // a real bot fills every field it finds
  });
  assert.equal(r.status, 201); // never reveal the trap was tripped
  assert.equal(store.read('pilot_leads').length, before); // ...but nothing was actually stored
});

test('GET /join permanently redirects to the B2B page (waitlist long retired)', async () => {
  const res = await fetch(base + '/join', { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/for-universities');
});

test('the verified filter narrows results to the complete-profile tier', async () => {
  const all = await req('GET', '/api/universities?limit=1');
  const ver = await req('GET', '/api/universities?verified=1&limit=200');
  assert.ok(ver.json.count > 0, 'verified tier is non-empty');
  assert.ok(ver.json.count < all.json.count, 'verified tier is a strict subset');
  assert.ok(ver.json.universities.every((u) => u.verified === true));
});

test('GET /api/universities/filters exposes verified/total counts', async () => {
  const r = await req('GET', '/api/universities/filters');
  assert.ok(r.json.counts.verified > 0);
  assert.ok(r.json.counts.total > r.json.counts.verified);
});
