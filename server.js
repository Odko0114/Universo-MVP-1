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
const uniAuth = require('./lib/uni-auth');
const search = require('./lib/search');
const match = require('./lib/match');
const explain = require('./lib/explain');
const journey = require('./lib/journey');
const { scholarshipsFor } = require('./lib/scholarships');
const events = require('./lib/events');
const validate = require('./lib/validate');
const ssr = require('./lib/ssr');
const email = require('./lib/email');
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
store.init('pilot_leads', []);  // university contact/pilot/claim leads (/for-universities form)
store.init('uni_accounts', []); // partner logins, each bound to one university_id
store.init('claims', {});   // { universityId: { account_id, claimed_at } } — kept
                            // separate from the universities file because that
                            // one is DERIVED (rebuilt every boot); a claim must
                            // survive deploys.
adminAuth.bootstrapFromEnv(); // creates one admin from ADMIN_EMAIL/ADMIN_PASSWORD if none exist yet

// Same fail-fast philosophy as UNIVERSO_JWT_SECRET/UNIVERSO_DATA_DIR (see
// lib/config.js, lib/store.js): once email is actually live in production,
// verification/reset links MUST come from a trusted, configured origin, not
// the request's spoofable Host header (see appOrigin() below) — silently
// falling back would ship a real password-reset-poisoning vector. Scoped to
// email.ENABLED so this doesn't block booting while email stays dormant.
if (cfg.PROD && email.ENABLED && !process.env.UNIVERSO_APP_URL) {
  throw new Error('UNIVERSO_APP_URL must be set in production once RESEND_API_KEY is set — verification/reset links would otherwise be built from the spoofable request Host header.');
}
events.rotateIfLarge().catch((e) => log.warn('startup event-log rotation check failed', { error: e.message }));

const UNIVERSITIES = store.read('universities');
const INDEX = search.buildIndex(UNIVERSITIES);         // built once (dataset is static)
const FILTERS = search.buildFilters(UNIVERSITIES);     // cached
const BY_ID = new Map(UNIVERSITIES.map((u) => [u.id, u]));
// Old slugs of deduplicated records → their surviving slug (301s, never 404s).
const SLUG_REDIRECTS = require('./lib/dataset').slugRedirects();
const VERIFIED_COUNT = UNIVERSITIES.filter((u) => u.verified).length;
// Single source of truth for the headline platform numbers — the filters API,
// the /discover copy AND the /for-universities stat counters all read from
// here, so they can never drift apart (they used to: a hardcoded "4069" on the
// B2B page outlived the dedup that made it 4004).
const PLATFORM_COUNTS = {
  total: UNIVERSITIES.length,
  verified: VERIFIED_COUNT,
  countries: FILTERS.countries.length,
};
FILTERS.counts = { total: PLATFORM_COUNTS.total, verified: PLATFORM_COUNTS.verified };

const clickOf = (id) => store.read('clicks')[id] || 0;

// Cached cover photo (never triggers a fresh Wikipedia lookup — reads only
// what /photo has already resolved and cached). Lets card grids show real
// photos progressively as profiles get viewed, without a lookup stampede on
// every search. `withPhoto` is applied everywhere a card list is returned.
const photoOf = (id) => {
  const p = store.read('photos')[id];
  return p && !p.none ? p.photo_url || null : null;
};
const withPhoto = (u) => ({ ...u, cover_photo_url: photoOf(u.id) });

// Claim status is stored in its own collection (see the claims init note) and
// overlaid at read time, since the universities file is rebuilt from seed at
// every boot and would lose a stored flag.
const claimedStatusOf = (id) => (store.read('claims')[id] ? 'claimed' : 'unclaimed');
const withClaim = (u) => ({ ...u, claimed_status: claimedStatusOf(u.id) });

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

// Express 4 does not forward a rejected promise from an async handler to the
// error middleware below — an unhandled one just hangs the request instead of
// returning the normal 500. Wrap any async handler that can genuinely throw
// (bcrypt, store writes, the dormant LLM call) so failures reach it.
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// Security-sensitive links (email verification, password reset) must NOT be
// built from the request's Host header — it's client-supplied and can be
// spoofed (a classic "password reset poisoning" vector: an attacker submits
// a victim's email with a forged Host, and the victim's own inbox delivers a
// link pointing at the attacker's domain, tokens and all). UNIVERSO_APP_URL
// is a trusted, server-configured origin; baseUrl(req) is only a fallback
// for local dev where that env var typically isn't set.
const appOrigin = (req) => (process.env.UNIVERSO_APP_URL || baseUrl(req)).replace(/\/+$/, '');

// A matching profile is "complete enough" to switch the matching layer on once
// the student has stated at least a field of interest OR a degree OR a budget —
// the inputs the scorer actually needs. Kept deliberately low so a half-filled
// onboarding still gets ranked results.
const profileCompleted = (s) =>
  !!s && ((s.fields_of_interest || []).length > 0 || !!s.degree_level || s.budget_max_eur_year != null);

const publicStudent = (s) => {
  if (!s) return null;
  const {
    password_hash, token_version, anon_ids,
    email_verify_token_hash, email_verify_expires, email_verify_last_sent,
    password_reset_token_hash, password_reset_expires,
    ...safe
  } = s;
  return {
    ...safe,
    profile_completed: profileCompleted(s),
    // Computed per response, not stored: whether verification is actually
    // enforced right now (dormant until RESEND_API_KEY is set — see
    // lib/email.js). Lets the client show/hide the verify-gate correctly
    // without ever nagging a user about a link that can't be delivered.
    email_verification_required: email.ENABLED,
  };
};

// ---- Auth -----------------------------------------------------------------

// Registration is the looser of the two (a shared campus IP may legitimately
// sign several students up); LOGIN is the credential-stuffing surface, so it
// gets the tighter 10-per-15-minutes cap that admin and partner logins use.
// NOTE: the limiter is in-memory (lib/rate-limit.js) — counters reset when the
// process restarts. Fine for a single instance; move to Redis if we scale out.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Try again in a few minutes.' });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });

// Gates content-creating actions on a verified email — a strict no-op while
// email.ENABLED is false (see lib/email.js), so this has zero effect on the
// app's current real users until a provider key is added. Applied after
// requireAuth, never in place of it.
function requireVerifiedEmail(req, res, next) {
  if (!email.ENABLED || req.student.email_verified) return next();
  res.status(403).json({ error: 'Please verify your email to continue.', code: 'EMAIL_NOT_VERIFIED' });
}

api.post('/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const result = validate.registration(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const v = result.value;

  if (store.read('students').some((s) => s.email === v.email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const now = new Date().toISOString();
  const verifyToken = auth.generateToken();
  const student = {
    student_id: crypto.randomUUID(),
    full_name: v.full_name,
    email: v.email,
    password_hash: await bcrypt.hash(v.password, cfg.BCRYPT_ROUNDS),
    // Email verification. Dormant until email.ENABLED (lib/email.js) — the
    // token is always generated and stored so turning verification on later
    // doesn't require a data migration, but login/actions are never gated on
    // it while dormant (see requireVerifiedEmail below).
    email_verified: false,
    email_verify_token_hash: auth.hashToken(verifyToken),
    email_verify_expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    email_verify_last_sent: now,
    // Legacy single-value fields kept for backward compatibility; the matching
    // profile below is the canonical source going forward.
    country_of_origin: v.country_of_origin,
    field_of_interest: v.field_of_interest,
    target_degree_level: v.degree_level || v.target_degree_level,
    // Matching profile (may be empty at signup; filled via onboarding/account).
    fields_of_interest: v.fields_of_interest,
    budget_max_eur_year: v.budget_max_eur_year,
    preferred_languages: v.preferred_languages,
    degree_level: v.degree_level,
    city_preference: v.city_preference,
    country_preference: v.country_preference,
    home_country: v.home_country || v.country_of_origin,
    saved_universities: [],
    // Self-reported study-abroad milestones (the Timeline's "self" stages).
    // Older accounts predating this field read as [] everywhere (defensive
    // reads in lib/journey.js and the milestone endpoint) — no migration.
    milestones: [],
    consent_accepted: true,
    consent_date: now,
    // Separate opt-in for product-update emails (new universities,
    // scholarships). No sending infrastructure yet — the admin dashboard
    // exports opted-in addresses; wire an email provider behind that list
    // when one exists.
    updates_optin: v.updates_optin === true,
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

  // Fire-and-forget: sendVerificationEmail never throws (lib/email.js catches
  // its own failures), and registration must succeed regardless of whether
  // mail delivery does.
  email.sendVerificationEmail(student, `${appOrigin(req)}/verify-email?token=${verifyToken}`).catch(() => {});

  auth.setAuthCookie(res, student);
  res.status(201).json({ student: publicStudent(student) });
}));

api.post('/auth/login', loginLimiter, asyncRoute(async (req, res) => {
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
}));

api.post('/auth/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

api.get('/auth/me', auth.requireAuth, (req, res) => {
  res.json({ student: publicStudent(req.student) });
});

// ---- Email verification -----------------------------------------------------

// Token entropy (32 random bytes) already makes guessing infeasible, but this
// stays consistent with every other public mutating route in the app having
// a limiter — defense in depth against volumetric abuse, not brute-forcing.
const verifyEmailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Try again in a few minutes.' });

api.post('/auth/verify-email', verifyEmailLimiter, asyncRoute(async (req, res) => {
  const result = validate.token(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const students = store.read('students');
  const tokenHash = auth.hashToken(result.value.token);
  const student = students.find((s) => s.email_verify_token_hash === tokenHash);

  if (!student || !student.email_verify_expires || new Date(student.email_verify_expires) < new Date()) {
    return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
  }

  student.email_verified = true;
  student.email_verify_token_hash = null;
  student.email_verify_expires = null;
  store.write('students', students);
  events.record('email_verified', { anon: req.anon });

  email.sendEmailVerifiedEmail(student).catch(() => {});
  res.json({ ok: true });
}));

const resendVerificationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many attempts. Try again in a few minutes.' });
const RESEND_COOLDOWN_MS = 60 * 1000;

api.post('/me/resend-verification', auth.requireAuth, resendVerificationLimiter, asyncRoute(async (req, res) => {
  if (!email.ENABLED) return res.status(400).json({ error: 'Email verification is not enabled.' });
  if (req.student.email_verified) return res.json({ ok: true, already_verified: true });

  const students = store.read('students');
  const student = students.find((s) => s.student_id === req.student.student_id);
  const lastSent = student.email_verify_last_sent ? new Date(student.email_verify_last_sent).getTime() : 0;
  if (Date.now() - lastSent < RESEND_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Please wait a minute before requesting another email.' });
  }

  const verifyToken = auth.generateToken();
  student.email_verify_token_hash = auth.hashToken(verifyToken);
  student.email_verify_expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  student.email_verify_last_sent = new Date().toISOString();
  store.write('students', students);

  await email.sendVerificationEmail(student, `${appOrigin(req)}/verify-email?token=${verifyToken}`);
  res.json({ ok: true });
}));

// Changing the account email is security-sensitive (it's the account-recovery
// identifier), so it requires re-entering the current password even though
// the request is already authenticated — a hijacked session cookie alone
// isn't enough to take the account over this way. Same rate-limit tier as
// login since it does the same bcrypt.compare against a real password.
const changeEmailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });

api.post('/me/change-email', auth.requireAuth, changeEmailLimiter, asyncRoute(async (req, res) => {
  const result = validate.changeEmail(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const { new_email, password } = result.value;

  const students = store.read('students');
  const student = students.find((s) => s.student_id === req.student.student_id);
  const ok = await bcrypt.compare(password, student.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });

  if (new_email === student.email) return res.status(400).json({ error: 'That is already your email address.' });
  if (students.some((s) => s.email === new_email)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const oldEmail = student.email;
  const verifyToken = auth.generateToken();
  student.email = new_email;
  // The new address hasn't been proven yet — re-verification is mandatory,
  // not optional, regardless of whether the account was verified before.
  student.email_verified = false;
  student.email_verify_token_hash = auth.hashToken(verifyToken);
  student.email_verify_expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  student.email_verify_last_sent = new Date().toISOString();
  // Invalidate every OTHER session (same mechanism as password reset). This
  // request's own session is kept alive by re-issuing its cookie below with
  // the bumped version, so the user making the change isn't logged out.
  student.token_version = (student.token_version || 0) + 1;
  store.write('students', students);
  events.record('email_changed', { anon: req.anon });

  email.sendVerificationEmail(student, `${appOrigin(req)}/verify-email?token=${verifyToken}`).catch(() => {});
  email.sendEmailChangedNotice(student.full_name, oldEmail, new_email).catch(() => {});

  auth.setAuthCookie(res, student);
  res.json({ student: publicStudent(student) });
}));

// ---- Password reset ---------------------------------------------------------

const forgotPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many attempts. Try again in a few minutes.' });

api.post('/auth/forgot-password', forgotPasswordLimiter, asyncRoute(async (req, res) => {
  const result = validate.forgotPassword(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const students = store.read('students');
  const student = students.find((s) => s.email === result.value.email);
  // Always the same response whether or not the account exists — the account
  // lookup and email send only happen on the real path, but the response
  // never tells a caller which case they hit (avoid enumeration).
  if (student) {
    const resetToken = auth.generateToken();
    student.password_reset_token_hash = auth.hashToken(resetToken);
    student.password_reset_expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    store.write('students', students);
    email.sendPasswordResetEmail(student, `${appOrigin(req)}/reset-password?token=${resetToken}`).catch(() => {});
  }
  res.json({ ok: true });
}));

const resetPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });

api.post('/auth/reset-password', resetPasswordLimiter, asyncRoute(async (req, res) => {
  const result = validate.resetPassword(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const students = store.read('students');
  const tokenHash = auth.hashToken(result.value.token);
  const student = students.find((s) => s.password_reset_token_hash === tokenHash);

  if (!student || !student.password_reset_expires || new Date(student.password_reset_expires) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  }

  student.password_hash = await bcrypt.hash(result.value.password, cfg.BCRYPT_ROUNDS);
  student.password_reset_token_hash = null;
  student.password_reset_expires = null;
  // Every outstanding session (this device and any other) is signed with the
  // old token_version and is now rejected — the same revocation path Phase 2
  // added for "log out everywhere", triggered here for the first time by a
  // real password change.
  student.token_version = (student.token_version || 0) + 1;
  store.write('students', students);
  auth.clearAuthCookie(res);
  events.record('password_reset', { anon: req.anon });

  res.json({ ok: true });
}));

// Update the matching profile (onboarding wizard + /account editor). Every
// field optional; replaces the profile wholesale with the validated set.
api.patch('/me/profile', auth.requireAuth, requireVerifiedEmail, (req, res) => {
  const result = validate.profile(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const p = result.value;

  const students = store.read('students');
  const student = students.find((s) => s.student_id === req.student.student_id);
  Object.assign(student, p, {
    // keep the legacy mirrors in sync so older readers don't drift
    target_degree_level: p.degree_level || student.target_degree_level,
    field_of_interest: p.fields_of_interest[0] || student.field_of_interest,
    country_of_origin: p.home_country || student.country_of_origin,
  });
  store.write('students', students);
  events.record('profile_update', { anon: req.anon });
  res.json({ student: publicStudent(student) });
});

// Invalidate every outstanding session for this student (e.g. "this wasn't me"
// on a shared/lost device) by bumping token_version — every JWT signed before
// this call carries the old version and is rejected by auth.loadStudent.
// Clears the cookie on THIS device too, so the user re-authenticates
// everywhere, including here.
api.post('/me/logout-everywhere', auth.requireAuth, (req, res) => {
  const students = store.read('students');
  const student = students.find((s) => s.student_id === req.student.student_id);
  student.token_version = (student.token_version || 0) + 1;
  store.write('students', students);
  auth.clearAuthCookie(res);
  events.record('logout_everywhere', { anon: req.anon });
  res.json({ ok: true });
});

// ---- Universities ---------------------------------------------------------

// The two highest-traffic public routes previously had no limiter at all,
// unlike every other route below. Limits are generous — this is normal browse
// traffic (filter changes, pagination, search-as-you-type), not an auth
// surface — just enough to blunt a scraping/DoS burst from one IP.
// NOTE: the detail route's bucket key includes req.path (see lib/rate-limit.js),
// so it's effectively keyed per (ip, university id) — the same partitioning
// photoLimiter already has. It stops a hammer on one profile; it doesn't stop
// a slow crawl across many different ids from one IP. Accepted for now,
// consistent with the existing limiter's design; revisit if that's ever abused.
const universitiesLimiter = rateLimit({ windowMs: 60 * 1000, max: 180 });
const universityDetailLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

api.get('/universities/filters', (_req, res) => res.json(FILTERS));

api.get('/universities', universitiesLimiter, (req, res) => {
  // A logged-in student with a matching profile gets fit-ranked results by
  // default (the ranking is self-explanatory via a per-card reason). Anonymous
  // or profile-less visitors keep the plain browse ordering. Explicit sorts
  // the user picks always win.
  const student = auth.loadStudent(req);
  const profiled = student && match.hasProfile(student);
  const params = { ...req.query };
  if (profiled && !params.sort && !params.q) params.sort = 'match';
  const scoreFn = profiled ? (u) => match.matchUniversity(student, u).score : undefined;

  const result = search.query(INDEX, params, clickOf, { scoreFn });
  result.universities = result.universities.map((u) => {
    const withP = withPhoto(u);
    // Attach a compressed per-card reason only when we actually ranked by fit.
    if (profiled && params.sort === 'match') {
      const m = match.matchUniversity(student, u);
      const reason = explain.compressedReason(m.components);
      if (reason) withP.match_reasons = [reason];
    }
    return withP;
  });
  result.sort = params.sort || (req.query.q ? 'relevance' : 'name');
  const q = String(req.query.q || '').trim();
  if (q) {
    events.record('search', { anon: req.anon, results: result.count, q: q.slice(0, 80) });
  }
  res.json(result);
});

api.get('/universities/:id', universityDetailLimiter, asyncRoute(async (req, res) => {
  if (SLUG_REDIRECTS[req.params.id]) {
    return res.redirect(301, `/api/universities/${encodeURIComponent(SLUG_REDIRECTS[req.params.id])}`);
  }
  const uni = BY_ID.get(req.params.id);
  if (!uni) return res.status(404).json({ error: 'University not found.' });
  const out = withClaim(withPhoto({ ...uni, click_count: clickOf(uni.id) }));

  // A logged-in student with a matching profile gets the transparent, rule-based
  // "why this fits you" — the fired components plus a one-line explanation
  // (structured today; a cached model sentence once the LLM seam is switched
  // on). No profile / anonymous → the client shows plain structured facts with
  // no personalization claim.
  const student = auth.loadStudent(req);
  if (student && match.hasProfile(student)) {
    const m = match.scoreUniversity(student, uni);
    out.match_components = m.components;
    out.match_reasons = m.components.map((c) => c.label);
    out.match_flags = m.flags;
    out.match_explanation = await explain.generate(student, uni, m.components, m.flags);
  }
  res.json({ university: out });
}));

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

// Resolve + cache a university's photo (shared by the endpoint below and the
// curated-universities prewarm at boot). Dedupes concurrent lookups for the
// same id via photoInflight.
function resolvePhoto(uni) {
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
  return photoInflight.get(uni.id);
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

  try {
    reply(await resolvePhoto(uni), false);
  } catch (e) {
    log.captureError(e, { where: 'photo', uni: uni.id });
    res.json({ photo_url: null, attribution: null, extract: null, cached: false });
  }
});

// Pre-warm photos for the whole verified tier (the default Discover view) so
// its cards show real photos from the first grid load, not only after someone
// happens to open a profile. Bounded (≈300 lookups worst case, and only for
// ids not already in the photo cache — after the first boot on a persistent
// volume this is a no-op), sequential with a small delay to be a polite
// Wikipedia client, entirely non-blocking. Curated records go first so the
// flagship cards fill in earliest.
async function warmVerifiedPhotos() {
  const cache = store.read('photos');
  const targets = UNIVERSITIES
    .filter((u) => u.verified && !cache[u.id])
    .sort((a, b) => (a.source === 'curated' ? 0 : 1) - (b.source === 'curated' ? 0 : 1));
  for (const uni of targets) {
    try { await resolvePhoto(uni); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (targets.length) log.info('verified-tier photo prewarm complete', { count: targets.length });
}

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
    .map((u) => withPhoto({ ...u, click_count: clickOf(u.id) }));
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
    .map((u) => withPhoto({ ...u, click_count: clickOf(u.id) }));
  res.json({ universities: results });
});

// ---- My Journey ------------------------------------------------------------
//
// One call assembles the whole personalized dashboard (the client makes a
// single request, not five). Everything is derived from data we already have:
// the student's matching profile, their saved list, the deterministic matcher,
// and the honest country-level scholarship pointers (lib/scholarships.js — real
// named schemes, flagged verify:true, never fabricated per-university amounts).
// No new university-side data, no invented milestones.
api.get('/me/journey', auth.requireAuth, (req, res) => {
  const student = req.student;
  const savedIds = student.saved_universities || [];

  // Saved (resolved to full records, capped for the summary card).
  const saved = savedIds
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .map((u) => withPhoto({ ...u, click_count: clickOf(u.id) }));

  const completeness = journey.profileCompleteness(student);
  const profiled = match.hasProfile(student);

  // Match-ranked next picks (excludes what's already saved). Each carries a
  // compressed "why" reason, exactly like the Discover cards — same matcher,
  // same explanation layer, no duplicated ranking logic.
  const excludeIds = new Set(savedIds);
  const picks = profiled
    ? match.recommend(student, UNIVERSITIES, { limit: 4, excludeIds }).map((u) => {
        const withP = withPhoto({ ...u, click_count: clickOf(u.id) });
        const m = match.scoreUniversity(student, u);
        const reason = explain.compressedReason(m.components);
        if (reason) withP.match_reasons = [reason];
        return withP;
      })
    : [];

  // Scholarship pointers for the student's home country (finally surfaced —
  // lib/scholarships.js had tests but no live endpoint until now).
  const homeCountry = student.home_country || student.country_of_origin || '';
  const scholarships = homeCountry ? scholarshipsFor(homeCountry) : [];

  res.json({
    completeness,
    has_profile: profiled,
    saved: { count: saved.length, universities: saved.slice(0, 6) },
    picks,
    scholarships,
    home_country: homeCountry,
    next_actions: journey.nextActions(saved.length, completeness),
    timeline: journey.buildTimeline(profiled, saved.length, student.milestones),
  });
});

// Toggle a self-reported timeline milestone. Only the "self" keys are
// settable — the auto stages (account/profile/shortlist) reflect real state
// and are never client-writable.
api.post('/me/milestone', auth.requireAuth, (req, res) => {
  const key = typeof req.body.key === 'string' ? req.body.key : '';
  if (!journey.SELF_MILESTONE_KEYS.has(key)) return res.status(400).json({ error: 'Unknown milestone.' });
  const done = req.body.done === true;

  const students = store.read('students');
  const student = students.find((s) => s.student_id === req.student.student_id);
  const set = new Set(Array.isArray(student.milestones) ? student.milestones : []);
  if (done) set.add(key); else set.delete(key);
  student.milestones = [...set];
  store.write('students', students);
  events.record('milestone', { anon: req.anon, ...(done ? { set: key } : {}) });
  res.json({ milestones: student.milestones });
});

// ---- GDPR: data export + account deletion ---------------------------------

api.get('/me/export', auth.requireAuth, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="universo-my-data.json"');
  res.json({ exported_at: new Date().toISOString(), account: publicStudent(req.student) });
});

api.delete('/me', auth.requireAuth, asyncRoute(async (req, res) => {
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
}));

// ---- University lead capture ------------------------------------------------
//
// The landing page's "For universities" contact form. No student waitlist
// exists anymore — students sign up directly. Public, unauthenticated POST, so
// it's rate-limited per IP and honeypot-protected.

const leadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many submissions. Try again in a few minutes.' });

api.post('/pilot-leads', leadLimiter, (req, res) => {
  // Bots get a normal-looking success so tripping the honeypot doesn't teach
  // them to route around it — they just never get persisted.
  if (validate.isBotSubmission(req.body)) return res.status(201).json({ ok: true });

  const result = validate.pilotLead(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const leads = store.read('pilot_leads');
  leads.push({ id: crypto.randomUUID(), ...result.value, created_at: new Date().toISOString(), anon: req.anon || null });
  store.write('pilot_leads', leads);
  events.record('pilot_lead', { anon: req.anon });

  res.status(201).json({ ok: true });
});

// ---- University partner auth + analytics ------------------------------------
//
// One shared dashboard build (/partners); every endpoint below scopes to the
// university bound to the SESSION's account — the client never supplies a
// university id. That server-side scoping is the row-level-security equivalent
// for this storage layer: frontend checks are cosmetic, this is the enforcement.

const uniLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });

api.post('/uni/login', uniLoginLimiter, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const account = uniAuth.findByEmail(email);
  const hash = account ? account.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!account || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  uniAuth.setUniCookie(res, account);
  res.json({ account: { email: account.email, university_id: account.university_id, university_name: account.university_name } });
}));

api.post('/uni/logout', (_req, res) => { uniAuth.clearUniCookie(res); res.json({ ok: true }); });

api.get('/uni/me', uniAuth.requireUni, (req, res) => {
  const a = req.uniAccount;
  res.json({ account: { email: a.email, university_id: a.university_id, university_name: a.university_name } });
});

// Daily views/saves/apply-clicks for the session's OWN university, plus a
// viewer-country breakdown (event anon ids joined to student profiles where
// that link exists; everyone else counts as "Unknown").
api.get('/uni/stats', uniAuth.requireUni, (req, res) => {
  const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || ''), 10) || 30));
  const uni = BY_ID.get(req.uniAccount.university_id);
  const ts = events.uniTimeseries(req.uniAccount.university_id, { days });

  const anonToCountry = new Map();
  for (const s of store.read('students')) {
    for (const anon of s.anon_ids || []) anonToCountry.set(anon, s.country_of_origin || 'Unknown');
  }
  const countryCounts = new Map();
  for (const anon of ts.viewer_anons) {
    const c = anonToCountry.get(anon) || 'Unknown';
    countryCounts.set(c, (countryCounts.get(c) || 0) + 1);
  }
  const viewer_countries = [...countryCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([country, viewers]) => ({ country: country || 'Unknown', viewers }));

  res.json({
    university: { id: req.uniAccount.university_id, name: uni ? uni.name : req.uniAccount.university_name },
    days: ts.days,
    series: ts.series,
    totals: { ...ts.totals, unique_viewers: ts.viewer_anons.length },
    viewer_countries,
  });
});

// ---- Admin auth -------------------------------------------------------------

const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });

api.post('/admin/login', adminLoginLimiter, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const admin = adminAuth.findAdminByEmail(email);
  const hash = admin ? admin.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!admin || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });

  adminAuth.setAdminCookie(res, admin);
  res.json({ admin: { email: admin.email } });
}));

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
      universities_verified: VERIFIED_COUNT,
      pilot_leads: store.read('pilot_leads').length,
      update_subscribers: students.filter((x) => x.updates_optin).length,
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

// University contact/pilot leads — the actual rows, newest first, so a lead
// can be followed up from the dashboard without shelling into the server.
adminApi.get('/leads', (_req, res) => {
  const leads = [...store.read('pilot_leads')].reverse();
  res.json({ count: leads.length, leads });
});

// Create a partner login for a verified claim: binds an email+password to one
// university and marks that university claimed. This IS the claim-approval
// step — a human (admin) checks the requester actually works there first.
adminApi.post('/uni-accounts', async (req, res) => {
  const { email, password, university_id } = req.body || {};
  const uni = BY_ID.get(String(university_id || ''));
  if (!uni) return res.status(404).json({ error: 'University not found. Pass a valid university_id.' });
  try {
    const account = await uniAuth.createUniAccount({ email, password, university_id: uni.id, university_name: uni.name });
    const claims = store.read('claims');
    claims[uni.id] = { account_id: account.account_id, claimed_at: new Date().toISOString() };
    await store.write('claims', claims);
    log.info('university claimed', { university: uni.id });
    res.status(201).json({ account, university: { id: uni.id, name: uni.name, claimed_status: 'claimed' } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Product-update subscribers (students who opted in at sign-up), as CSV — lets
// the founders send an update through any mail tool today. This is the seam
// where a real email provider (Resend/Postmark/SES) plugs in later: same list,
// automated sending instead of an export.
adminApi.get('/subscribers.csv', (_req, res) => {
  const subs = store.read('students').filter((s) => s.updates_optin);
  const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
  const rows = subs.map((s) => [esc(s.email), esc(s.full_name), esc(s.country_of_origin), esc(s.signup_date)].join(','));
  res.setHeader('Content-Disposition', 'attachment; filename="universo-update-subscribers.csv"');
  res.type('text/csv').send(['email,full_name,country_of_origin,signup_date', ...rows].join('\n') + '\n');
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
const FOR_UNIVERSITIES = (() => {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'for-universities.html'), 'utf8');
  const fmt = (n) => n.toLocaleString('en-US');
  return raw
    .replace(/\{\{TOTAL_RAW\}\}/g, String(PLATFORM_COUNTS.total))
    .replace(/\{\{TOTAL\}\}/g, fmt(PLATFORM_COUNTS.total))
    .replace(/\{\{VERIFIED_RAW\}\}/g, String(PLATFORM_COUNTS.verified))
    .replace(/\{\{VERIFIED\}\}/g, fmt(PLATFORM_COUNTS.verified))
    .replace(/\{\{COUNTRIES_RAW\}\}/g, String(PLATFORM_COUNTS.countries))
    .replace(/\{\{COUNTRIES\}\}/g, fmt(PLATFORM_COUNTS.countries));
})();
// redirect:false — public/join is a real directory (the built React app), and
// the default directory-redirect (/join → /join/) would 301 every request to
// that route before it ever reaches the app.get('/join') handler below.
app.use(express.static(PUBLIC_DIR, { index: false, redirect: false }));

app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// Partner dashboard — one shared static page for every university account;
// which university's data it shows is decided by the session server-side.
app.get('/partners', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'partners.html')));

// Public, no-login SALES demo of the partner dashboard — clearly labelled
// "example data, not live". Sells the value prop before a university claims.
app.get('/partners/demo', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'partners-demo.html')));

// The B2B pitch (analytics, claim-a-profile, pilot contact form) lives on its
// own page, off the student-facing homepage.
app.get('/for-universities', (req, res) => {
  events.record('pageview', {
    anon: req.anon,
    path: '/for-universities',
    ref: refDomain(req),
    lang: (req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim().slice(0, 10),
    device: /mobile/i.test(req.get('User-Agent') || '') ? 'mobile' : 'desktop',
  });
  res.send(FOR_UNIVERSITIES);
});

// Old routes that used to carry this content — permanent redirects so shared
// links keep working.
app.get('/join', (_req, res) => res.redirect(301, '/for-universities'));

app.get('/robots.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  // Operational/account surfaces carry no unique public content — keep
  // crawlers out of them (they're also noindex'd at the page level).
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /partners',
    'Disallow: /saved',
    'Disallow: /account',
    'Allow: /',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n'));
});

let sitemapCache = null; // dataset is static — build once
app.get('/sitemap.xml', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  if (!sitemapCache) {
    // Only VERIFIED profiles are submitted for indexing. The ~3,700
    // register-only records are near-duplicate boilerplate (name, city, type,
    // enrolment) with no tuition, programs or entry requirements — asking
    // Google to index them invites a thin-content judgement on the whole
    // domain. They stay reachable and crawlable (noindex,follow on the page
    // itself), so their outbound links still pass, but they're not advertised.
    const urls = ['discover', 'for-universities', ...UNIVERSITIES.filter((u) => u.verified).map((u) => `university/${u.id}`)]
      .map((p) => `  <url><loc>${base}/${p}</loc></url>`).join('\n');
    sitemapCache = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  }
  res.type('application/xml').send(sitemapCache);
});

// Server-rendered profile pages (real HTML + per-page meta for crawlers).
app.get('/university/:id', (req, res) => {
  if (SLUG_REDIRECTS[req.params.id]) {
    return res.redirect(301, `/university/${encodeURIComponent(SLUG_REDIRECTS[req.params.id])}`);
  }
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
      // Unverified = register-only boilerplate. noindex,FOLLOW: keep it out of
      // the index without orphaning the links on it. A profile becomes
      // indexable the moment it earns real content (or a university claims it).
      noindex: uni.verified ? false : 'follow',
    }),
    viewHtml: ssr.profileView(withClaim(uni)),
  }));
});

// The homepage IS the product: visitors see real, browsable university data
// immediately instead of a marketing page. Permanent redirect keeps one
// canonical URL for the directory.
app.get('/', (_req, res) => res.redirect(301, '/discover'));

// Public, account-free directory — browsing and searching require nothing.
// Only actions gate on login (saving, recommendations), enforced at their own
// endpoints; the page itself is open and server-rendered for crawlers. Its
// pageview is recorded server-side so anonymous first visits (the top of the
// funnel) aren't invisible to analytics.
app.get('/discover', (req, res) => {
  events.record('pageview', {
    anon: req.anon,
    path: '/discover',
    ref: refDomain(req),
    lang: (req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim().slice(0, 10),
    device: /mobile/i.test(req.get('User-Agent') || '') ? 'mobile' : 'desktop',
  });
  // SSR mirrors the client default: verified profiles first impression.
  const list = search.query(INDEX, { limit: 50, verified: '1' }, clickOf).universities;
  res.send(ssr.injectSSR(SHELL, {
    metaHtml: ssr.metaTags({
      title: 'Discover universities in Europe — Universo',
      description: `${VERIFIED_COUNT} verified EU university profiles — tuition, scholarships and apply links — in a directory of ${UNIVERSITIES.length.toLocaleString('en-US')} European institutions. Free to browse.`,
      canonical: `${baseUrl(req)}/discover`,
    }),
    viewHtml: ssr.directoryView(list, UNIVERSITIES.length),
  }));
});

// /saved and /account previously fell through to the bare SPA shell: empty
// <main>, stale default meta, and indexable. They now ship real fallback
// content (visible before/without JS — the SPA replaces it on hydrate),
// page-appropriate meta, and noindex (no unique public content on either).
app.get('/saved', (_req, res) => {
  res.send(ssr.injectSSR(SHELL, {
    metaHtml: ssr.metaTags({
      title: 'Your saved universities — Universo',
      description: 'Your personal shortlist of European universities on Universo.',
      noindex: true,
    }),
    viewHtml: `
      <section class="ssr">
        <h1>Your saved universities</h1>
        <p>Sign in to see your shortlist — saving universities is free, always.</p>
        <p><a href="/account">Sign in</a> · <a href="/account?mode=register&src=saved-ssr">Create a free account</a></p>
      </section>`,
  }));
});

app.get('/journey', (_req, res) => {
  res.send(ssr.injectSSR(SHELL, {
    metaHtml: ssr.metaTags({
      title: 'My Journey — Universo',
      description: 'Your personal study-abroad dashboard on Universo: matches, saved universities, scholarships and your next steps.',
      noindex: true,
    }),
    viewHtml: `
      <section class="ssr">
        <h1>My Journey</h1>
        <p>Sign in to see your matches, saved universities, scholarship pointers and your next steps — free, always.</p>
        <p><a href="/account">Sign in</a> · <a href="/account?mode=register&src=journey-ssr">Create a free account</a></p>
      </section>`,
  }));
});

app.get('/account', (_req, res) => {
  res.send(ssr.injectSSR(SHELL, {
    metaHtml: ssr.metaTags({
      title: 'Sign in or create your free account — Universo',
      description: 'Log in to Universo or create a free student account to save universities and get matched to programs across Europe.',
      noindex: true,
    }),
    viewHtml: `
      <section class="ssr">
        <h1>Sign in or create your free account</h1>
        <p>Save a shortlist of European universities and get matches for your profile. Free for students, always.</p>
        <form>
          <!-- Disabled until the app's JS takes over: a plain-HTML submit would
               put credentials in the URL (GET) or POST them nowhere. The SPA
               replaces this whole view with the working form on load. -->
          <fieldset disabled>
            <p><label>Email<br /><input type="email" name="email" autocomplete="email" /></label></p>
            <p><label>Password<br /><input type="password" name="password" autocomplete="current-password" /></label></p>
            <p><button type="submit">Log in</button></p>
          </fieldset>
        </form>
        <p>New here? <a href="/account?mode=register">Create a free account</a>. Signing in requires JavaScript.</p>
      </section>`,
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
    log.info('listening', { url: `http://localhost:${cfg.PORT}`, universities: UNIVERSITIES.length, errorMonitoring: log.errorMonitoringEnabled, aiExplanations: explain.LLM_ENABLED });
    process.stdout.write(`\n  Universo → http://localhost:${cfg.PORT}   (admin: /admin)\n  ${UNIVERSITIES.length.toLocaleString('en-US')} universities loaded\n\n`);
  });
  if (!process.env.SKIP_PHOTO_PREWARM) warmVerifiedPhotos().catch((e) => log.warn('photo prewarm failed', { error: e.message }));

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
