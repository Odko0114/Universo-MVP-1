'use strict';

/**
 * Universo — backend.
 *
 * Express API + static SPA with server-side rendering for SEO. Logic lives in
 * focused modules under lib/ (auth, search, events, ssr, store…); this file wires
 * them into routes. File-based JSON storage (see lib/store.js) behind a
 * repository seam — swap for a database before real traffic.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const bcrypt = require('bcryptjs');

const cfg = require('./lib/config');
const log = require('./lib/log');
const store = require('./lib/store');
const { buildDataset } = require('./lib/dataset');
const auth = require('./lib/auth');
const adminAuth = require('./lib/admin-auth');
const search = require('./lib/search');
const match = require('./lib/match');
const events = require('./lib/events');
const validate = require('./lib/validate');
const ssr = require('./lib/ssr');
const { rateLimit } = require('./lib/rate-limit');
const { fetchWithResilience } = require('./lib/http');

// ---------------------------------------------------------------------------
// Storage bootstrap
// ---------------------------------------------------------------------------
// Universities are DERIVED data (rebuilt from data/seed/* every boot) — use
// initFresh so a stale copy on a persistent volume can never shadow updated
// seed data after a deploy. Everything user-generated below uses init().
store.initFresh('universities', buildDataset());
store.init('students', []);
store.init('admins', []);
store.init('clicks', {});   // { universityId: count } — kept separate so a click
                            // never rewrites the ~12k-record universities file.
store.init('photos', {});   // { id: { photo_url|null, attribution, cached_at } }
adminAuth.bootstrapFromEnv(); // creates one admin from ADMIN_EMAIL/ADMIN_PASSWORD if none exist yet
events.rotateIfLarge().catch((e) => log.warn('startup event-log rotation check failed', { error: e.message }));

const UNIVERSITIES = store.read('universities');
const INDEX = search.buildIndex(UNIVERSITIES);         // built once (dataset is static)
const FILTERS = search.buildFilters(UNIVERSITIES);     // cached
const BY_ID = new Map(UNIVERSITIES.map((u) => [u.id, u]));

const clickOf = (id) => store.read('clicks')[id] || 0;

// ---------------------------------------------------------------------------
// App + global middleware
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', true);
app.use(compression()); // gzip/brotli — the filter/search JSON responses are big
app.use(express.json({ limit: '16kb' }));

// Baseline security headers (a CSP is deliberately omitted for now — the SPA
// uses inline styles throughout, so a useful CSP needs a dedicated pass).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Request id + structured access log (no PII).
app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      log.info('req', { id: req.id, m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - start });
    }
  });
  next();
});

app.use(auth.anon); // ensures req.anon (anonymous analytics id)

const api = express.Router();

const publicStudent = (s) => {
  if (!s) return null;
  const { password_hash, token_version, anon_ids, ...safe } = s;
  return safe;
};

// ---- Auth -----------------------------------------------------------------

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Try again in a few minutes.' });

api.post('/auth/register', authLimiter, async (req, res) => {
  const result = validate.registration(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const v = result.value;

  if (store.read('students').some((s) => s.email === v.email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const now = new Date().toISOString();
  const student = {
    student_id: crypto.randomUUID(),
    full_name: v.full_name,
    email: v.email,
    password_hash: await bcrypt.hash(v.password, cfg.BCRYPT_ROUNDS),
    country_of_origin: v.country_of_origin,
    field_of_interest: v.field_of_interest,
    target_degree_level: v.target_degree_level,
    saved_universities: [],
    consent_accepted: true,
    consent_date: now,
    signup_date: now,
    last_active_date: now,
    token_version: 0,
    // Anonymous client ids ever linked to this account — lets account deletion
    // purge the matching behavioral event trail (GDPR erasure), not just the
    // student record. Capped so a very long-lived account can't grow unbounded.
    anon_ids: req.anon ? [req.anon] : [],
  };

  const students = store.read('students');
  students.push(student);
  store.write('students', students);
  // `src` attributes the signup to a CTA (landing hero, gate, nav…) — funnel
  // attribution only, no PII. Whitelisted to a short slug.
  const src = typeof req.body.src === 'string' ? req.body.src.slice(0, 24).replace(/[^a-z0-9_-]/gi, '') : '';
  events.record('signup', { anon: req.anon, ...(src ? { src } : {}) });
  log.info('signup', { students: students.length }); // count only — never the email

  auth.setAuthCookie(res, student);
  res.status(201).json({ student: publicStudent(student) });
});

api.post('/auth/login', authLimiter, async (req, res) => {
  const result = validate.login(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const { email, password } = result.value;

  const student = store.read('students').find((s) => s.email === email);
  // Constant-ish work whether or not the account exists (avoid user enumeration).
  const hash = student ? student.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(password, hash);
  if (!student || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });

  if (req.anon && !(student.anon_ids || []).includes(req.anon)) {
    student.anon_ids = [...(student.anon_ids || []), req.anon].slice(-20); // cap growth
    store.writeDebounced('students', store.read('students'));
  }

  auth.setAuthCookie(res, student);
  events.record('login', { anon: req.anon });
  res.json({ student: publicStudent(student) });
});

api.post('/auth/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

api.get('/auth/me', auth.requireAuth, (req, res) => {
  res.json({ student: publicStudent(req.student) });
});

// ---- Universities ---------------------------------------------------------

api.get('/universities/filters', (_req, res) => res.json(FILTERS));

api.get('/universities', (req, res) => {
  const result = search.query(INDEX, req.query, clickOf);
  const q = String(req.query.q || '').trim();
  if (q) {
    events.record('search', { anon: req.anon, results: result.count, q: q.slice(0, 80) });
  }
  res.json(result);
});

api.get('/universities/:id', (req, res) => {
  const uni = BY_ID.get(req.params.id);
  if (!uni) return res.status(404).json({ error: 'University not found.' });
  res.json({ university: { ...uni, click_count: clickOf(uni.id) } });
});

// Anonymous Apply-Now click — bumps a counter in the separate clicks store and
// records a deduplicable event. No personal data attached.
const clickLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
api.post('/universities/:id/apply-click', clickLimiter, (req, res) => {
  const uni = BY_ID.get(req.params.id);
  if (!uni) return res.status(404).json({ error: 'University not found.' });

  const clicks = store.read('clicks');
  clicks[uni.id] = (clicks[uni.id] || 0) + 1;
  store.writeDebounced('clicks', clicks);
  events.record('apply_click', { uni: uni.id, anon: req.anon });

  res.json({ ok: true, click_count: clicks[uni.id], application_link: uni.application_link || uni.website || '' });
});

// ---- Client-side behavioral tracking ---------------------------------------
//
// First-party, cookieless-style tracking (no third-party script, no consent
// banner needed): the client posts a tiny beacon on each navigation. Referrer
// and language are read from headers server-side (more reliable than trusting
// the client and avoids forwarding a full URL with query strings). No PII is
// accepted or stored — just a path, an anonymous id, and a device/locale guess.

const TRACK_TYPES = new Set(['pageview', 'profile_view', 'filter_used']);
const trackLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

function refDomain(req) {
  const ref = req.get('Referer') || '';
  try {
    const host = new URL(ref).host;
    return host && host !== req.get('host') ? host : '';
  } catch { return ''; }
}

api.post('/track', trackLimiter, (req, res) => {
  const { type, path: p, uni, filter, value } = req.body || {};
  if (!TRACK_TYPES.has(type)) return res.status(400).json({ error: 'Unknown event type.' });

  const meta = {
    anon: req.anon,
    path: typeof p === 'string' ? p.slice(0, 200) : '',
    ref: refDomain(req),
    lang: (req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim().slice(0, 10),
    device: req.body && req.body.device === 'mobile' ? 'mobile' : 'desktop',
  };
  if (type === 'profile_view' && typeof uni === 'string') meta.uni = uni.slice(0, 60);
  if (type === 'filter_used') {
    meta.filter = typeof filter === 'string' ? filter.slice(0, 40) : '';
    meta.value = typeof value === 'string' ? value.slice(0, 80) : '';
  }

  events.record(type, meta);
  res.status(204).end();
});

// ---- Cover photo (Wikipedia) + logo proxy ---------------------------------

const WIKI_UA = 'Universo/0.1 (university discovery MVP; https://example.com; admin@example.com)';
const photoInflight = new Map(); // id -> Promise (dedupe concurrent first-lookups)
const photoLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

async function lookupWikipedia(name, extra) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', prop: 'pageimages|extracts', piprop: 'original|thumbnail',
    pithumbsize: '1000', exintro: '1', explaintext: '1', exsentences: '4',
    generator: 'search', gsrsearch: extra ? `${name} ${extra}` : name, gsrlimit: '1', gsrnamespace: '0',
  });
  const res = await fetchWithResilience(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': WIKI_UA }, timeoutMs: 8000, retries: 1, label: 'wikipedia',
  });
  const data = await res.json();
  const page = data?.query?.pages && Object.values(data.query.pages)[0];
  if (!page) return null;
  const src = page.original?.source || page.thumbnail?.source || null;
  const extract = page.extract ? String(page.extract).trim() : null;
  if (!src && !extract) return null;
  return { photo_url: src, page: page.title, extract };
}

// Best-effort image credit (Wikimedia Commons is mostly CC-BY-SA → attribution required).
async function lookupAttribution(photoUrl) {
  try {
    const file = 'File:' + decodeURIComponent(photoUrl.split('/').pop());
    const params = new URLSearchParams({
      action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'extmetadata|url', titles: file,
    });
    const res = await fetchWithResilience(`https://commons.wikimedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': WIKI_UA }, timeoutMs: 6000, retries: 0, label: 'commons',
    });
    const data = await res.json();
    const page = data?.query?.pages && Object.values(data.query.pages)[0];
    const m = page?.imageinfo?.[0]?.extmetadata || {};
    const strip = (h) => (h ? String(h).replace(/<[^>]*>/g, '').trim() : '');
    return {
      artist: strip(m.Artist?.value) || 'Wikimedia Commons',
      license: strip(m.LicenseShortName?.value) || '',
      source: page?.imageinfo?.[0]?.descriptionurl || '',
    };
  } catch { return { artist: 'Wikimedia Commons', license: '', source: '' }; }
}

api.get('/universities/:id/photo', photoLimiter, async (req, res) => {
  const uni = BY_ID.get(req.params.id);
  if (!uni) return res.status(404).json({ error: 'University not found.' });

  const reply = (c, cached) => res.json({
    photo_url: c.none ? null : (c.photo_url || null),
    attribution: c.attribution || null,
    extract: c.extract || null,
    cached,
  });

  const cache = store.read('photos');
  if (cache[uni.id]) return reply(cache[uni.id], true);

  if (!photoInflight.has(uni.id)) {
    photoInflight.set(uni.id, (async () => {
      let found = await lookupWikipedia(uni.name).catch(() => null);
      if (!found && uni.country) found = await lookupWikipedia(uni.name, uni.country).catch(() => null);
      const attribution = found && found.photo_url ? await lookupAttribution(found.photo_url) : null;
      const entry = found
        ? { photo_url: found.photo_url, page: found.page, extract: found.extract, attribution, source: 'wikipedia', cached_at: new Date().toISOString() }
        : { none: true, cached_at: new Date().toISOString() };
      const c = store.read('photos');
      c[uni.id] = entry;
      store.writeDebounced('photos', c);
      return entry;
    })().finally(() => photoInflight.delete(uni.id)));
  }

  try {
    reply(await photoInflight.get(uni.id), false);
  } catch (e) {
    log.captureError(e, { where: 'photo', uni: uni.id });
    res.json({ photo_url: null, attribution: null, extract: null, cached: false });
  }
});

// Logo proxy + on-disk cache (avoids hotlinking a third-party favicon host and
// lets us fall back server-side). Frontend <img> points here; 404 → initials.
const LOGO_DIR = path.join(store.DATA_DIR, 'cache', 'logos');
fs.mkdirSync(LOGO_DIR, { recursive: true });
const logoLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });

api.get('/logo', logoLimiter, async (req, res) => {
  const domain = String(req.query.domain || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
  if (!domain || !domain.includes('.')) return res.status(400).end();

  const file = path.join(LOGO_DIR, `${domain}.img`);
  if (fs.existsSync(file)) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', fs.readFileSync(`${file}.type`, 'utf8').trim() || 'image/x-icon');
    return res.send(fs.readFileSync(file));
  }
  try {
    const r = await fetchWithResilience(`https://icons.duckduckgo.com/ip3/${domain}.ico`, { timeoutMs: 6000, retries: 1, label: 'logo' });
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) return res.status(404).end(); // empty/placeholder favicon
    const type = r.headers.get('content-type') || 'image/x-icon';
    fs.writeFileSync(file, buf);
    fs.writeFileSync(`${file}.type`, type);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', type);
    res.send(buf);
  } catch {
    res.status(404).end();
  }
});

// ---- Saved / bookmarks ----------------------------------------------------

api.get('/me/saved', auth.requireAuth, (req, res) => {
  const saved = req.student.saved_universities
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .map((u) => ({ ...u, click_count: clickOf(u.id) }));
  res.json({ count: saved.length, universities: saved });
});

api.post('/me/saved/:id', auth.requireAuth, (req, res) => {
  if (!BY_ID.has(req.params.id)) return res.status(404).json({ error: 'University not found.' });
  if (!req.student.saved_universities.includes(req.params.id)) {
    req.student.saved_universities.push(req.params.id);
    store.write('students', store.read('students'));
    events.record('save', { anon: req.anon, uni: req.params.id });
  }
  res.json({ saved_universities: req.student.saved_universities });
});

api.delete('/me/saved/:id', auth.requireAuth, (req, res) => {
  const before = req.student.saved_universities.length;
  req.student.saved_universities = req.student.saved_universities.filter((id) => id !== req.params.id);
  if (req.student.saved_universities.length !== before) {
    store.write('students', store.read('students'));
    events.record('unsave', { anon: req.anon, uni: req.params.id });
  }
  res.json({ saved_universities: req.student.saved_universities });
});

// "Recommended for you" — a transparent weighted match against the student's
// profile (target degree, field of interest) and the platform's EU/affordable/
// English-taught niche. See lib/match.js for why this is a scoring algorithm
// rather than a live AI call. Excludes universities already saved.
api.get('/me/recommendations', auth.requireAuth, (req, res) => {
  const limit = Math.min(24, Math.max(1, parseInt(String(req.query.limit || ''), 10) || 6));
  const excludeIds = new Set(req.student.saved_universities || []);
  const results = match.recommend(req.student, UNIVERSITIES, { limit, excludeIds })
    .map((u) => ({ ...u, click_count: clickOf(u.id) }));
  res.json({ universities: results });
});

// ---- GDPR: data export + account deletion ---------------------------------

api.get('/me/export', auth.requireAuth, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="universo-my-data.json"');
  res.json({ exported_at: new Date().toISOString(), account: publicStudent(req.student) });
});

api.delete('/me', auth.requireAuth, async (req, res) => {
  const anonIds = new Set(req.student.anon_ids || []);
  if (req.anon) anonIds.add(req.anon);

  const students = store.read('students').filter((s) => s.student_id !== req.student.student_id);
  await store.write('students', students);
  auth.clearAuthCookie(res);

  // Right-to-erasure: purge the behavioral event trail linked to this account,
  // not just the account row. A minimal deletion-audit event is kept afterward.
  const removed = await events.purgeAnon([...anonIds]);
  events.record('account_delete', { anon: req.anon });
  log.info('account deleted', { events_purged: removed });

  res.json({ ok: true });
});

// ---- Admin auth -------------------------------------------------------------

const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });

api.post('/admin/login', adminLoginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const admin = adminAuth.findAdminByEmail(email);
  const hash = admin ? admin.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!admin || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });

  adminAuth.setAdminCookie(res, admin);
  res.json({ admin: { email: admin.email } });
});

api.post('/admin/logout', (_req, res) => { adminAuth.clearAdminCookie(res); res.json({ ok: true }); });

api.get('/admin/me', adminAuth.requireAdmin, (req, res) => res.json({ admin: { email: req.admin.email } }));

// Every other /api/admin/* route requires an authenticated admin session.
const adminApi = express.Router();
adminApi.use(adminAuth.requireAdmin);

adminApi.get('/stats', (_req, res) => {
  // Read the event log once and reuse it for every aggregation below — this
  // used to call events.summary() and events.topByUni() separately, each
  // doing its own synchronous full-file read + JSON.parse of every line.
  // Harmless at today's size; would double the (blocking) I/O cost of every
  // dashboard load once events.jsonl has real production history.
  const allEvents = events.readAll();
  const s = events.computeSummary(allEvents);
  const students = store.read('students');
  const clicks = store.read('clicks');
  const currentlySaved = students.reduce((n, x) => n + (x.saved_universities?.length || 0), 0);

  const topByClicks = Object.entries(clicks)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([id, count]) => ({ id, name: BY_ID.get(id)?.name || id, country: BY_ID.get(id)?.country || '', click_count: count }));

  const topByViews = events.computeTopByUni(allEvents, 'profile_view', 10)
    .map((r) => ({ id: r.id, name: BY_ID.get(r.id)?.name || r.id, country: BY_ID.get(r.id)?.country || '', views: r.count, unique_viewers: r.unique }));

  res.json({
    generated_at: new Date().toISOString(),
    totals: {
      universities: UNIVERSITIES.length,
      students: students.length,
      signups: s.totals.signup || 0,
      logins: s.totals.login || 0,
      searches: s.totals.search || 0,
      saves_events: s.totals.save || 0,
      currently_saved: currentlySaved,
      apply_clicks: s.totals.apply_click || 0,
      apply_clicks_unique: Object.values(s.applyUnique).reduce((a, b) => a + b, 0),
      pageviews: (s.totals.pageview || 0) + (s.totals.profile_view || 0),
    },
    last_24h: s.last24h,
    last_7d: s.last7d,
    top_universities_by_apply_clicks: topByClicks,
    top_universities_by_views: topByViews,
  });
});

// Time-windowed traffic view: visitors, pageviews, top pages/referrers/devices/languages.
adminApi.get('/traffic', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || ""), 10) || 7));
  res.json({ days, ...events.traffic({ sinceMs: days * 86_400_000 }) });
});

// Reach funnel: distinct clients at each stage, with conversion rates.
adminApi.get('/funnel', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || ""), 10) || 7));
  res.json({ days, stages: events.funnel({ sinceMs: days * 86_400_000 }) });
});

// Weekly cohort retention grid.
adminApi.get('/retention', (req, res) => {
  const weeks = Math.min(12, Math.max(2, parseInt(String(req.query.weeks || ""), 10) || 6));
  res.json(events.retention({ weeks }));
});

// Most common search terms — tells you what students want and where data gaps are.
adminApi.get('/searches', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || ""), 10) || 7));
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || ""), 10) || 10));
  res.json({ days, terms: events.topSearches({ sinceMs: days * 86_400_000, limit }) });
});

api.use('/admin', adminApi);

app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ status: 'ok', universities: UNIVERSITIES.length, uptime: process.uptime() }));

// ---------------------------------------------------------------------------
// Static assets, SEO, and SSR
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHELL = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const LANDING = fs.readFileSync(path.join(PUBLIC_DIR, 'landing.html'), 'utf8');
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.get('/robots.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
});

let sitemapCache = null; // dataset is static — build once
app.get('/sitemap.xml', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  if (!sitemapCache) {
    // /discover is login-gated (302 for crawlers) so it's deliberately absent;
    // the landing page + the ~12.5k public profile pages are the SEO surface.
    const urls = ['', ...UNIVERSITIES.map((u) => `university/${u.id}`)]
      .map((p) => `  <url><loc>${base}/${p}</loc></url>`).join('\n');
    sitemapCache = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  }
  res.type('application/xml').send(sitemapCache);
});

const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// Server-rendered profile pages (real HTML + per-page meta for crawlers).
app.get('/university/:id', (req, res) => {
  const uni = BY_ID.get(req.params.id);
  if (!uni) {
    return res.status(404).send(ssr.injectSSR(SHELL, {
      metaHtml: ssr.metaTags({ title: 'University not found — Universo', description: 'This university could not be found.' }),
      viewHtml: '<div class="empty"><h3>University not found</h3><a href="/discover">Back to discover</a></div>',
    }));
  }
  const loc = [uni.city, uni.country].filter(Boolean).join(', ');
  res.send(ssr.injectSSR(SHELL, {
    metaHtml: ssr.metaTags({
      title: `${uni.name}${loc ? ' — ' + loc : ''} | Universo`,
      description: uni.short_description || `${uni.name} — discover programs, facts and how to apply.`,
      canonical: `${baseUrl(req)}/university/${uni.id}`,
    }),
    viewHtml: ssr.profileView(uni),
  }));
});

// Marketing landing page. A returning student with a valid session skips
// straight past the pitch into the app — no reason to re-sell them. The page
// itself is static/no-JS, so its pageview is recorded HERE, server-side —
// otherwise the top of the funnel would be invisible in analytics.
app.get('/', (req, res) => {
  if (auth.loadStudent(req)) return res.redirect(302, '/discover');
  events.record('pageview', {
    anon: req.anon,
    path: '/',
    ref: refDomain(req),
    lang: (req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim().slice(0, 10),
    device: /mobile/i.test(req.get('User-Agent') || '') ? 'mobile' : 'desktop',
  });
  res.send(LANDING);
});

// The app proper requires an account: anonymous visitors get bounced to
// sign-up (with a `next` so they land back here after). University profile
// pages stay public — they're the shareable/SEO surface; the gate lives on
// the interactive tool. Gate bounces are recorded so the funnel can show how
// many visitors hit the wall vs. converted.
app.get('/discover', (req, res) => {
  if (!auth.loadStudent(req)) {
    events.record('gate', { anon: req.anon, path: '/discover' });
    return res.redirect(302, '/account?mode=register&src=gate&next=%2Fdiscover');
  }
  const list = search.query(INDEX, { limit: 50 }, clickOf).universities;
  res.send(ssr.injectSSR(SHELL, {
    metaHtml: ssr.metaTags({
      title: 'Discover universities abroad — Universo',
      description: `Search ${UNIVERSITIES.length.toLocaleString('en-US')} universities worldwide by country, type, field of study and budget. Save a shortlist and apply.`,
      canonical: `${baseUrl(req)}/discover`,
    }),
    viewHtml: ssr.directoryView(list, UNIVERSITIES.length),
  }));
});

// SPA fallback for any other route.
app.get('*', (_req, res) => res.send(SHELL));

// Error handler (last).
app.use((err, req, res, _next) => {
  log.captureError(err, { id: req.id, path: req.path });
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong.' });
});

// ---------------------------------------------------------------------------
// Start + graceful shutdown (only when run directly, not when imported by tests)
// ---------------------------------------------------------------------------
if (require.main === module) {
  const server = app.listen(cfg.PORT, () => {
    log.info('listening', { url: `http://localhost:${cfg.PORT}`, universities: UNIVERSITIES.length });
    process.stdout.write(`\n  Universo → http://localhost:${cfg.PORT}   (admin: /admin)\n  ${UNIVERSITIES.length.toLocaleString('en-US')} universities loaded\n\n`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown', { signal });
    server.close();
    try { await events.flush(); } catch { /* ignore */ }
    store.flushAll(); // persist debounced writes (clicks, last-active, photos)
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app; // exported for tests
