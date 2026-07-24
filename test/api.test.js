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

test('for-universities stat counters render the real number, never a bare 0, and match /discover', async () => {
  const filters = (await req('GET', '/api/universities/filters')).json;
  const total = filters.counts.total; // e.g. 4004
  const verified = filters.counts.verified; // e.g. 300
  const page = (await req('GET', '/for-universities')).text;
  // The visible fallback text is the real, comma-formatted number (not "0"),
  // injected from the same counts the API/discover use — no template tokens
  // leak, no stale hardcoded value.
  assert.ok(!page.includes('{{TOTAL}}'), 'no unreplaced token');
  assert.match(page, new RegExp(`>${total.toLocaleString('en-US')}</div>`));
  assert.match(page, new RegExp(`data-count="${verified}"`));
});

test('a logged-in student sees rule-based match reasons on a profile; logged-out does not', async () => {
  const anon = await fetch(base + '/api/universities/tum'); // no cookies
  const anonJson = await anon.json();
  assert.equal(anonJson.university.match_reasons, undefined);

  const email = `fit_${Date.now()}@example.com`;
  await req('POST', '/api/auth/register', {
    full_name: 'Fit Test', email, password: 'password123', consent: true,
    fields_of_interest: ['Computer Science'], degree_level: 'Master',
  });
  const withUser = await req('GET', '/api/universities/tum');
  assert.ok(Array.isArray(withUser.json.university.match_reasons));
  assert.ok(withUser.json.university.match_reasons.length >= 1);
  assert.equal(typeof withUser.json.university.match_explanation, 'string');
  await req('DELETE', '/api/me');
});

test('PATCH /api/me/profile stores matching fields and flips profile_completed', async () => {
  const email = `prof_${Date.now()}@example.com`;
  const reg = await req('POST', '/api/auth/register', { full_name: 'Prof T', email, password: 'password123', consent: true });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.student.profile_completed, false);

  const upd = await req('PATCH', '/api/me/profile', {
    fields_of_interest: ['Computer Science', 'Engineering', 'Law', 'Business'], // 4 → capped to 3
    budget_max_eur_year: 8000,
    preferred_languages: ['English'],
    degree_level: 'Master',
    city_preference: 'large',
    country_preference: ['Germany'],
    home_country: 'Mongolia',
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.student.profile_completed, true);
  assert.equal(upd.json.student.fields_of_interest.length, 3, 'capped to 3');
  assert.equal(upd.json.student.budget_max_eur_year, 8000);

  // sort=match now yields a compressed per-card reason for this student.
  const disc = await req('GET', '/api/universities?limit=5');
  assert.equal(disc.json.sort, 'match', 'profiled student defaults to fit ranking');
  assert.ok(disc.json.universities.some((u) => Array.isArray(u.match_reasons) && u.match_reasons.length));

  await req('DELETE', '/api/me');
});

test('admin sign-in page no longer prints the create-admin command', async () => {
  const r = await req('GET', '/admin');
  assert.ok(!/create-admin/.test(r.text), 'setup command must not be in public HTML');
  assert.match(r.text, /Contact the founder for access/);
});

test('university profile pages stay public for anonymous visitors (SEO surface)', async () => {
  const anyId = (await req('GET', '/api/universities?limit=1')).json.universities[0].id;
  const res = await fetch(`${base}/university/${anyId}`); // no cookies
  assert.equal(res.status, 200);
  assert.match(await res.text(), /rel="canonical"/);
});

test('deduplicated slugs 301 to their surviving record (HTML and API)', async () => {
  // 'g-au-dk' (global source) collapsed into the hand-curated 'aarhus'.
  const html = await fetch(base + '/university/g-au-dk', { redirect: 'manual' });
  assert.equal(html.status, 301);
  assert.equal(html.headers.get('location'), '/university/aarhus');

  const api = await fetch(base + '/api/universities/g-au-dk', { redirect: 'manual' });
  assert.equal(api.status, 301);
  assert.equal(api.headers.get('location'), '/api/universities/aarhus');
});

test('no name+country duplicates survive the build', async () => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const all = [];
  let offset = 0;
  for (;;) {
    const r = await req('GET', `/api/universities?limit=200&offset=${offset}`);
    all.push(...r.json.universities);
    if (!r.json.has_more) break;
    offset += 200;
  }
  const seen = new Set();
  for (const u of all) {
    const key = `${norm(u.name)}|${u.country}`;
    assert.ok(!seen.has(key), `duplicate: ${key}`);
    seen.add(key);
  }
});

test('tuition figures display only for curated research; estimates say check official site', async () => {
  const curated = (await req('GET', '/api/universities/tum')).json.university;
  assert.equal(curated.tuition_source, 'curated_research');

  const eter = (await req('GET', '/api/universities?source=eter&limit=1')).json.universities[0];
  const full = (await req('GET', `/api/universities/${eter.id}`)).json.university;
  assert.equal(full.tuition_source, 'country_estimate');

  const ssrPage = await req('GET', `/university/${eter.id}`);
  assert.match(ssrPage.text, /Check official site/);
  assert.ok(!/Tuition \(intl\)<\/dt><dd>~?€/.test(ssrPage.text), 'no fabricated € figure in SSR facts');
});

test('/saved and /account ship real fallback content, page meta and noindex', async () => {
  const saved = await req('GET', '/saved');
  assert.match(saved.text, /<title>Your saved universities/);
  assert.match(saved.text, /noindex, nofollow/);
  assert.match(saved.text, /Sign in to see your shortlist/);

  const account = await req('GET', '/account');
  assert.match(account.text, /<title>Sign in or create your free account/);
  assert.match(account.text, /noindex, nofollow/);
  assert.match(account.text, /<fieldset disabled>/);
});

test('robots.txt disallows operational surfaces and references the sitemap', async () => {
  const r = await req('GET', '/robots.txt');
  for (const p of ['/admin', '/partners', '/saved', '/account']) assert.match(r.text, new RegExp(`Disallow: ${p}`));
  assert.match(r.text, /Sitemap:/);
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
