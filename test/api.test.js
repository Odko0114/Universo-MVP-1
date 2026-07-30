'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');
const store = require('../lib/store');
const emailService = require('../lib/email'); // aliased — many tests below use `email` for the test address

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

test('GET /api/universities is rate limited (previously had none at all)', async () => {
  // Distinct X-Forwarded-For so this test's bucket never overlaps with any
  // other test in the file hitting the same route from the default IP.
  const headers = { 'X-Forwarded-For': 'rl-test-list-1' };
  let last;
  for (let i = 0; i < 180; i++) last = await fetch(base + '/api/universities?limit=1', { headers });
  assert.equal(last.status, 200, 'the 180th request within the window still succeeds');
  const blocked = await fetch(base + '/api/universities?limit=1', { headers });
  assert.equal(blocked.status, 429);
});

test('GET /api/universities/:id is rate limited (previously had none at all)', async () => {
  const id = (await req('GET', '/api/universities?limit=1')).json.universities[0].id;
  const headers = { 'X-Forwarded-For': 'rl-test-detail-1' };
  let last;
  for (let i = 0; i < 120; i++) last = await fetch(`${base}/api/universities/${id}`, { headers });
  assert.equal(last.status, 200, 'the 120th request within the window still succeeds');
  const blocked = await fetch(`${base}/api/universities/${id}`, { headers });
  assert.equal(blocked.status, 429);
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

test('GET /for-universities serves the B2B page (mission, claim, pricing, testimonials, demo link)', async () => {
  const r = await req('GET', '/for-universities');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>For universities/);
  assert.match(r.text, /id="mission"/);
  assert.match(r.text, /id="claim"/);
  assert.match(r.text, /id="uni-form"/);
  assert.match(r.text, /id="pricing"/);
  assert.match(r.text, /€990/);            // D.2 pricing figure
  assert.match(r.text, /id="testimonials"/); // E.2 scaffold
  assert.match(r.text, /\/partners\/demo/);  // D.1 demo link
});

test('GET /partners/demo is a public, clearly-labelled example dashboard', async () => {
  const r = await req('GET', '/partners/demo');
  assert.equal(r.status, 200);
  assert.match(r.text, /Example data/);
  assert.match(r.text, /noindex, nofollow/);
});

test('for-universities stat counters render the real number, never a bare 0, and match /discover', async () => {
  const filters = (await req('GET', '/api/universities/filters')).json;
  const total = filters.counts.total; // e.g. 4004
  const verified = filters.counts.verified; // e.g. 300
  const page = (await req('GET', '/for-universities')).text;
  // The visible fallback text is the real, comma-formatted number (not "0"),
  // injected from the same counts the API/discover use — no template tokens
  // leak, no stale hardcoded value.
  assert.ok(!page.includes('{{TOTAL}}') && !page.includes('{{VERIFIED}}'), 'no unreplaced token');
  assert.match(page, new RegExp(`data-count="${verified}"`), 'verified count is injected live');
  // The raw directory total is deliberately absent from the B2B page: shown
  // next to the verified count it advertises how much of the catalogue is thin.
  assert.ok(!page.includes(`>${total.toLocaleString('en-US')}</div>`), 'directory total must not appear');
});

test('/for-universities carries a data-handling section and no un-evidenced claims', async () => {
  const page = (await req('GET', '/for-universities')).text;
  assert.match(page, /id="data-handling"/);
  assert.match(page, /What we collect/);
  assert.match(page, /Legal basis/);
  assert.match(page, /href="\/privacy"/);
  // Residency must not claim the EU while the service runs in Render's default
  // US region — see the note in for-universities.html.
  assert.ok(!/EU-hosted|Frankfurt region/.test(page), 'no unverified EU-residency claim');
  // The unearned "conversations we've had" stat was dropped rather than
  // filled with an invented or bare-zero number — no placeholder should
  // remain, and the real founder quote has replaced the earlier overstated one.
  assert.ok(!page.includes('EXACT_NUMBER_OF_COMPLETED_CONVERSATIONS'), 'stale stat placeholder removed');
  assert.ok(!page.includes('FOUNDER_QUOTE_REWRITE'), 'stale quote placeholder removed');
  assert.match(page, /where you're born shouldn't determine how you begin/);
  assert.match(page, /Odgerel Batdelger, founder and CEO, Universo/);
  assert.ok(!/first 10 universities/.test(page), 'countdown wording removed');
  assert.match(page, /Free for founding pilot partners/);
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

test('signed-out /admin HTML leaks nothing: no setup command, no hint copy, no export URL', async () => {
  const r = await req('GET', '/admin');
  assert.ok(!/create-admin/.test(r.text), 'setup command must not be in public HTML');
  assert.ok(!/Contact the founder/.test(r.text), 'no provisioning hint copy');
  assert.ok(!/subscribers\.csv/.test(r.text), 'export URL is injected only after auth');
  // The gate itself still renders: title + both fields + the button.
  assert.match(r.text, /Admin sign in/);
  assert.match(r.text, /id="admin-email"/);
  assert.match(r.text, /id="admin-password"/);
});

test('every /api/admin/* and partner route rejects unauthenticated access with JSON 401', async () => {
  const adminRoutes = ['/api/admin/me', '/api/admin/stats', '/api/admin/traffic', '/api/admin/funnel',
    '/api/admin/retention', '/api/admin/searches', '/api/admin/leads', '/api/admin/subscribers.csv',
    '/api/admin/data-quality', '/api/admin/data-quality/records'];
  for (const path of adminRoutes) {
    const res = await fetch(base + path); // no cookies
    assert.equal(res.status, 401, `${path} must be 401 when signed out`);
    const body = await res.text();
    assert.ok(!/university|email|@/i.test(body) || /authentication required/i.test(body), `${path} leaked data`);
  }
  for (const path of ['/api/uni/me', '/api/uni/stats']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 401, `${path} must be 401 when signed out`);
  }
  // Admin-only mutation route too.
  const post = await fetch(base + '/api/admin/uni-accounts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.edu', password: 'whatever12345', university_id: 'tum' }),
  });
  assert.equal(post.status, 401);
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

test('Goethe Frankfurt cross-domain duplicate is merged, not just flagged', async () => {
  // eter-de0048 (goethe-university-frankfurt.de) and g-uni-frankfurt-de
  // (uni-frankfurt.de) are the same institution under two official domains —
  // previously only surfaced in lib/name-fixes.js#AMBIGUOUS_REVIEW for manual
  // follow-up. Confirm the richer ETER record survived under its real name...
  const survivor = (await req('GET', '/api/universities/eter-de0048')).json.university;
  assert.equal(survivor.name, 'Goethe University Frankfurt');
  // ...and the thinner global record now redirects to it instead of existing
  // as a second, near-empty profile for the same university.
  const dropped = await fetch(base + '/api/universities/g-uni-frankfurt-de', { redirect: 'manual' });
  assert.equal(dropped.status, 301);
  assert.equal(dropped.headers.get('location'), '/api/universities/eter-de0048');
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

test('unresearched tuition is omitted entirely and replaced by an honest register notice', async () => {
  const curated = (await req('GET', '/api/universities/tum')).json.university;
  assert.equal(curated.tuition_source, 'curated_research');

  const eter = (await req('GET', '/api/universities?source=eter&limit=1')).json.universities[0];
  const full = (await req('GET', `/api/universities/${eter.id}`)).json.university;
  assert.equal(full.tuition_source, 'country_estimate');

  const ssrPage = await req('GET', `/university/${eter.id}`);
  assert.ok(!/Tuition \(intl\)<\/dt><dd>~?€/.test(ssrPage.text), 'no fabricated € figure in SSR facts');
  assert.ok(!/Check official site/.test(ssrPage.text), 'no pseudo-answer in the tuition slot');
  assert.match(ssrPage.text, /have not verified tuition, programs or entry requirements/);
});

test('thin register profiles are noindex,follow; verified profiles stay indexable', async () => {
  const eter = (await req('GET', '/api/universities?source=eter&limit=1')).json.universities[0];
  const thin = await req('GET', `/university/${eter.id}`);
  assert.match(thin.text, /content="noindex, follow"/, 'thin page must be noindex but still followed');

  const verified = await req('GET', '/university/tum'); // curated + verified
  assert.ok(!/name="robots"/.test(verified.text), 'verified profile must stay indexable');
});

test('sitemap lists only verified profiles, not the full register', async () => {
  const r = await req('GET', '/sitemap.xml');
  const count = (r.text.match(/\/university\//g) || []).length;
  const filters = (await req('GET', '/api/universities/filters')).json;
  assert.equal(count, filters.counts.verified, 'one sitemap entry per verified profile');
  assert.ok(count < filters.counts.total, 'thin records are excluded');
});

test('outbound university links are https and truncated register names are corrected', async () => {
  const rwth = (await req('GET', '/api/universities/eter-de0069')).json.university;
  assert.equal(rwth.name, 'RWTH Aachen University');
  assert.equal(rwth.name_register, 'Aachen University', 'original register name kept for provenance');
  assert.ok(rwth.website.startsWith('https://'));
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

test('an unhandled async rejection (e.g. bcrypt failing) returns a clean 500, not a hang', async () => {
  // Express 4 doesn't forward a rejected promise from an async handler to the
  // error middleware on its own — server.js's asyncRoute wrapper closes that
  // gap. Prove it end-to-end by making a real dependency throw mid-request.
  const bcrypt = require('bcryptjs');
  const original = bcrypt.compare;
  bcrypt.compare = () => Promise.reject(new Error('simulated bcrypt failure'));
  try {
    const r = await req('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever123' });
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'Something went wrong.');
  } finally {
    bcrypt.compare = original;
  }
});

test('GET /me/journey requires auth', async () => {
  const clean = await fetch(base + '/api/me/journey'); // no cookies
  assert.equal(clean.status, 401);
});

test('GET /me/journey assembles the dashboard and gains match picks once a profile is set', async () => {
  const testAddr = `journey_${Date.now()}@example.com`;
  await req('POST', '/api/auth/register', {
    full_name: 'Journey Flow', email: testAddr, password: 'password123', consent: true,
    country_of_origin: 'Mongolia',
  });

  // No matching profile yet: completeness low, no picks, but next actions guide.
  const before = await req('GET', '/api/me/journey');
  assert.equal(before.status, 200);
  assert.equal(before.json.has_profile, false);
  assert.equal(before.json.completeness.total, 6);
  assert.equal(before.json.picks.length, 0, 'no ranked picks without a profile');
  assert.ok(Array.isArray(before.json.next_actions) && before.json.next_actions.length >= 1);
  assert.equal(before.json.next_actions[0].key, 'complete_profile');
  // Scholarship pointers surfaced from home country (non-EU → no Erasmus Mundus).
  assert.ok(before.json.scholarships.length >= 1, 'scholarship pointers surfaced for the home country');
  assert.ok(before.json.scholarships.every((s) => s.verify === true), 'every pointer is flagged verify');

  // Set a matching profile → picks appear, each with a "why" reason.
  await req('PATCH', '/api/me/profile', {
    fields_of_interest: ['Computer Science & IT'], degree_level: 'Master', budget_max_eur_year: 8000,
  });
  const after = await req('GET', '/api/me/journey');
  assert.equal(after.json.has_profile, true);
  assert.ok(after.json.completeness.percent > before.json.completeness.percent, 'completeness rose');
  assert.ok(after.json.picks.length >= 1, 'ranked picks now returned');
  assert.ok(after.json.picks[0].match_reasons && after.json.picks[0].match_reasons.length, 'picks carry a why reason');

  await req('DELETE', '/api/me');
});

test('application status: requires the uni saved, validates status, persists, rolls up, clears on unsave', async () => {
  const testAddr = `appstatus_${Date.now()}@example.com`;
  await req('POST', '/api/auth/register', { full_name: 'App Status', email: testAddr, password: 'password123', consent: true });
  const id = (await req('GET', '/api/universities?limit=1')).json.universities[0].id;

  // Can't set a status on a uni that isn't saved.
  const notSaved = await req('POST', `/api/me/saved/${id}/status`, { status: 'applied' });
  assert.equal(notSaved.status, 400);

  await req('POST', `/api/me/saved/${id}`); // save it

  // Unknown status rejected.
  const bad = await req('POST', `/api/me/saved/${id}/status`, { status: 'enrolled' });
  assert.equal(bad.status, 400);

  // Valid status persists and shows on /me/saved.
  const set = await req('POST', `/api/me/saved/${id}/status`, { status: 'applied' });
  assert.equal(set.status, 200);
  const saved = await req('GET', '/api/me/saved');
  assert.equal(saved.json.universities.find((u) => u.id === id).application_status, 'applied');

  // Journey rolls it up.
  const journeyData = await req('GET', '/api/me/journey');
  assert.equal(journeyData.json.saved.status_counts.applied, 1);
  assert.equal(journeyData.json.saved.universities.find((u) => u.id === id).application_status, 'applied');

  // Unsaving clears the status (so it can't resurrect on re-save).
  await req('DELETE', `/api/me/saved/${id}`);
  await req('POST', `/api/me/saved/${id}`);
  const reSaved = await req('GET', '/api/me/saved');
  assert.equal(reSaved.json.universities.find((u) => u.id === id).application_status, 'considering', 'status reset after unsave/re-save');

  await req('DELETE', '/api/me');
});

test('application status endpoint requires authentication', async () => {
  const clean = await fetch(base + '/api/me/saved/tum/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'applied' }),
  });
  assert.equal(clean.status, 401);
});

test('POST /me/milestone: auth-gated, validates the key, persists, and reflects in the timeline', async () => {
  const unauth = await fetch(base + '/api/me/milestone', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'arrived', done: true }),
  });
  assert.equal(unauth.status, 401);

  const testAddr = `milestone_${Date.now()}@example.com`;
  await req('POST', '/api/auth/register', { full_name: 'Milestone Flow', email: testAddr, password: 'password123', consent: true });

  // Auto stages are never client-settable.
  const auto = await req('POST', '/api/me/milestone', { key: 'profile_set', done: true });
  assert.equal(auto.status, 400, 'auto stages cannot be toggled by the client');
  const bogus = await req('POST', '/api/me/milestone', { key: 'not_a_stage', done: true });
  assert.equal(bogus.status, 400);

  // Fresh timeline: account done, profile_set is next.
  const t0 = (await req('GET', '/api/me/journey')).json.timeline;
  assert.equal(t0.stages.length, 9);
  assert.equal(t0.next_key, 'profile_set');

  // Mark a self stage → persists and shows done in the timeline.
  const set = await req('POST', '/api/me/milestone', { key: 'application_submitted', done: true });
  assert.equal(set.status, 200);
  assert.ok(set.json.milestones.includes('application_submitted'));
  const t1 = (await req('GET', '/api/me/journey')).json.timeline;
  assert.equal(t1.stages.find((s) => s.key === 'application_submitted').done, true);

  // Unmark → removed.
  const unset = await req('POST', '/api/me/milestone', { key: 'application_submitted', done: false });
  assert.ok(!unset.json.milestones.includes('application_submitted'));

  await req('DELETE', '/api/me');
});

test('GET /journey SSR fallback is noindex and prompts sign-in', async () => {
  const r = await req('GET', '/journey');
  assert.equal(r.status, 200);
  assert.match(r.text, /content="noindex/);
  assert.match(r.text, /My Journey/);
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

test('POST /me/logout-everywhere revokes this session AND every previously issued token', async () => {
  const email = `logout_${Date.now()}@example.com`;
  const reg = await req('POST', '/api/auth/register', { full_name: 'Logout Test', email, password: 'password123', consent: true });
  assert.equal(reg.status, 201);
  const staleToken = jar.uv_token;
  assert.ok(staleToken, 'auth cookie set');

  const out = await req('POST', '/api/me/logout-everywhere');
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);

  const meAfter = await req('GET', '/api/auth/me');
  assert.equal(meAfter.status, 401, 'this session is logged out too');

  // The real security property: a JWT signed before the call is rejected
  // everywhere, not just the cookie the test jar happens to hold now.
  const stale = await fetch(base + '/api/auth/me', { headers: { Cookie: `uv_token=${staleToken}` } });
  assert.equal(stale.status, 401);

  await req('POST', '/api/auth/login', { email, password: 'password123' });
  await req('DELETE', '/api/me'); // cleanup
});

test('POST /me/logout-everywhere requires authentication', async () => {
  const clean = await fetch(base + '/api/me/logout-everywhere', { method: 'POST' }); // no cookies
  assert.equal(clean.status, 401);
});

test('POST /auth/verify-email is rate limited (found missing during security review)', async () => {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': 'rl-test-verify-email' };
  const body = JSON.stringify({ token: 'a'.repeat(64) });
  let last;
  for (let i = 0; i < 20; i++) last = await fetch(base + '/api/auth/verify-email', { method: 'POST', headers, body });
  assert.equal(last.status, 400, 'the 20th attempt is still processed (just rejected as an unknown token)');
  const blocked = await fetch(base + '/api/auth/verify-email', { method: 'POST', headers, body });
  assert.equal(blocked.status, 429);
});

test('email verification: full flow, plus invalid/expired tokens rejected', async () => {
  const testAddr = `verify_${Date.now()}@example.com`;
  let capturedLink;
  const original = emailService.sendVerificationEmail;
  emailService.sendVerificationEmail = (student, link) => { capturedLink = link; return Promise.resolve({ sent: false }); };
  try {
    const reg = await req('POST', '/api/auth/register', { full_name: 'Verify Flow', email: testAddr, password: 'password123', consent: true });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.student.email_verified, false, 'unverified at registration');
    assert.ok(capturedLink, 'verification link was generated and handed to the email service');

    const token = new URL(capturedLink).searchParams.get('token');
    assert.match(token, /^[0-9a-f]{64}$/, 'raw token is 32 random bytes as hex');

    const bad = await req('POST', '/api/auth/verify-email', { token: 'f'.repeat(64) });
    assert.equal(bad.status, 400, 'a well-formed but unknown token is rejected');

    const malformed = await req('POST', '/api/auth/verify-email', { token: 'not-a-token' });
    assert.equal(malformed.status, 400);

    const ok = await req('POST', '/api/auth/verify-email', { token });
    assert.equal(ok.status, 200);

    const me = await req('GET', '/api/auth/me');
    assert.equal(me.json.student.email_verified, true);

    // A token is single-use — the hash is cleared on success.
    const reused = await req('POST', '/api/auth/verify-email', { token });
    assert.equal(reused.status, 400);
  } finally {
    emailService.sendVerificationEmail = original;
    await req('DELETE', '/api/me').catch(() => {});
  }
});

test('POST /me/resend-verification requires auth, is disabled while email is dormant', async () => {
  const clean = await fetch(base + '/api/me/resend-verification', { method: 'POST' }); // no cookies
  assert.equal(clean.status, 401);

  const testAddr = `resend_${Date.now()}@example.com`;
  await req('POST', '/api/auth/register', { full_name: 'Resend Test', email: testAddr, password: 'password123', consent: true });
  // email.ENABLED is false in this test run (no RESEND_API_KEY) — the route
  // must say so rather than pretend to send.
  const r = await req('POST', '/api/me/resend-verification');
  assert.equal(r.status, 400);
  await req('DELETE', '/api/me');
});

test('PATCH /me/profile succeeds for an unverified student while email is dormant (zero behavior change)', async () => {
  const testAddr = `dormant_gate_${Date.now()}@example.com`;
  const reg = await req('POST', '/api/auth/register', { full_name: 'Dormant Gate', email: testAddr, password: 'password123', consent: true });
  assert.equal(reg.json.student.email_verified, false);
  const patch = await req('PATCH', '/api/me/profile', { degree_level: 'Master' });
  assert.equal(patch.status, 200, 'requireVerifiedEmail must be a no-op while email.ENABLED is false');
  await req('DELETE', '/api/me');
});

test('forgot-password always responds 200, whether or not the account exists (no enumeration)', async () => {
  const testAddr = `forgot_${Date.now()}@example.com`;
  let capturedLink;
  const original = emailService.sendPasswordResetEmail;
  emailService.sendPasswordResetEmail = (student, link) => { capturedLink = link; return Promise.resolve({ sent: false }); };
  try {
    await req('POST', '/api/auth/register', { full_name: 'Forgot Flow', email: testAddr, password: 'password123', consent: true });

    const real = await req('POST', '/api/auth/forgot-password', { email: testAddr });
    assert.equal(real.status, 200);
    assert.ok(capturedLink, 'a reset link was generated for a real account');

    capturedLink = undefined;
    const fake = await req('POST', '/api/auth/forgot-password', { email: `nobody_${Date.now()}@example.com` });
    assert.equal(fake.status, 200, 'identical response for a non-existent account');
    assert.equal(capturedLink, undefined, 'no email/token generated for an account that does not exist');
  } finally {
    emailService.sendPasswordResetEmail = original;
    await req('DELETE', '/api/me').catch(() => {});
  }
});

test('password reset: valid token changes the password and invalidates every existing session', async () => {
  const testAddr = `reset_${Date.now()}@example.com`;
  let capturedLink;
  const original = emailService.sendPasswordResetEmail;
  emailService.sendPasswordResetEmail = (student, link) => { capturedLink = link; return Promise.resolve({ sent: false }); };
  try {
    await req('POST', '/api/auth/register', { full_name: 'Reset Flow', email: testAddr, password: 'password123', consent: true });
    const staleToken = jar.uv_token; // the session created at registration

    await req('POST', '/api/auth/forgot-password', { email: testAddr });
    const resetToken = new URL(capturedLink).searchParams.get('token');

    const badPw = await req('POST', '/api/auth/reset-password', { token: resetToken, password: 'short' });
    assert.equal(badPw.status, 400, 'new password still goes through the min-length rule');

    const ok = await req('POST', '/api/auth/reset-password', { token: resetToken, password: 'newpassword456' });
    assert.equal(ok.status, 200);

    // The pre-reset session is dead — same revocation path as logout-everywhere.
    const staleCheck = await fetch(base + '/api/auth/me', { headers: { Cookie: `uv_token=${staleToken}` } });
    assert.equal(staleCheck.status, 401);

    // Reused reset token is rejected (cleared on success).
    const reused = await req('POST', '/api/auth/reset-password', { token: resetToken, password: 'anotherpassword789' });
    assert.equal(reused.status, 400);

    // The new password actually works.
    const login = await req('POST', '/api/auth/login', { email: testAddr, password: 'newpassword456' });
    assert.equal(login.status, 200);
  } finally {
    emailService.sendPasswordResetEmail = original;
    await req('DELETE', '/api/me').catch(() => {});
  }
});

test('change-email: full flow — requires correct password, resets verification, notifies the old address, invalidates other sessions', async () => {
  const oldAddr = `changeold_${Date.now()}@example.com`;
  const newAddr = `changenew_${Date.now()}@example.com`;
  let verifyLink, noticeTo, noticeOld, noticeNew;
  const originalVerify = emailService.sendVerificationEmail;
  const originalNotice = emailService.sendEmailChangedNotice;
  emailService.sendVerificationEmail = (student, link) => { verifyLink = link; return Promise.resolve({ sent: false }); };
  emailService.sendEmailChangedNotice = (name, o, n) => { noticeTo = o; noticeOld = o; noticeNew = n; return Promise.resolve({ sent: false }); };
  try {
    await req('POST', '/api/auth/register', { full_name: 'Change Email Flow', email: oldAddr, password: 'password123', consent: true });
    const preChangeToken = jar.uv_token;

    const wrongPw = await req('POST', '/api/me/change-email', { new_email: newAddr, password: 'wrongpassword' });
    assert.equal(wrongPw.status, 401);

    const ok = await req('POST', '/api/me/change-email', { new_email: newAddr, password: 'password123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.student.email, newAddr);
    assert.equal(ok.json.student.email_verified, false, 'the new address is unverified until proven');

    // Notice went to the OLD address, verification link is for the NEW one.
    assert.equal(noticeTo, oldAddr);
    assert.equal(noticeNew, newAddr);
    assert.ok(verifyLink, 'a fresh verification email was sent to the new address');

    // This request's own session survives (cookie was reissued)...
    const meNow = await req('GET', '/api/auth/me');
    assert.equal(meNow.status, 200);
    assert.equal(meNow.json.student.email, newAddr);

    // ...but a session token issued BEFORE the change is dead.
    const staleCheck = await fetch(base + '/api/auth/me', { headers: { Cookie: `uv_token=${preChangeToken}` } });
    assert.equal(staleCheck.status, 401);

    // The re-verification token actually works.
    const token = new URL(verifyLink).searchParams.get('token');
    const verify = await req('POST', '/api/auth/verify-email', { token });
    assert.equal(verify.status, 200);
    const meVerified = await req('GET', '/api/auth/me');
    assert.equal(meVerified.json.student.email_verified, true);

    // The old email now works for a fresh login attempt only via 404-equivalent (account no longer under that address).
    const loginOld = await req('POST', '/api/auth/login', { email: oldAddr, password: 'password123' });
    assert.equal(loginOld.status, 401);
    const loginNew = await req('POST', '/api/auth/login', { email: newAddr, password: 'password123' });
    assert.equal(loginNew.status, 200);
  } finally {
    emailService.sendVerificationEmail = originalVerify;
    emailService.sendEmailChangedNotice = originalNotice;
    await req('DELETE', '/api/me').catch(() => {});
  }
});

test('change-email requires authentication and rejects an email already in use', async () => {
  const clean = await fetch(base + '/api/me/change-email', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_email: 'x@example.com', password: 'x' }),
  });
  assert.equal(clean.status, 401);

  const addrA = `dupA_${Date.now()}@example.com`;
  const addrB = `dupB_${Date.now()}@example.com`;
  await req('POST', '/api/auth/register', { full_name: 'A', email: addrA, password: 'password123', consent: true });
  await req('POST', '/api/auth/logout');
  await req('POST', '/api/auth/register', { full_name: 'B', email: addrB, password: 'password123', consent: true });
  // Logged in as B — try to change to A's email.
  const clash = await req('POST', '/api/me/change-email', { new_email: addrA, password: 'password123' });
  assert.equal(clash.status, 409);
  await req('DELETE', '/api/me'); // deletes B
  await req('POST', '/api/auth/login', { email: addrA, password: 'password123' });
  await req('DELETE', '/api/me'); // deletes A
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
