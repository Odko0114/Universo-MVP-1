"use strict";

/**
 * Universo — backend.
 *
 * Express API + static SPA with server-side rendering for SEO. Logic lives in
 * focused modules under lib/ (auth, search, events, ssr, store…); this file wires
 * them into routes. File-based JSON storage (see lib/store.js) behind a
 * repository seam — swap for a database before real traffic.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");
const bcrypt = require("bcryptjs");

const cfg = require("./lib/config");
const log = require("./lib/log");
const store = require("./lib/store");
const { buildDataset } = require("./lib/dataset");
const auth = require("./lib/auth");
const adminAuth = require("./lib/admin-auth");
const uniAuth = require("./lib/uni-auth");
const search = require("./lib/search");
const match = require("./lib/match");
const explain = require("./lib/explain");
const journey = require("./lib/journey");
const dataQuality = require("./lib/data-quality");
const {
  scholarshipsFor,
  scholarshipsForDestinations,
  scholarshipsOutbound,
  catalog: scholarshipCatalog,
} = require("./lib/scholarships");
const curatedScholarships = require("./lib/scholarships-curated");
const notify = require("./lib/notify");
const brand = require("./lib/brand");
const events = require("./lib/events");
const validate = require("./lib/validate");
const ssr = require("./lib/ssr");
const email = require("./lib/email");
const photos = require("./lib/photos");
const { rateLimit } = require("./lib/rate-limit");
const { fetchWithResilience } = require("./lib/http");

// ---------------------------------------------------------------------------
// Storage bootstrap
// ---------------------------------------------------------------------------
// Universities are DERIVED data (rebuilt from data/seed/* every boot) — use
// initFresh so a stale copy on a persistent volume can never shadow updated
// seed data after a deploy. Everything user-generated below uses init().
store.initFresh("universities", buildDataset());
store.init("students", []);
store.init("admins", []);
store.init("clicks", {}); // { universityId: count } — kept separate so a click
// never rewrites the ~12k-record universities file.
store.init("photos", {}); // { id: { photo_url|null, attribution, cached_at } }
// Give entries from an older lookup strategy one retry: seals cached as photos,
// and misses that were really timeouts recorded as permanent. Real photos are
// left alone. No-op once every entry carries the current version.
{
  const cache = store.read("photos");
  const dropped = photos.dropStale(cache);
  if (dropped) {
    store.write("photos", cache);
    log.info("photos.dropped_stale", {
      count: dropped,
      version: photos.LOOKUP_VERSION,
    });
  }
}
store.init("pilot_leads", []); // university contact/pilot/claim leads (/for-universities form)
store.init("uni_accounts", []); // partner logins, each bound to one university_id
store.init("claims", {}); // { universityId: { account_id, claimed_at } } — kept
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
  throw new Error(
    "UNIVERSO_APP_URL must be set in production once RESEND_API_KEY is set — verification/reset links would otherwise be built from the spoofable request Host header.",
  );
}
events
  .rotateIfLarge()
  .catch((e) =>
    log.warn("startup event-log rotation check failed", { error: e.message }),
  );

const UNIVERSITIES = store.read("universities");
const INDEX = search.buildIndex(UNIVERSITIES); // built once (dataset is static)
const FILTERS = search.buildFilters(UNIVERSITIES); // cached
// Non-EU universities that exist ONLY as part of a curated scholarship (e.g. the
// Chinese universities under CSC). They are deliberately NOT in UNIVERSITIES /
// INDEX / FILTERS / recommendations, so normal EU Discover, filters and counts
// never surface them — they're reachable only through the scholarship (the `via`
// path) or a direct profile link. Added to BY_ID so those two paths resolve them.
let SCHOLARSHIP_UNIS = [];
try {
  SCHOLARSHIP_UNIS = require("./data/scholarship-universities.json");
  if (!Array.isArray(SCHOLARSHIP_UNIS)) SCHOLARSHIP_UNIS = [];
} catch {
  SCHOLARSHIP_UNIS = [];
}
const BY_ID = new Map(
  [...UNIVERSITIES, ...SCHOLARSHIP_UNIS].map((u) => [u.id, u]),
);

// Internal data-quality audit — computed ONCE at boot (the dataset is static),
// never per user request (Phase 10 / performance). Admin-only: the aggregate
// and the per-record score index below are read only by requireAdmin routes,
// never included in public university responses (Security requirement).
const DATASET_AUDIT = dataQuality.auditDataset(UNIVERSITIES);
const QUALITY_RECORDS = UNIVERSITIES.map((u) => {
  const { score, band, missing } = dataQuality.scoreRecord(u);
  return {
    id: u.id,
    name: u.name,
    country: u.country,
    source: u.source,
    verification_status: u.verification_status,
    last_verified_at: u.last_verified_at,
    last_updated_at: u.last_updated_at,
    stale: u.stale,
    score,
    band,
    missing: missing.map((m) => m.label),
  };
});
// Old slugs of deduplicated records → their surviving slug (301s, never 404s).
const SLUG_REDIRECTS = require("./lib/dataset").slugRedirects();
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
FILTERS.counts = {
  total: PLATFORM_COUNTS.total,
  verified: PLATFORM_COUNTS.verified,
};

const clickOf = (id) => store.read("clicks")[id] || 0;

// Cached cover photo (never triggers a fresh Wikipedia lookup — reads only
// what /photo has already resolved and cached). Lets card grids show real
// photos progressively as profiles get viewed, without a lookup stampede on
// every search. `withPhoto` is applied everywhere a card list is returned.
const photoOf = (id) => {
  const p = store.read("photos")[id];
  return p && !p.none ? p.photo_url || null : null;
};
const withPhoto = (u) => ({ ...u, cover_photo_url: photoOf(u.id) });

// Claim status is stored in its own collection (see the claims init note) and
// overlaid at read time, since the universities file is rebuilt from seed at
// every boot and would lose a stored flag.
const claimedStatusOf = (id) =>
  store.read("claims")[id] ? "claimed" : "unclaimed";
const withClaim = (u) => ({ ...u, claimed_status: claimedStatusOf(u.id) });

// ---------------------------------------------------------------------------
// App + global middleware
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", true);
app.use(compression()); // gzip/brotli — the filter/search JSON responses are big
app.use(express.json({ limit: "16kb" }));

// Canonical-host redirect. Dormant until UNIVERSO_APP_URL is set, which makes
// it the switch for the custom-domain cutover: until then every host serves
// normally, and the moment it's configured the old *.onrender.com address
// starts sending visitors and crawlers to the real domain instead of quietly
// serving a second, competing copy of the whole site.
//
// Deliberately narrow:
//   - GET/HEAD only. Redirecting a POST would drop its body, so writes are
//     served on whatever host they arrive at rather than silently broken.
//   - /healthz is exempt: Render's health check may call an internal hostname,
//     and a 3xx there can read as an unhealthy service.
//   - No-ops when the host already matches, so there is no redirect loop.
app.use((req, res, next) => {
  if (!process.env.UNIVERSO_APP_URL) return next();
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path === "/healthz") return next();

  let want;
  try {
    want = new URL(appOrigin(req));
  } catch {
    return next(); // malformed env value — never take the site down over it
  }
  if (req.get("host") === want.host) return next();

  return res.redirect(301, `${want.origin}${req.originalUrl}`);
});

// Baseline security headers (a CSP is deliberately omitted for now — the SPA
// uses inline styles throughout, so a useful CSP needs a dedicated pass).
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});

// Request id + structured access log (no PII).
app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  const start = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api/")) {
      log.info("req", {
        id: req.id,
        m: req.method,
        p: req.path,
        s: res.statusCode,
        ms: Date.now() - start,
      });
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
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const baseUrl = (req) => `${req.protocol}://${req.get("host")}`;

// Security-sensitive links (email verification, password reset) must NOT be
// built from the request's Host header — it's client-supplied and can be
// spoofed (a classic "password reset poisoning" vector: an attacker submits
// a victim's email with a forged Host, and the victim's own inbox delivers a
// link pointing at the attacker's domain, tokens and all). UNIVERSO_APP_URL
// is a trusted, server-configured origin; baseUrl(req) is only a fallback
// for local dev where that env var typically isn't set.
//
// Returns a bare origin (scheme://host) even when UNIVERSO_APP_URL is set to a
// full URL. Stripping only the trailing slash wasn't enough: a value carrying a
// path — `https://host/discover`, easily pasted from a browser address bar —
// got prepended to every route, producing /discover/discover in the sitemap and
// /discover/verify-email in email links. A function named appOrigin should
// return an origin whatever is in the variable.
const appOrigin = (req) => {
  const raw = process.env.UNIVERSO_APP_URL;
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      // Not parseable as a URL — fall through to the request-derived origin
      // rather than emitting a broken absolute link everywhere.
    }
  }
  return baseUrl(req).replace(/\/+$/, "");
};

// A matching profile is "complete enough" to switch the matching layer on once
// the student has stated at least a field of interest OR a degree OR a budget —
// the inputs the scorer actually needs. Kept deliberately low so a half-filled
// onboarding still gets ranked results.
const profileCompleted = (s) =>
  !!s &&
  ((s.fields_of_interest || []).length > 0 ||
    !!s.degree_level ||
    s.budget_max_eur_year != null);

const publicStudent = (s) => {
  if (!s) return null;
  const {
    password_hash,
    token_version,
    anon_ids,
    email_verify_token_hash,
    email_verify_expires,
    email_verify_last_sent,
    password_reset_token_hash,
    password_reset_expires,
    notifications: _rawNotifications,
    reminders_sent,
    last_digest_sent,
    ...safe
  } = s;
  return {
    ...safe,
    // Resolved against defaults so the client always sees every category.
    notifications: notify.notifPrefs(s),
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
// Auth caps are env-overridable so the test suite (many registrations/logins
// from one IP within the window) isn't throttled; production keeps the defaults.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.UNIVERSO_AUTH_RATE_MAX) || 20,
  message: "Too many attempts. Try again in a few minutes.",
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.UNIVERSO_LOGIN_RATE_MAX) || 10,
  message: "Too many attempts. Try again in a few minutes.",
});

// Gates content-creating actions on a verified email — a strict no-op while
// email.ENABLED is false (see lib/email.js), so this has zero effect on the
// app's current real users until a provider key is added. Applied after
// requireAuth, never in place of it.
function requireVerifiedEmail(req, res, next) {
  if (!email.ENABLED || req.student.email_verified) return next();
  res.status(403).json({
    error: "Please verify your email to continue.",
    code: "EMAIL_NOT_VERIFIED",
  });
}

api.post(
  "/auth/register",
  authLimiter,
  asyncRoute(async (req, res) => {
    const result = validate.registration(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const v = result.value;

    if (store.read("students").some((s) => s.email === v.email)) {
      return res
        .status(409)
        .json({ error: "An account with this email already exists." });
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
      email_verify_expires: new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString(),
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
      // Per-saved-university application status { uniId: status }. Older accounts
      // read as {} everywhere — no migration.
      applications: {},
      // Dream Plan: the explicit dream fields + self-tracked document checklist.
      // Older accounts default to empty/false/{} via defensive reads — no migration.
      target_intake: "",
      career_goal: "",
      scholarship_required: false,
      documents: {},
      // Self-tracked scholarship progress { schemeKey: { status, deadline } }.
      // Older accounts read as {} (and legacy string values normalize) — no migration.
      scholarships: {},
      // Optional expiry dates for shared documents { docKey: { expiry } }.
      document_meta: {},
      consent_accepted: true,
      consent_date: now,
      // Separate opt-in for product-update emails (new universities,
      // scholarships). No sending infrastructure yet — the admin dashboard
      // exports opted-in addresses; wire an email provider behind that list
      // when one exists.
      updates_optin: v.updates_optin === true,
      // Per-category email notification prefs (deadline reminders + weekly
      // digest). Empty {} reads as the defaults via lib/notify#notifPrefs — no
      // migration. Dedup timestamps prevent duplicate sends; the unsubscribe
      // link is a stateless HMAC (lib/auth#unsubscribeToken), nothing stored.
      notifications: {},
      last_digest_sent: "",
      reminders_sent: {},
      // Marks the previous Dream Plan visit, so "Since you were away" can show
      // honest deadline deltas. Older accounts read as "" — no migration.
      last_journey_view: "",
      signup_date: now,
      last_active_date: now,
      token_version: 0,
      // Anonymous client ids ever linked to this account — lets account deletion
      // purge the matching behavioral event trail (GDPR erasure), not just the
      // student record. Capped so a very long-lived account can't grow unbounded.
      anon_ids: req.anon ? [req.anon] : [],
    };

    const students = store.read("students");
    students.push(student);
    store.write("students", students);
    // `src` attributes the signup to a CTA (landing hero, gate, nav…) — funnel
    // attribution only, no PII. Whitelisted to a short slug.
    const src =
      typeof req.body.src === "string"
        ? req.body.src.slice(0, 24).replace(/[^a-z0-9_-]/gi, "")
        : "";
    events.record("signup", { anon: req.anon, ...(src ? { src } : {}) });
    log.info("signup", { students: students.length }); // count only — never the email

    // Fire-and-forget: sendVerificationEmail never throws (lib/email.js catches
    // its own failures), and registration must succeed regardless of whether
    // mail delivery does.
    email
      .sendVerificationEmail(
        student,
        `${appOrigin(req)}/verify-email?token=${verifyToken}`,
      )
      .catch(() => {});

    auth.setAuthCookie(res, student);
    res.status(201).json({ student: publicStudent(student) });
  }),
);

api.post(
  "/auth/login",
  loginLimiter,
  asyncRoute(async (req, res) => {
    const result = validate.login(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const { email, password } = result.value;

    const student = store.read("students").find((s) => s.email === email);
    // Constant-ish work whether or not the account exists (avoid user enumeration).
    const hash = student
      ? student.password_hash
      : "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
    const ok = await bcrypt.compare(password, hash);
    if (!student || !ok)
      return res.status(401).json({ error: "Incorrect email or password." });

    if (req.anon && !(student.anon_ids || []).includes(req.anon)) {
      student.anon_ids = [...(student.anon_ids || []), req.anon].slice(-20); // cap growth
      store.writeDebounced("students", store.read("students"));
    }

    auth.setAuthCookie(res, student);
    events.record("login", { anon: req.anon });
    res.json({ student: publicStudent(student) });
  }),
);

api.post("/auth/logout", (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

api.get("/auth/me", auth.requireAuth, (req, res) => {
  res.json({ student: publicStudent(req.student) });
});

// ---- Email verification -----------------------------------------------------

// Token entropy (32 random bytes) already makes guessing infeasible, but this
// stays consistent with every other public mutating route in the app having
// a limiter — defense in depth against volumetric abuse, not brute-forcing.
const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many attempts. Try again in a few minutes.",
});

api.post(
  "/auth/verify-email",
  verifyEmailLimiter,
  asyncRoute(async (req, res) => {
    const result = validate.token(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });

    const students = store.read("students");
    const tokenHash = auth.hashToken(result.value.token);
    const student = students.find(
      (s) => s.email_verify_token_hash === tokenHash,
    );

    if (
      !student ||
      !student.email_verify_expires ||
      new Date(student.email_verify_expires) < new Date()
    ) {
      return res
        .status(400)
        .json({ error: "This verification link is invalid or has expired." });
    }

    student.email_verified = true;
    student.email_verify_token_hash = null;
    student.email_verify_expires = null;
    store.write("students", students);
    events.record("email_verified", { anon: req.anon });

    email.sendEmailVerifiedEmail(student).catch(() => {});
    res.json({ ok: true });
  }),
);

const resendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many attempts. Try again in a few minutes.",
});
const RESEND_COOLDOWN_MS = 60 * 1000;

api.post(
  "/me/resend-verification",
  auth.requireAuth,
  resendVerificationLimiter,
  asyncRoute(async (req, res) => {
    if (!email.ENABLED)
      return res
        .status(400)
        .json({ error: "Email verification is not enabled." });
    if (req.student.email_verified)
      return res.json({ ok: true, already_verified: true });

    const students = store.read("students");
    const student = students.find(
      (s) => s.student_id === req.student.student_id,
    );
    const lastSent = student.email_verify_last_sent
      ? new Date(student.email_verify_last_sent).getTime()
      : 0;
    if (Date.now() - lastSent < RESEND_COOLDOWN_MS) {
      return res.status(429).json({
        error: "Please wait a minute before requesting another email.",
      });
    }

    const verifyToken = auth.generateToken();
    student.email_verify_token_hash = auth.hashToken(verifyToken);
    student.email_verify_expires = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString();
    student.email_verify_last_sent = new Date().toISOString();
    store.write("students", students);

    await email.sendVerificationEmail(
      student,
      `${appOrigin(req)}/verify-email?token=${verifyToken}`,
    );
    res.json({ ok: true });
  }),
);

// Changing the account email is security-sensitive (it's the account-recovery
// identifier), so it requires re-entering the current password even though
// the request is already authenticated — a hijacked session cookie alone
// isn't enough to take the account over this way. Same rate-limit tier as
// login since it does the same bcrypt.compare against a real password.
const changeEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Try again in a few minutes.",
});

api.post(
  "/me/change-email",
  auth.requireAuth,
  changeEmailLimiter,
  asyncRoute(async (req, res) => {
    const result = validate.changeEmail(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const { new_email, password } = result.value;

    const students = store.read("students");
    const student = students.find(
      (s) => s.student_id === req.student.student_id,
    );
    const ok = await bcrypt.compare(password, student.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect password." });

    if (new_email === student.email)
      return res
        .status(400)
        .json({ error: "That is already your email address." });
    if (students.some((s) => s.email === new_email))
      return res
        .status(409)
        .json({ error: "An account with this email already exists." });

    const oldEmail = student.email;
    const verifyToken = auth.generateToken();
    student.email = new_email;
    // The new address hasn't been proven yet — re-verification is mandatory,
    // not optional, regardless of whether the account was verified before.
    student.email_verified = false;
    student.email_verify_token_hash = auth.hashToken(verifyToken);
    student.email_verify_expires = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString();
    student.email_verify_last_sent = new Date().toISOString();
    // Invalidate every OTHER session (same mechanism as password reset). This
    // request's own session is kept alive by re-issuing its cookie below with
    // the bumped version, so the user making the change isn't logged out.
    student.token_version = (student.token_version || 0) + 1;
    store.write("students", students);
    events.record("email_changed", { anon: req.anon });

    email
      .sendVerificationEmail(
        student,
        `${appOrigin(req)}/verify-email?token=${verifyToken}`,
      )
      .catch(() => {});
    email
      .sendEmailChangedNotice(student.full_name, oldEmail, new_email)
      .catch(() => {});

    auth.setAuthCookie(res, student);
    res.json({ student: publicStudent(student) });
  }),
);

// ---- Password reset ---------------------------------------------------------

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many attempts. Try again in a few minutes.",
});

api.post(
  "/auth/forgot-password",
  forgotPasswordLimiter,
  asyncRoute(async (req, res) => {
    const result = validate.forgotPassword(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });

    // `delivery` reports whether email can actually be sent right now (it's
    // dormant until RESEND_API_KEY + a verified domain exist). It reflects
    // global server config, NOT whether the account exists, so it leaks nothing
    // about any user — every caller gets the same value. The client uses it to
    // avoid telling someone to "check your email" when nothing will arrive.
    const delivery = email.ENABLED ? "email" : "unavailable";

    // No point minting a token that can never reach the user. When email is
    // dormant, skip straight to the honest "unavailable" response.
    if (delivery === "email") {
      const students = store.read("students");
      const student = students.find((s) => s.email === result.value.email);
      // Same response whether or not the account exists — the lookup and send
      // happen only on the real path, but the reply never reveals which case
      // was hit (avoid enumeration).
      if (student) {
        const resetToken = auth.generateToken();
        student.password_reset_token_hash = auth.hashToken(resetToken);
        student.password_reset_expires = new Date(
          Date.now() + 60 * 60 * 1000,
        ).toISOString();
        store.write("students", students);
        email
          .sendPasswordResetEmail(
            student,
            `${appOrigin(req)}/reset-password?token=${resetToken}`,
          )
          .catch(() => {});
      }
    }
    res.json({ ok: true, delivery });
  }),
);

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Try again in a few minutes.",
});

api.post(
  "/auth/reset-password",
  resetPasswordLimiter,
  asyncRoute(async (req, res) => {
    const result = validate.resetPassword(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });

    const students = store.read("students");
    const tokenHash = auth.hashToken(result.value.token);
    const student = students.find(
      (s) => s.password_reset_token_hash === tokenHash,
    );

    if (
      !student ||
      !student.password_reset_expires ||
      new Date(student.password_reset_expires) < new Date()
    ) {
      return res
        .status(400)
        .json({ error: "This reset link is invalid or has expired." });
    }

    student.password_hash = await bcrypt.hash(
      result.value.password,
      cfg.BCRYPT_ROUNDS,
    );
    student.password_reset_token_hash = null;
    student.password_reset_expires = null;
    // Every outstanding session (this device and any other) is signed with the
    // old token_version and is now rejected — the same revocation path Phase 2
    // added for "log out everywhere", triggered here for the first time by a
    // real password change.
    student.token_version = (student.token_version || 0) + 1;
    store.write("students", students);
    auth.clearAuthCookie(res);
    events.record("password_reset", { anon: req.anon });

    res.json({ ok: true });
  }),
);

// Update the matching profile (onboarding wizard + /account editor). Every
// field optional; replaces the profile wholesale with the validated set.
api.patch("/me/profile", auth.requireAuth, requireVerifiedEmail, (req, res) => {
  const result = validate.profile(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const p = result.value;

  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  Object.assign(student, p, {
    // keep the legacy mirrors in sync so older readers don't drift
    target_degree_level: p.degree_level || student.target_degree_level,
    field_of_interest: p.fields_of_interest[0] || student.field_of_interest,
    country_of_origin: p.home_country || student.country_of_origin,
  });
  store.write("students", students);
  events.record("profile_update", { anon: req.anon });
  res.json({ student: publicStudent(student) });
});

// Invalidate every outstanding session for this student (e.g. "this wasn't me"
// on a shared/lost device) by bumping token_version — every JWT signed before
// this call carries the old version and is rejected by auth.loadStudent.
// Clears the cookie on THIS device too, so the user re-authenticates
// everywhere, including here.
api.post("/me/logout-everywhere", auth.requireAuth, (req, res) => {
  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  student.token_version = (student.token_version || 0) + 1;
  store.write("students", students);
  auth.clearAuthCookie(res);
  events.record("logout_everywhere", { anon: req.anon });
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

api.get("/universities/filters", (_req, res) => res.json(FILTERS));

api.get("/universities", universitiesLimiter, (req, res) => {
  // Fit-ranking runs off a match profile, not an account. A logged-in student
  // brings theirs; an anonymous visitor can supply one inline via the "What
  // fits you?" quick-match (fit* params). Either way the SAME engine ranks and
  // explains — the only difference is where the profile comes from. Explicit
  // sorts the user picks always win.
  const student = auth.loadStudent(req);
  let profile = student && match.hasProfile(student) ? student : null;
  if (!profile) {
    // Sanitized with the exact rules a registered profile uses — junk fields,
    // out-of-range budgets and unknown countries are dropped, not trusted.
    const q = req.query;
    const anon = validate.matchProfileFields({
      fields_of_interest: String(q.fitFields || "")
        .split(",")
        .filter(Boolean),
      degree_level: q.fitDegree,
      budget_max_eur_year: q.fitBudget,
      country_preference: String(q.fitCountry || "")
        .split(",")
        .filter(Boolean),
      preferred_languages: String(q.fitLang || "")
        .split(",")
        .filter(Boolean),
    });
    if (match.hasProfile(anon)) profile = anon;
  }
  const profiled = !!profile;
  const maxFit = profiled ? match.maxScore(profile) : 1;
  const params = { ...req.query };
  if (profiled && !params.sort && !params.q) params.sort = "match";
  const scoreFn = profiled
    ? (u) => match.matchUniversity(profile, u).score
    : undefined;

  // Scholarship context: ?via=<scholarshipKey> narrows Discover to a curated
  // scholarship's participating universities — the honest path by which non-EU
  // (or otherwise unlisted) universities become discoverable. Resolved from BY_ID
  // (which includes the scholarship-only overlay), so it works for both EU and
  // non-EU universities. A small fixed set, so no pagination/ranking needed.
  const viaKey = String(req.query.via || "");
  const viaSch = viaKey ? curatedScholarships.curatedByKey(viaKey) : null;
  if (viaSch) {
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    let unis = (viaSch.university_ids || [])
      .map((id) => BY_ID.get(id))
      .filter(Boolean);
    if (q)
      unis = unis.filter((u) =>
        `${u.name} ${u.city || ""} ${u.country || ""}`.toLowerCase().includes(q),
      );
    const universities = unis.map((u) => {
      const withP = withPhoto({ ...u, click_count: clickOf(u.id) });
      if (curatedScholarships.isCuratedUniversity(u.id)) withP.has_funding = true;
      return withP;
    });
    return res.json({
      universities,
      count: universities.length,
      offset: 0,
      hasMore: false,
      sort: "scholarship",
      via: { key: viaSch.key, name: viaSch.name, country: viaSch.country },
    });
  }

  const result = search.query(INDEX, params, clickOf, { scoreFn });
  result.universities = result.universities.map((u) => {
    const withP = withPhoto(u);
    // Attach the fit score + a compressed per-card reason only when we actually
    // ranked by fit. The score is a FIT score (field/budget/country/language/
    // verified), NOT an admission probability. It's normalised to what THIS
    // profile could achieve (match.maxScore), so a best-possible match reads as
    // ~100 rather than the raw 60 a field+budget search would cap at.
    if (profiled && params.sort === "match") {
      const m = match.matchUniversity(profile, u);
      withP.match_score = Math.round((m.score / maxFit) * 100);
      const reason = explain.compressedReason(m.components);
      if (reason) withP.match_reasons = [reason];
    }
    // A quiet "funding available" signal when a curated scholarship lists this
    // university (the card shows one chip → the scholarship).
    if (curatedScholarships.isCuratedUniversity(u.id)) withP.has_funding = true;
    return withP;
  });
  result.sort = params.sort || (req.query.q ? "relevance" : "name");
  const q = String(req.query.q || "").trim();
  if (q) {
    events.record("search", {
      anon: req.anon,
      results: result.count,
      q: q.slice(0, 80),
    });
  }
  res.json(result);
});

api.get(
  "/universities/:id",
  universityDetailLimiter,
  asyncRoute(async (req, res) => {
    if (SLUG_REDIRECTS[req.params.id]) {
      return res.redirect(
        301,
        `/api/universities/${encodeURIComponent(SLUG_REDIRECTS[req.params.id])}`,
      );
    }
    const uni = BY_ID.get(req.params.id);
    if (!uni) return res.status(404).json({ error: "University not found." });
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
      out.match_explanation = await explain.generate(
        student,
        uni,
        m.components,
        m.flags,
      );
    }
    // Curated scholarships this university participates in (University→Scholarship
    // direction) — a lightweight {key,name,country} list the profile links to.
    const funding = curatedScholarships.curatedForUniversity(uni.id);
    if (funding.length)
      out.funding_scholarships = funding.map((s) => ({
        key: s.key,
        name: s.name,
        country: s.country,
      }));
    res.json({ university: out });
  }),
);

// Anonymous Apply-Now click — bumps a counter in the separate clicks store and
// records a deduplicable event. No personal data attached.
const clickLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
api.post("/universities/:id/apply-click", clickLimiter, (req, res) => {
  const uni = BY_ID.get(req.params.id);
  if (!uni) return res.status(404).json({ error: "University not found." });

  const clicks = store.read("clicks");
  clicks[uni.id] = (clicks[uni.id] || 0) + 1;
  store.writeDebounced("clicks", clicks);
  events.record("apply_click", { uni: uni.id, anon: req.anon });

  res.json({
    ok: true,
    click_count: clicks[uni.id],
    application_link: uni.application_link || uni.website || "",
  });
});

// ---- Client-side behavioral tracking ---------------------------------------
//
// First-party, cookieless-style tracking (no third-party script, no consent
// banner needed): the client posts a tiny beacon on each navigation. Referrer
// and language are read from headers server-side (more reliable than trusting
// the client and avoids forwarding a full URL with query strings). No PII is
// accepted or stored — just a path, an anonymous id, and a device/locale guess.

const TRACK_TYPES = new Set([
  "pageview",
  "profile_view",
  "filter_used",
  "compare",
]);
const trackLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

function refDomain(req) {
  const ref = req.get("Referer") || "";
  try {
    const host = new URL(ref).host;
    return host && host !== req.get("host") ? host : "";
  } catch {
    return "";
  }
}

api.post("/track", trackLimiter, (req, res) => {
  const { type, path: p, uni, filter, value } = req.body || {};
  if (!TRACK_TYPES.has(type))
    return res.status(400).json({ error: "Unknown event type." });

  const meta = {
    anon: req.anon,
    path: typeof p === "string" ? p.slice(0, 200) : "",
    ref: refDomain(req),
    lang: (req.get("Accept-Language") || "")
      .split(",")[0]
      .split(";")[0]
      .trim()
      .slice(0, 10),
    device: req.body && req.body.device === "mobile" ? "mobile" : "desktop",
  };
  if (type === "profile_view" && typeof uni === "string")
    meta.uni = uni.slice(0, 60);
  if (type === "filter_used") {
    meta.filter = typeof filter === "string" ? filter.slice(0, 40) : "";
    meta.value = typeof value === "string" ? value.slice(0, 80) : "";
  }
  // How many universities were on screen when the student compared. Still just
  // a number against an anonymous id — no university ids, no student id.
  if (type === "compare") {
    const n = Number(req.body && req.body.count);
    meta.count = Number.isFinite(n)
      ? Math.max(0, Math.min(50, Math.trunc(n)))
      : 0;
  }

  events.record(type, meta);
  res.status(204).end();
});

// ---- Cover photo (Wikipedia) + logo proxy ---------------------------------

const WIKI_UA =
  "Universo/0.1 (university discovery MVP; https://example.com; admin@example.com)";
const photoInflight = new Map(); // id -> Promise (dedupe concurrent first-lookups)
const photoLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

async function lookupWikipedia(name, extra) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "pageimages|extracts",
    piprop: "original|thumbnail",
    pithumbsize: "1000",
    exintro: "1",
    explaintext: "1",
    exsentences: "4",
    generator: "search",
    gsrsearch: extra ? `${name} ${extra}` : name,
    gsrlimit: "1",
    gsrnamespace: "0",
  });
  const res = await fetchWithResilience(
    `https://en.wikipedia.org/w/api.php?${params}`,
    {
      headers: { "User-Agent": WIKI_UA },
      timeoutMs: 8000,
      retries: 1,
      label: "wikipedia",
    },
  );
  const data = await res.json();
  const page = data?.query?.pages && Object.values(data.query.pages)[0];
  if (!page) return null;
  let src = page.original?.source || page.thumbnail?.source || null;
  // Seals/wordmarks crop into unreadable fragments — drop the image, keep the
  // extract. Every photo lookup routes through here, so this is the only guard.
  if (photos.isLogoLike(src)) src = null;
  const extract = page.extract ? String(page.extract).trim() : null;
  if (!src && !extract) return null;
  return { photo_url: src, page: page.title, extract };
}

// Commons extmetadata values arrive as HTML fragments.
const stripHtml = (h) =>
  h
    ? String(h)
        .replace(/<[^>]*>/g, "")
        .trim()
    : "";

// Credit block from a Commons imageinfo record (CC-BY-SA mostly → required).
const creditFrom = (imageinfo) => {
  const m = imageinfo?.extmetadata || {};
  return {
    artist: stripHtml(m.Artist?.value) || "Wikimedia Commons",
    license: stripHtml(m.LicenseShortName?.value) || "",
    source: imageinfo?.descriptionurl || "",
  };
};

// Wikipedia's lead image for a university is usually its seal or wordmark, which
// `isLogoLike` rejects. Commons file search finds actual campus photography.
// Returns null rather than a bad image — the placeholder glyph looks deliberate.
async function lookupCommonsPhoto(name) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: name,
    gsrnamespace: "6", // File:
    gsrlimit: "20",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "1200", // serve a thumbnail, not a 7500px original
  });
  const res = await fetchWithResilience(
    `https://commons.wikimedia.org/w/api.php?${params}`,
    {
      headers: { "User-Agent": WIKI_UA },
      timeoutMs: 8000,
      retries: 1,
      label: "commons-search",
    },
  );
  const data = await res.json();
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  // The pages object is keyed by pageid, which loses ranking — `index` restores
  // search order, and picking the most relevant usable image depends on it.
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // Keep the full imageinfo aside rather than threading it through the picker —
  // the credit is only needed for the one candidate that wins.
  const infoByTitle = new Map();
  const candidates = pages.map((p) => {
    const ii = p.imageinfo?.[0] || {};
    infoByTitle.set(p.title, ii);
    return {
      title: p.title,
      url: ii.thumburl || ii.url,
      width: ii.width,
      height: ii.height,
      mime: ii.mime,
    };
  });

  const best = photos.pickBestPhoto(candidates);
  if (!best) return null;
  return {
    photo_url: best.url,
    page: best.title,
    attribution: creditFrom(infoByTitle.get(best.title)),
  };
}

// Best-effort image credit (Wikimedia Commons is mostly CC-BY-SA → attribution required).
async function lookupAttribution(photoUrl) {
  try {
    const file = "File:" + decodeURIComponent(photoUrl.split("/").pop());
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      prop: "imageinfo",
      iiprop: "extmetadata|url",
      titles: file,
    });
    const res = await fetchWithResilience(
      `https://commons.wikimedia.org/w/api.php?${params}`,
      {
        headers: { "User-Agent": WIKI_UA },
        timeoutMs: 6000,
        retries: 0,
        label: "commons",
      },
    );
    const data = await res.json();
    const page = data?.query?.pages && Object.values(data.query.pages)[0];
    return creditFrom(page?.imageinfo?.[0]);
  } catch {
    return { artist: "Wikimedia Commons", license: "", source: "" };
  }
}

// Resolve + cache a university's photo (shared by the endpoint below and the
// curated-universities prewarm at boot). Dedupes concurrent lookups for the
// same id via photoInflight.
function resolvePhoto(uni) {
  if (!photoInflight.has(uni.id)) {
    photoInflight.set(
      uni.id,
      (async () => {
        // "Found nothing" and "couldn't ask" are different answers. A timeout or
        // an open circuit breaker must not be recorded as "this university has
        // no photo" — that verdict is cached forever. Track failures separately.
        let failed = false;
        const attempt = (p) =>
          p.catch(() => {
            failed = true;
            return null;
          });

        let found = await attempt(lookupWikipedia(uni.name));
        if (!found && uni.country)
          found = await attempt(lookupWikipedia(uni.name, uni.country));

        // Wikipedia gives the article extract (the Overview text) but usually a
        // seal for the image. Fall back to Commons for the photograph only, and
        // keep the extract regardless of which source the picture came from.
        let commons = null;
        if (!found?.photo_url) {
          commons = await attempt(lookupCommonsPhoto(uni.name));
          if (!commons && uni.country)
            commons = await attempt(
              lookupCommonsPhoto(`${uni.name} ${uni.country}`),
            );
        }

        const photoUrl = found?.photo_url || commons?.photo_url || null;
        const extract = found?.extract || null;
        // Commons search already returns the credit inline; the Wikipedia path
        // still needs a second call to resolve one.
        const attribution = commons
          ? commons.attribution
          : found?.photo_url
            ? await lookupAttribution(found.photo_url)
            : null;

        // Came back empty-handed *because the lookups errored* — return nothing
        // for now but don't persist it, so the next view tries again instead of
        // inheriting a permanent "no photo" from one bad minute upstream.
        if (!photoUrl && !extract && failed) {
          return { none: true, transient: true };
        }

        const entry =
          photoUrl || extract
            ? {
                photo_url: photoUrl,
                page: found?.page || commons?.page || null,
                extract,
                attribution,
                source: commons?.photo_url ? "commons" : "wikipedia",
                v: photos.LOOKUP_VERSION,
                cached_at: new Date().toISOString(),
              }
            : {
                none: true,
                v: photos.LOOKUP_VERSION,
                cached_at: new Date().toISOString(),
              };
        const c = store.read("photos");
        c[uni.id] = entry;
        store.writeDebounced("photos", c);
        return entry;
      })().finally(() => photoInflight.delete(uni.id)),
    );
  }
  return photoInflight.get(uni.id);
}

api.get("/universities/:id/photo", photoLimiter, async (req, res) => {
  const uni = BY_ID.get(req.params.id);
  if (!uni) return res.status(404).json({ error: "University not found." });

  const reply = (c, cached) =>
    res.json({
      photo_url: c.none ? null : c.photo_url || null,
      attribution: c.attribution || null,
      extract: c.extract || null,
      cached,
    });

  const cache = store.read("photos");
  if (cache[uni.id]) return reply(cache[uni.id], true);

  try {
    reply(await resolvePhoto(uni), false);
  } catch (e) {
    log.captureError(e, { where: "photo", uni: uni.id });
    res.json({
      photo_url: null,
      attribution: null,
      extract: null,
      cached: false,
    });
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
  const cache = store.read("photos");
  const targets = UNIVERSITIES.filter((u) => u.verified && !cache[u.id]).sort(
    (a, b) =>
      (a.source === "curated" ? 0 : 1) - (b.source === "curated" ? 0 : 1),
  );
  for (const uni of targets) {
    try {
      await resolvePhoto(uni);
    } catch {
      /* best effort */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (targets.length)
    log.info("verified-tier photo prewarm complete", { count: targets.length });
}

// Logo proxy + on-disk cache (avoids hotlinking a third-party favicon host and
// lets us fall back server-side). Frontend <img> points here; 404 → initials.
const LOGO_DIR = path.join(store.DATA_DIR, "cache", "logos");
fs.mkdirSync(LOGO_DIR, { recursive: true });
const logoLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });

api.get("/logo", logoLimiter, async (req, res) => {
  const domain = String(req.query.domain || "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");
  if (!domain || !domain.includes(".")) return res.status(400).end();

  const file = path.join(LOGO_DIR, `${domain}.img`);
  if (fs.existsSync(file)) {
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.setHeader(
      "Content-Type",
      fs.readFileSync(`${file}.type`, "utf8").trim() || "image/x-icon",
    );
    return res.send(fs.readFileSync(file));
  }
  try {
    const r = await fetchWithResilience(
      `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      { timeoutMs: 6000, retries: 1, label: "logo" },
    );
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) return res.status(404).end(); // empty/placeholder favicon
    const type = r.headers.get("content-type") || "image/x-icon";
    fs.writeFileSync(file, buf);
    fs.writeFileSync(`${file}.type`, type);
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.setHeader("Content-Type", type);
    res.send(buf);
  } catch {
    res.status(404).end();
  }
});

// ---- Saved / bookmarks ----------------------------------------------------

api.get("/me/saved", auth.requireAuth, (req, res) => {
  const apps = req.student.applications || {};
  const saved = req.student.saved_universities
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .map((u) => {
      const a = journey.normalizeApplication(apps[u.id]);
      return withPhoto({
        ...u,
        click_count: clickOf(u.id),
        application_status: a.status,
        application_priority: a.priority,
        application_reason: a.reason,
        application_program: a.program,
      });
    });
  res.json({ count: saved.length, universities: saved });
});

api.post("/me/saved/:id", auth.requireAuth, (req, res) => {
  if (!BY_ID.has(req.params.id))
    return res.status(404).json({ error: "University not found." });
  if (!req.student.saved_universities.includes(req.params.id)) {
    req.student.saved_universities.push(req.params.id);
    store.write("students", store.read("students"));
    events.record("save", { anon: req.anon, uni: req.params.id });
  }
  res.json({ saved_universities: req.student.saved_universities });
});

api.delete("/me/saved/:id", auth.requireAuth, (req, res) => {
  const before = req.student.saved_universities.length;
  req.student.saved_universities = req.student.saved_universities.filter(
    (id) => id !== req.params.id,
  );
  if (req.student.saved_universities.length !== before) {
    // Drop any application status too — it's meaningless once unsaved, and
    // leaving it would resurrect on re-save.
    if (req.student.applications && req.student.applications[req.params.id])
      delete req.student.applications[req.params.id];
    store.write("students", store.read("students"));
    events.record("unsave", { anon: req.anon, uni: req.params.id });
  }
  res.json({ saved_universities: req.student.saved_universities });
});

// Set the application status for a saved university (makes Saved active).
api.post("/me/saved/:id/status", auth.requireAuth, (req, res) => {
  const id = req.params.id;
  if (!req.student.saved_universities.includes(id)) {
    return res.status(400).json({
      error: "Save this university before setting an application status.",
    });
  }
  const status = typeof req.body.status === "string" ? req.body.status : "";
  if (!journey.APPLICATION_STATUS_KEYS.has(status))
    return res.status(400).json({ error: "Unknown status." });

  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  if (!student.applications) student.applications = {};
  const app = journey.normalizeApplication(student.applications[id]);
  app.status = status;
  student.applications[id] = pruneApplication(app);
  if (student.applications[id] === null) delete student.applications[id];
  store.write("students", students);
  events.record("application_status", { anon: req.anon, uni: id, status });
  res.json({ id, status });
});

// Collapse a fully-default application (planning, nothing else set) back to
// absence to keep the stored map small — returns null when there's nothing
// worth keeping, otherwise the entry itself.
function pruneApplication(app) {
  const bare =
    app.status === journey.DEFAULT_STATUS &&
    !app.deadline &&
    !app.program &&
    !app.intake &&
    !app.notes &&
    !app.decision_date &&
    !app.priority &&
    !app.reason &&
    !Object.keys(app.req).length &&
    !Object.keys(app.docs).length &&
    !app.custom.length;
  return bare ? null : app;
}

// Load-or-create a normalized application entry for a saved uni, run `mutate`,
// then persist (pruning back to absence if it ends up bare). Shared by the
// application routes below. Assumes `id` is already known-saved.
function updateApplication(req, id, mutate) {
  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  if (!student.applications) student.applications = {};
  const app = journey.normalizeApplication(student.applications[id]);
  mutate(app);
  const pruned = pruneApplication(app);
  if (pruned === null) delete student.applications[id];
  else student.applications[id] = pruned;
  store.write("students", students);
  return app;
}

// "Recommended for you" — a transparent weighted match against the student's
// profile (target degree, field of interest) and the platform's EU/affordable/
// English-taught niche. See lib/match.js for why this is a scoring algorithm
// rather than a live AI call. Excludes universities already saved.
api.get("/me/recommendations", auth.requireAuth, (req, res) => {
  // No profile → no honest recommendations. Ranking every verified university
  // against an empty profile just scores them all on "verified" (100% of a
  // ceiling of 10), which would present meaningless "Strong match" cards. The
  // client shows a "set up matching" nudge instead.
  if (!match.hasProfile(req.student)) return res.json({ universities: [] });
  const limit = Math.min(
    24,
    Math.max(1, parseInt(String(req.query.limit || ""), 10) || 6),
  );
  const excludeIds = new Set(req.student.saved_universities || []);
  const results = match
    .recommend(req.student, UNIVERSITIES, { limit, excludeIds })
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
// Assemble the full Dream Plan payload for one student. A pure read over data we
// already have — reused by GET /me/journey AND the email digest job (lib/notify)
// so both see exactly the same "what's true for this student".
function buildJourneyData(student) {
  const savedIds = student.saved_universities || [];

  // Saved (resolved to full records, capped for the summary card). Each carries
  // its application status so the preview cards match the Saved page.
  const apps = student.applications || {};
  const saved = savedIds
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .map((u) =>
      withPhoto({
        ...u,
        click_count: clickOf(u.id),
        application_status: journey.normalizeApplication(apps[u.id]).status,
      }),
    );

  const completeness = journey.profileCompleteness(student);
  const profiled = match.hasProfile(student);

  // Match-ranked next picks (excludes what's already saved). Each carries a
  // compressed "why" reason, exactly like the Discover cards — same matcher,
  // same explanation layer, no duplicated ranking logic.
  const excludeIds = new Set(savedIds);
  const picks = profiled
    ? match
        .recommend(student, UNIVERSITIES, { limit: 4, excludeIds })
        .map((u) => {
          const withP = withPhoto({ ...u, click_count: clickOf(u.id) });
          const m = match.scoreUniversity(student, u);
          const reason = explain.compressedReason(m.components);
          if (reason) withP.match_reasons = [reason];
          return withP;
        })
    : [];

  // ---- Documents (vault) with optional expiry ----
  const sCounts = journey.statusCounts(apps, savedIds);
  const docsState =
    student.documents && typeof student.documents === "object"
      ? student.documents
      : {};
  const docMeta =
    student.document_meta && typeof student.document_meta === "object"
      ? student.document_meta
      : {};
  const documents = journey.DOCUMENTS.map((d) => {
    const expiry =
      docMeta[d.key] && typeof docMeta[d.key].expiry === "string"
        ? docMeta[d.key].expiry
        : "";
    return {
      ...d,
      done: docsState[d.key] === true,
      expiry,
      expiry_status: expiry ? journey.docExpiryStatus(expiry) : null,
    };
  });
  const docsDone = documents.filter((d) => d.done).length;

  // ---- Application command center (built first — scholarships + agenda + the
  // action plan all read from it). Costs use the student's budget. ----
  const budget = Number.isFinite(student.budget_max_eur_year)
    ? student.budget_max_eur_year
    : null;
  const allApplications = journey.sortApplications(
    journey.buildApplications(saved, apps, docsState, budget),
  );
  // Dream Plan works ONLY the applications the student has committed to
  // (Start application → status past "planning"). Interested-but-not-started
  // universities live in the Shortlist, not here — so the two features never
  // show the same school. `sCounts` (all saved) still powers the status ribbon.
  const applications = allApplications.filter((a) => a.status !== "planning");
  const committedIds = new Set(applications.map((a) => a.uni_id));
  const committedUnis = saved.filter((u) => committedIds.has(u.id));
  const overview = journey.applicationsOverview(applications);
  const funding = journey.computeFunding(committedUnis, budget);

  // ---- Scholarships: destination-driven, each linked to the applications it
  // could fund, plus your home country's outbound schemes. ----
  const homeCountry = student.home_country || student.country_of_origin || "";
  const destCountries = [...new Set(saved.map((u) => u.country).filter(Boolean))];
  const prefCountries = Array.isArray(student.country_preference)
    ? student.country_preference
    : [];
  const schCountries = destCountries.length ? destCountries : prefCountries;
  const schTracked =
    student.scholarships && typeof student.scholarships === "object"
      ? student.scholarships
      : {};
  const appsByCountry = (country) =>
    applications.filter((a) => a.country === country).map((a) => a.name);
  const allAppNames = applications.map((a) => a.name);
  const withMeta = (s, covers) => {
    const meta = journey.normalizeScholarship(schTracked[s.key]);
    return { ...s, status: meta.status, deadline: meta.deadline, covers };
  };
  const schData = scholarshipsForDestinations(schCountries);
  const scholarships = {
    groups: schData.groups.map((g) => ({
      country: g.country,
      scholarships: g.scholarships.map((s) => withMeta(s, appsByCountry(g.country))),
    })),
    eu_wide: schData.eu_wide.map((s) => withMeta(s, allAppNames)),
    outbound: scholarshipsOutbound(homeCountry).map((s) => withMeta(s, allAppNames)),
    destinations: schCountries,
    home_country: homeCountry,
    source: destCountries.length
      ? "applications"
      : prefCountries.length
        ? "preferences"
        : "none",
  };

  // ---- Agenda + action plan (derived from the above) ----
  const schFlat = [
    ...scholarships.groups.flatMap((g) => g.scholarships),
    ...scholarships.eu_wide,
    ...scholarships.outbound,
  ];
  const schDeadlineItems = schFlat
    .filter((s) => s.deadline)
    .map((s) => ({ name: s.name, deadline: s.deadline }));
  const agenda = journey.buildAgenda(applications, schDeadlineItems);
  const action_plan = journey.buildActionPlan(applications, docsState);

  const scholarshipsResearched =
    Array.isArray(student.milestones) &&
    student.milestones.includes("scholarships_researched");
  const readiness = journey.readiness({
    completenessPercent: completeness.percent,
    missingProfile: completeness.missing,
    savedCount: saved.length,
    statusCounts: sCounts,
    docsDone,
    scholarshipRequired: student.scholarship_required === true,
    scholarshipsResearched,
    scholarshipStatuses: Object.values(schTracked).map(
      (v) => journey.normalizeScholarship(v).status,
    ),
  });

  return {
    completeness,
    has_profile: profiled,
    dream: {
      fields_of_interest: student.fields_of_interest || [],
      degree_level: student.degree_level || "",
      country_preference: student.country_preference || [],
      target_intake: student.target_intake || "",
      career_goal: student.career_goal || "",
      scholarship_required: student.scholarship_required === true,
    },
    readiness,
    next_best_action: journey.nextBestAction(readiness, applications),
    documents,
    applications,
    overview,
    saved: {
      count: saved.length,
      universities: saved.slice(0, 6),
      status_counts: sCounts,
    },
    picks,
    scholarships,
    funding,
    budget,
    agenda,
    action_plan,
    home_country: homeCountry,
    next_actions: journey.nextActions(saved.length, completeness),
    timeline: journey.buildTimeline(
      profiled,
      saved.length,
      student.milestones,
      applications.map((a) => a.status),
    ),
  };
}

api.get("/me/journey", auth.requireAuth, (req, res) => {
  const data = buildJourneyData(req.student);
  // "Since you were away" is computed against the PREVIOUS visit, then the
  // marker is advanced. Persisted debounced (a hot, low-value write).
  data.since_away = journey.sinceAway(
    data.applications,
    req.student.last_journey_view,
  );
  const students = store.read("students");
  const s = students.find((x) => x.student_id === req.student.student_id);
  if (s) {
    s.last_journey_view = new Date().toISOString();
    store.writeDebounced("students", students);
  }
  res.json(data);
});

// Toggle a self-reported timeline milestone. Only the "self" keys are
// settable — the auto stages (account/profile/shortlist) reflect real state
// and are never client-writable.
api.post("/me/milestone", auth.requireAuth, (req, res) => {
  const key = typeof req.body.key === "string" ? req.body.key : "";
  if (!journey.SELF_MILESTONE_KEYS.has(key))
    return res.status(400).json({ error: "Unknown milestone." });
  const done = req.body.done === true;

  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  const set = new Set(
    Array.isArray(student.milestones) ? student.milestones : [],
  );
  if (done) set.add(key);
  else set.delete(key);
  student.milestones = [...set];
  store.write("students", students);
  events.record("milestone", { anon: req.anon, ...(done ? { set: key } : {}) });
  res.json({ milestones: student.milestones });
});

// Email notification preferences (per category). Body may set any subset of the
// known categories to booleans; unknown keys are ignored.
api.patch("/me/notifications", auth.requireAuth, (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  if (!student.notifications || typeof student.notifications !== "object")
    student.notifications = {};
  for (const key of notify.NOTIFICATION_CATEGORIES) {
    if (key in body) student.notifications[key] = body[key] === true;
  }
  store.write("students", students);
  res.json({ notifications: notify.notifPrefs(student) });
});

// ---- Dream Plan: dream fields + document checklist -------------------------

// Update the explicit "dream" fields (kept separate from the matching profile
// so neither save wipes the other).
api.patch("/me/dream", auth.requireAuth, (req, res) => {
  const result = validate.dream(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  Object.assign(student, result.value);
  store.write("students", students);
  events.record("dream_update", { anon: req.anon });
  res.json({ student: publicStudent(student) });
});

// Toggle a document in the self-tracked checklist (powers Document readiness).
api.post("/me/document", auth.requireAuth, (req, res) => {
  const key = typeof req.body.key === "string" ? req.body.key : "";
  if (!journey.DOCUMENT_KEYS.has(key))
    return res.status(400).json({ error: "Unknown document." });
  const done = req.body.done === true;

  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  if (!student.documents || typeof student.documents !== "object")
    student.documents = {};
  if (done) student.documents[key] = true;
  else delete student.documents[key];
  store.write("students", students);
  events.record("document", { anon: req.anon, ...(done ? { set: key } : {}) });
  res.json({ documents: student.documents });
});

// Set (or clear) the expiry date on a shared document so we can warn before it
// lapses. The date is the student's own — never inferred.
api.post("/me/document/expiry", auth.requireAuth, (req, res) => {
  const key = typeof req.body.key === "string" ? req.body.key : "";
  const expiry = typeof req.body.expiry === "string" ? req.body.expiry : "";
  const doc = journey.DOCUMENTS.find((d) => d.key === key);
  if (!doc || !doc.shared)
    return res.status(400).json({ error: "Unknown document." });
  if (expiry && !DATE_RE.test(expiry))
    return res.status(400).json({ error: "Expiry must be YYYY-MM-DD." });

  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  if (!student.document_meta || typeof student.document_meta !== "object")
    student.document_meta = {};
  if (expiry) student.document_meta[key] = { expiry };
  else delete student.document_meta[key];
  store.write("students", students);
  res.json({ key, expiry });
});

// Browsable scholarship catalog for the /scholarships page: the honest
// country-level pointers (EU-wide + per-destination + home-country outbound).
// Adds a personalized "for_you" group from the student's destinations (saved
// unis' countries, else preferred countries) and their tracked-status map.
api.get("/scholarships", (req, res) => {
  const student = auth.loadStudent(req);
  const tracked =
    student && student.scholarships && typeof student.scholarships === "object"
      ? student.scholarships
      : {};
  let for_you = null;
  if (student) {
    const savedIds = new Set(student.saved_universities || []);
    const destCountries = [
      ...new Set(
        UNIVERSITIES.filter((u) => savedIds.has(u.id))
          .map((u) => u.country)
          .filter(Boolean),
      ),
    ];
    const prefCountries = Array.isArray(student.country_preference)
      ? student.country_preference
      : [];
    const schCountries = destCountries.length ? destCountries : prefCountries;
    if (schCountries.length) {
      const sd = scholarshipsForDestinations(schCountries);
      if (sd.groups.length || sd.eu_wide.length)
        for_you = { ...sd, destinations: schCountries };
    }
  }
  // Resolve each curated scholarship's participating university_ids into
  // {id,name,city} so the detail page can list them (names live in the
  // universities dataset / scholarship-only overlay — no duplication, just a
  // BY_ID lookup, so non-EU (CSC) universities resolve too).
  const curated = curatedScholarships.allCurated().map((s) => ({
    ...s,
    universities: (s.university_ids || [])
      .map((id) => BY_ID.get(id))
      .filter(Boolean)
      .map((u) => ({ id: u.id, name: u.name, city: u.city || "" })),
  }));

  res.json({ curated, ...scholarshipCatalog(), for_you, tracked });
});

// Track progress on a specific scholarship scheme + its (student-entered)
// deadline. Clears the entry only when both are empty.
api.post("/me/scholarship", auth.requireAuth, (req, res) => {
  const key = typeof req.body.key === "string" ? req.body.key : "";
  const b = req.body || {};
  if (!key) return res.status(400).json({ error: "Unknown scholarship." });
  if (b.status !== undefined && b.status !== "" && !journey.SCHOLARSHIP_STATUS_KEYS.has(b.status))
    return res.status(400).json({ error: "Unknown status." });
  if (
    b.deadline !== undefined &&
    !(b.deadline === "" || (typeof b.deadline === "string" && DATE_RE.test(b.deadline)))
  )
    return res.status(400).json({ error: "Deadline must be YYYY-MM-DD." });

  const students = store.read("students");
  const student = students.find((s) => s.student_id === req.student.student_id);
  if (!student.scholarships || typeof student.scholarships !== "object")
    student.scholarships = {};
  const cur = journey.normalizeScholarship(student.scholarships[key]);
  if (b.status !== undefined) cur.status = b.status;
  if (b.deadline !== undefined) cur.deadline = b.deadline;
  if (!cur.status && !cur.deadline) delete student.scholarships[key];
  else student.scholarships[key] = cur;
  store.write("students", students);
  events.record("scholarship", {
    anon: req.anon,
    ...(cur.status ? { set: cur.status } : {}),
  });
  res.json({ key, status: cur.status, deadline: cur.deadline });
});

// ---- Applications: per-university document tracking ------------------------
// Each saved uni is an application. These set student-owned facts about it —
// deadline, program note, per-doc requirement level, and readiness of the docs
// that are unique to this application (shared docs use /me/document above).
const requireSaved = (req, res) => {
  if (req.student.saved_universities.includes(req.params.id)) return true;
  res.status(400).json({
    error: "Save this university before working on its application.",
  });
  return false;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Patch the application's lifecycle status, deadline and/or program note.
api.post("/me/application/:id", auth.requireAuth, (req, res) => {
  if (!requireSaved(req, res)) return;
  const b = req.body || {};
  if (b.status !== undefined && !journey.APPLICATION_STATUS_KEYS.has(b.status))
    return res.status(400).json({ error: "Unknown status." });
  if (
    b.deadline !== undefined &&
    !(b.deadline === "" || (typeof b.deadline === "string" && DATE_RE.test(b.deadline)))
  )
    return res.status(400).json({ error: "Deadline must be YYYY-MM-DD." });
  if (b.program !== undefined && typeof b.program !== "string")
    return res.status(400).json({ error: "Invalid program." });
  if (b.intake !== undefined && typeof b.intake !== "string")
    return res.status(400).json({ error: "Invalid intake." });
  if (b.notes !== undefined && typeof b.notes !== "string")
    return res.status(400).json({ error: "Invalid notes." });
  if (
    b.priority !== undefined &&
    !(b.priority === "" || journey.PRIORITY_KEYS.has(b.priority))
  )
    return res.status(400).json({ error: "Unknown priority." });
  if (b.reason !== undefined && typeof b.reason !== "string")
    return res.status(400).json({ error: "Invalid reason." });
  if (
    b.decision_date !== undefined &&
    !(b.decision_date === "" || (typeof b.decision_date === "string" && DATE_RE.test(b.decision_date)))
  )
    return res.status(400).json({ error: "Decision date must be YYYY-MM-DD." });

  const app = updateApplication(req, req.params.id, (a) => {
    if (b.status !== undefined) a.status = b.status;
    if (b.deadline !== undefined) a.deadline = b.deadline;
    if (b.program !== undefined) a.program = b.program.trim().slice(0, 120);
    if (b.intake !== undefined) a.intake = b.intake.trim().slice(0, 60);
    if (b.notes !== undefined) a.notes = b.notes.slice(0, 500);
    if (b.decision_date !== undefined) a.decision_date = b.decision_date;
    if (b.priority !== undefined) a.priority = b.priority;
    if (b.reason !== undefined) a.reason = b.reason.trim().slice(0, 200);
  });
  events.record("application_update", { anon: req.anon, uni: req.params.id });
  res.json({ id: req.params.id, application: app });
});

// Set the requirement level for one document on this application.
api.post("/me/application/:id/requirement", auth.requireAuth, (req, res) => {
  if (!requireSaved(req, res)) return;
  const key = typeof req.body.key === "string" ? req.body.key : "";
  const level = typeof req.body.level === "string" ? req.body.level : "";
  if (!journey.DOCUMENT_KEYS.has(key))
    return res.status(400).json({ error: "Unknown document." });
  if (!journey.LEVEL_KEYS.has(level))
    return res.status(400).json({ error: "Unknown level." });

  const doc = journey.DOCUMENTS.find((d) => d.key === key);
  updateApplication(req, req.params.id, (a) => {
    // Store only overrides — a level equal to the doc's default stays absent.
    if (level === doc.default_level) delete a.req[key];
    else a.req[key] = level;
  });
  res.json({ id: req.params.id, key, level });
});

// Toggle readiness of a document FOR THIS APPLICATION. Completion is per-
// application and independent (My Documents only records what the student
// possesses — it never drives an application's checklist).
api.post("/me/application/:id/document", auth.requireAuth, (req, res) => {
  if (!requireSaved(req, res)) return;
  const key = typeof req.body.key === "string" ? req.body.key : "";
  const doc = journey.DOCUMENTS.find((d) => d.key === key);
  if (!doc) return res.status(400).json({ error: "Unknown document." });
  const done = req.body.done === true;

  updateApplication(req, req.params.id, (a) => {
    if (done) a.docs[key] = true;
    else delete a.docs[key];
  });
  res.json({ id: req.params.id, key, done });
});

// Custom documents: extras a student adds to one application (portfolio, GRE,
// a program-specific essay). Always unique to the application.
const MAX_CUSTOM_DOCS = 12;

api.post("/me/application/:id/custom", auth.requireAuth, (req, res) => {
  if (!requireSaved(req, res)) return;
  const label =
    typeof req.body.label === "string" ? req.body.label.trim().slice(0, 60) : "";
  if (!label) return res.status(400).json({ error: "Give the document a name." });
  const level = journey.LEVEL_KEYS.has(req.body.level)
    ? req.body.level
    : "required";
  const doc = { id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label, level, ready: false };
  let over = false;
  updateApplication(req, req.params.id, (a) => {
    if (a.custom.length >= MAX_CUSTOM_DOCS) {
      over = true;
      return;
    }
    a.custom.push(doc);
  });
  if (over)
    return res.status(400).json({ error: "That application has enough documents." });
  res.json({ id: req.params.id, document: doc });
});

api.post("/me/application/:id/custom/:cid", auth.requireAuth, (req, res) => {
  if (!requireSaved(req, res)) return;
  const b = req.body || {};
  if (b.level !== undefined && !journey.LEVEL_KEYS.has(b.level))
    return res.status(400).json({ error: "Unknown level." });
  let found = false;
  updateApplication(req, req.params.id, (a) => {
    const doc = a.custom.find((d) => d.id === req.params.cid);
    if (!doc) return;
    found = true;
    if (b.level !== undefined) doc.level = b.level;
    if (b.done !== undefined) doc.ready = b.done === true;
  });
  if (!found) return res.status(404).json({ error: "Document not found." });
  res.json({ id: req.params.id, cid: req.params.cid });
});

api.delete("/me/application/:id/custom/:cid", auth.requireAuth, (req, res) => {
  if (!requireSaved(req, res)) return;
  updateApplication(req, req.params.id, (a) => {
    a.custom = a.custom.filter((d) => d.id !== req.params.cid);
  });
  res.json({ id: req.params.id, cid: req.params.cid });
});

// ---- GDPR: data export + account deletion ---------------------------------

api.get("/me/export", auth.requireAuth, (req, res) => {
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="universo-my-data.json"',
  );
  res.json({
    exported_at: new Date().toISOString(),
    account: publicStudent(req.student),
  });
});

api.delete(
  "/me",
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const anonIds = new Set(req.student.anon_ids || []);
    if (req.anon) anonIds.add(req.anon);

    const students = store
      .read("students")
      .filter((s) => s.student_id !== req.student.student_id);
    await store.write("students", students);
    auth.clearAuthCookie(res);

    // Right-to-erasure: purge the behavioral event trail linked to this account,
    // not just the account row. A minimal deletion-audit event is kept afterward.
    const removed = await events.purgeAnon([...anonIds]);
    events.record("account_delete", { anon: req.anon });
    log.info("account deleted", { events_purged: removed });

    res.json({ ok: true });
  }),
);

// ---- University lead capture ------------------------------------------------
//
// The landing page's "For universities" contact form. No student waitlist
// exists anymore — students sign up directly. Public, unauthenticated POST, so
// it's rate-limited per IP and honeypot-protected.

const leadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many submissions. Try again in a few minutes.",
});

api.post("/pilot-leads", leadLimiter, (req, res) => {
  // Bots get a normal-looking success so tripping the honeypot doesn't teach
  // them to route around it — they just never get persisted.
  if (validate.isBotSubmission(req.body))
    return res.status(201).json({ ok: true });

  const result = validate.pilotLead(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const leads = store.read("pilot_leads");
  leads.push({
    id: crypto.randomUUID(),
    ...result.value,
    created_at: new Date().toISOString(),
    anon: req.anon || null,
  });
  store.write("pilot_leads", leads);
  events.record("pilot_lead", { anon: req.anon });

  res.status(201).json({ ok: true });
});

// ---- University partner auth + analytics ------------------------------------
//
// One shared dashboard build (/partners); every endpoint below scopes to the
// university bound to the SESSION's account — the client never supplies a
// university id. That server-side scoping is the row-level-security equivalent
// for this storage layer: frontend checks are cosmetic, this is the enforcement.

const uniLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Try again in a few minutes.",
});

api.post(
  "/uni/login",
  uniLoginLimiter,
  asyncRoute(async (req, res) => {
    const { email, password } = req.body || {};
    const account = uniAuth.findByEmail(email);
    const hash = account
      ? account.password_hash
      : "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
    const ok = await bcrypt.compare(String(password || ""), hash);
    if (!account || !ok)
      return res.status(401).json({ error: "Incorrect email or password." });
    uniAuth.setUniCookie(res, account);
    res.json({
      account: {
        email: account.email,
        university_id: account.university_id,
        university_name: account.university_name,
      },
    });
  }),
);

api.post("/uni/logout", (_req, res) => {
  uniAuth.clearUniCookie(res);
  res.json({ ok: true });
});

api.get("/uni/me", uniAuth.requireUni, (req, res) => {
  const a = req.uniAccount;
  res.json({
    account: {
      email: a.email,
      university_id: a.university_id,
      university_name: a.university_name,
    },
  });
});

// Daily views/saves/apply-clicks for the session's OWN university, plus a
// viewer-country breakdown (event anon ids joined to student profiles where
// that link exists; everyone else counts as "Unknown").
api.get("/uni/stats", uniAuth.requireUni, (req, res) => {
  const days = Math.min(
    90,
    Math.max(7, parseInt(String(req.query.days || ""), 10) || 30),
  );
  const uni = BY_ID.get(req.uniAccount.university_id);
  const ts = events.uniTimeseries(req.uniAccount.university_id, { days });

  const anonToCountry = new Map();
  for (const s of store.read("students")) {
    for (const anon of s.anon_ids || [])
      anonToCountry.set(anon, s.country_of_origin || "Unknown");
  }
  const countryCounts = new Map();
  for (const anon of ts.viewer_anons) {
    const c = anonToCountry.get(anon) || "Unknown";
    countryCounts.set(c, (countryCounts.get(c) || 0) + 1);
  }
  const viewer_countries = [...countryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([country, viewers]) => ({ country: country || "Unknown", viewers }));

  res.json({
    university: {
      id: req.uniAccount.university_id,
      name: uni ? uni.name : req.uniAccount.university_name,
    },
    days: ts.days,
    series: ts.series,
    totals: { ...ts.totals, unique_viewers: ts.viewer_anons.length },
    viewer_countries,
  });
});

// ---- Admin auth -------------------------------------------------------------

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Try again in a few minutes.",
});

api.post(
  "/admin/login",
  adminLoginLimiter,
  asyncRoute(async (req, res) => {
    const { email, password } = req.body || {};
    const admin = adminAuth.findAdminByEmail(email);
    const hash = admin
      ? admin.password_hash
      : "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
    const ok = await bcrypt.compare(String(password || ""), hash);
    if (!admin || !ok)
      return res.status(401).json({ error: "Incorrect email or password." });

    adminAuth.setAdminCookie(res, admin);
    res.json({ admin: { email: admin.email } });
  }),
);

api.post("/admin/logout", (_req, res) => {
  adminAuth.clearAdminCookie(res);
  res.json({ ok: true });
});

api.get("/admin/me", adminAuth.requireAdmin, (req, res) =>
  res.json({ admin: { email: req.admin.email } }),
);

// Every other /api/admin/* route requires an authenticated admin session.
const adminApi = express.Router();
adminApi.use(adminAuth.requireAdmin);

adminApi.get("/stats", (_req, res) => {
  // Read the event log once and reuse it for every aggregation below — this
  // used to call events.summary() and events.topByUni() separately, each
  // doing its own synchronous full-file read + JSON.parse of every line.
  // Harmless at today's size; would double the (blocking) I/O cost of every
  // dashboard load once events.jsonl has real production history.
  const allEvents = events.readAll();
  const s = events.computeSummary(allEvents);
  const students = store.read("students");
  const clicks = store.read("clicks");
  const currentlySaved = students.reduce(
    (n, x) => n + (x.saved_universities?.length || 0),
    0,
  );

  const topByClicks = Object.entries(clicks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => ({
      id,
      name: BY_ID.get(id)?.name || id,
      country: BY_ID.get(id)?.country || "",
      click_count: count,
    }));

  const topByViews = events
    .computeTopByUni(allEvents, "profile_view", 10)
    .map((r) => ({
      id: r.id,
      name: BY_ID.get(r.id)?.name || r.id,
      country: BY_ID.get(r.id)?.country || "",
      views: r.count,
      unique_viewers: r.unique,
    }));

  // Level-1 "how are we doing" extras, computed from the same single read:
  // week-over-week signup change, activation, and new B2B leads this week.
  const now = Date.now();
  const WEEK = 7 * 86_400_000;
  const signupEvents = allEvents.filter((e) => e.type === "signup");
  const signups_7d = signupEvents.filter(
    (e) => now - Date.parse(e.ts) <= WEEK,
  ).length;
  const signups_prev_7d = signupEvents.filter((e) => {
    const age = now - Date.parse(e.ts);
    return age > WEEK && age <= 2 * WEEK;
  }).length;
  const leads = store.read("pilot_leads");
  const leads_7d = leads.filter(
    (l) => l.created_at && now - Date.parse(l.created_at) <= WEEK,
  ).length;

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
      compares: s.totals.compare || 0,
      apply_clicks: s.totals.apply_click || 0,
      apply_clicks_unique: Object.values(s.applyUnique).reduce(
        (a, b) => a + b,
        0,
      ),
      pageviews: (s.totals.pageview || 0) + (s.totals.profile_view || 0),
      universities_verified: VERIFIED_COUNT,
      pilot_leads: leads.length,
      update_subscribers: students.filter((x) => x.updates_optin).length,
    },
    activation: events.computeActivation(allEvents),
    signups_7d,
    signups_prev_7d,
    leads_7d,
    last_24h: s.last24h,
    last_7d: s.last7d,
    top_universities_by_apply_clicks: topByClicks,
    top_universities_by_views: topByViews,
  });
});

// Time-windowed traffic view: visitors, pageviews, top pages/referrers/devices/languages.
adminApi.get("/traffic", (req, res) => {
  const days = Math.min(
    90,
    Math.max(1, parseInt(String(req.query.days || ""), 10) || 7),
  );
  res.json({ days, ...events.traffic({ sinceMs: days * 86_400_000 }) });
});

// Reach funnel: distinct clients at each stage, with conversion rates.
// Overview: DAU/WAU/MAU with a new-vs-returning split, over distinct anonymous
// clients. No query params — these three windows are the metric definition.
adminApi.get("/overview", (_req, res) => {
  res.json(events.overview());
});

adminApi.get("/funnel", (req, res) => {
  const days = Math.min(
    90,
    Math.max(1, parseInt(String(req.query.days || ""), 10) || 7),
  );
  res.json({ days, stages: events.funnel({ sinceMs: days * 86_400_000 }) });
});

// Weekly cohort retention grid.
adminApi.get("/retention", (req, res) => {
  const weeks = Math.min(
    12,
    Math.max(2, parseInt(String(req.query.weeks || ""), 10) || 6),
  );
  res.json(events.retention({ weeks }));
});

// Most common search terms — tells you what students want and where data gaps are.
adminApi.get("/searches", (req, res) => {
  const days = Math.min(
    90,
    Math.max(1, parseInt(String(req.query.days || ""), 10) || 7),
  );
  const limit = Math.min(
    50,
    Math.max(1, parseInt(String(req.query.limit || ""), 10) || 10),
  );
  res.json({
    days,
    terms: events.topSearches({ sinceMs: days * 86_400_000, limit }),
  });
});

// University contact/pilot leads — the actual rows, newest first, so a lead
// can be followed up from the dashboard without shelling into the server.
adminApi.get("/leads", (_req, res) => {
  const leads = [...store.read("pilot_leads")].reverse();
  res.json({ count: leads.length, leads });
});

// ---- Data-quality audit (admin-only, precomputed at boot) -------------------
// The aggregate dataset audit. No per-request scanning — this is the cached
// DATASET_AUDIT computed once at startup.
adminApi.get("/data-quality", (_req, res) => res.json(DATASET_AUDIT));

// Filterable record list for the audit table: by quality band, verification
// status, staleness. Reads the precomputed QUALITY_RECORDS index (no rescan).
adminApi.get("/data-quality/records", (req, res) => {
  const band = typeof req.query.band === "string" ? req.query.band : "";
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const staleOnly = req.query.stale === "1";
  const limit = Math.min(
    200,
    Math.max(1, parseInt(String(req.query.limit || ""), 10) || 50),
  );
  const offset = Math.max(0, parseInt(String(req.query.offset || ""), 10) || 0);

  let rows = QUALITY_RECORDS;
  if (band) rows = rows.filter((r) => r.band === band);
  if (status) rows = rows.filter((r) => r.verification_status === status);
  if (staleOnly) rows = rows.filter((r) => r.stale);
  // Lowest quality first — the records most in need of review lead the table.
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  res.json({
    count: sorted.length,
    records: sorted.slice(offset, offset + limit),
  });
});

// Create a partner login for a verified claim: binds an email+password to one
// university and marks that university claimed. This IS the claim-approval
// step — a human (admin) checks the requester actually works there first.
adminApi.post("/uni-accounts", async (req, res) => {
  const { email, password, university_id } = req.body || {};
  const uni = BY_ID.get(String(university_id || ""));
  if (!uni)
    return res
      .status(404)
      .json({ error: "University not found. Pass a valid university_id." });
  try {
    const account = await uniAuth.createUniAccount({
      email,
      password,
      university_id: uni.id,
      university_name: uni.name,
    });
    const claims = store.read("claims");
    claims[uni.id] = {
      account_id: account.account_id,
      claimed_at: new Date().toISOString(),
    };
    await store.write("claims", claims);
    log.info("university claimed", { university: uni.id });
    res.status(201).json({
      account,
      university: { id: uni.id, name: uni.name, claimed_status: "claimed" },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Product-update subscribers (students who opted in at sign-up), as CSV — lets
// the founders send an update through any mail tool today. This is the seam
// where a real email provider (Resend/Postmark/SES) plugs in later: same list,
// automated sending instead of an export.
adminApi.get("/subscribers.csv", (_req, res) => {
  const subs = store.read("students").filter((s) => s.updates_optin);
  const esc = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
  const rows = subs.map((s) =>
    [
      esc(s.email),
      esc(s.full_name),
      esc(s.country_of_origin),
      esc(s.signup_date),
    ].join(","),
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="universo-update-subscribers.csv"',
  );
  res
    .type("text/csv")
    .send(
      ["email,full_name,country_of_origin,signup_date", ...rows].join("\n") +
        "\n",
    );
});

api.use("/admin", adminApi);

app.use("/api", api);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/healthz", (_req, res) =>
  res.json({
    status: "ok",
    universities: UNIVERSITIES.length,
    uptime: process.uptime(),
  }),
);

// ---------------------------------------------------------------------------
// Static assets, SEO, and SSR
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");

// Single-source branding + cache-busting for every server-served HTML page.
// `<!--BRAND_MARK-->` is filled from lib/brand.js (change the mark once, every
// page updates), and the un-hashed CSS/JS get a per-deploy `?v=` so a branding
// change never sits behind a stale cached asset (the logo-cache confusion).
const ASSET_V =
  (process.env.RENDER_GIT_COMMIT || "").slice(0, 8) || String(Date.now());
const withBrand = (html) =>
  html
    .split("<!--BRAND_MARK-->")
    .join(brand.markSvgInline())
    .replace(/(\/css\/styles\.css|\/js\/app\.js)(?![?\w])/g, `$1?v=${ASSET_V}`);
const readPage = (file) =>
  withBrand(fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8"));

const SHELL = readPage("index.html");
const LANDING = readPage("landing.html");
const ADMIN_PAGE = readPage("admin.html");
const PARTNERS_PAGE = readPage("partners.html");
const PARTNERS_DEMO_PAGE = readPage("partners-demo.html");
const sendHtml = (res, html) =>
  res.set("Cache-Control", "no-cache").type("html").send(html);
const FOR_UNIVERSITIES = (() => {
  const fmt = (n) => n.toLocaleString("en-US");
  return readPage("for-universities.html")
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
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    redirect: false,
    // Default was max-age=0, so every repeat visit re-validated CSS, JS and each
    // font over the network — a round-trip per asset even when nothing changed.
    // Fonts are content that never changes, so cache them for a year and mark
    // them immutable (no revalidation at all). CSS/JS change on deploy and have
    // no content hash in their filenames, so they get a short window: long
    // enough to skip the round-trip on a burst of page views, short enough that
    // a deploy is picked up within minutes. HTML shells stay uncached.
    setHeaders(res, filePath) {
      if (/\.(woff2?|ttf|otf)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (/\.(css|js)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=300");
      } else if (/\.html$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

app.get("/admin", (_req, res) => sendHtml(res, ADMIN_PAGE));

// Partner dashboard — one shared static page for every university account;
// which university's data it shows is decided by the session server-side.
app.get("/partners", (_req, res) => sendHtml(res, PARTNERS_PAGE));

// Public, no-login SALES demo of the partner dashboard — clearly labelled
// "example data, not live". Sells the value prop before a university claims.
app.get("/partners/demo", (_req, res) => sendHtml(res, PARTNERS_DEMO_PAGE));

// The B2B pitch (analytics, claim-a-profile, pilot contact form) lives on its
// own page, off the student-facing homepage.
app.get("/for-universities", (req, res) => {
  events.record("pageview", {
    anon: req.anon,
    path: "/for-universities",
    ref: refDomain(req),
    lang: (req.get("Accept-Language") || "")
      .split(",")[0]
      .split(";")[0]
      .trim()
      .slice(0, 10),
    device: /mobile/i.test(req.get("User-Agent") || "") ? "mobile" : "desktop",
  });
  res.send(FOR_UNIVERSITIES);
});

// Old routes that used to carry this content — permanent redirects so shared
// links keep working.
app.get("/join", (_req, res) => res.redirect(301, "/for-universities"));

app.get("/robots.txt", (req, res) => {
  // Must agree with the sitemap it points at — see appOrigin().
  const base = appOrigin(req);
  // Operational/account surfaces carry no unique public content — keep
  // crawlers out of them (they're also noindex'd at the page level). Public
  // pages (/, /discover, /university/*) are open to everyone.
  //
  // AI assistants (ChatGPT/GPTBot, etc.) already fall under `*` and are
  // welcome; they're named explicitly below so the intent is unambiguous.
  // A named user-agent group does NOT inherit the `*` rules, so the same
  // Disallow lines are repeated in each group — otherwise those crawlers
  // would get no restrictions at all.
  const disallow = [
    "Disallow: /admin",
    "Disallow: /partners",
    "Disallow: /saved",
    "Disallow: /account",
  ];
  res
    .type("text/plain")
    .send(
      [
        "# AI assistants — explicitly welcome on public pages.",
        "User-agent: GPTBot",
        "User-agent: ChatGPT-User",
        "User-agent: OAI-SearchBot",
        "User-agent: PerplexityBot",
        "User-agent: Google-Extended",
        "Allow: /",
        ...disallow,
        "",
        "User-agent: *",
        ...disallow,
        "Allow: /",
        `Sitemap: ${base}/sitemap.xml`,
        "",
      ].join("\n"),
    );
});

// Paths only — deliberately NOT the finished XML. Baking the origin into the
// cache meant whichever Host header arrived first decided what the sitemap
// advertised for the rest of the process: one crawler hitting the old hostname
// after a deploy would have the new domain serving a sitemap full of old-domain
// URLs. Joining per request is 302 string concats on a rarely-hit route.
let sitemapPaths = null; // dataset is static — collect once
app.get("/sitemap.xml", (req, res) => {
  const base = appOrigin(req);
  if (!sitemapPaths) {
    // Only VERIFIED profiles are submitted for indexing. The ~3,700
    // register-only records are near-duplicate boilerplate (name, city, type,
    // enrolment) with no tuition, programs or entry requirements — asking
    // Google to index them invites a thin-content judgement on the whole
    // domain. They stay reachable and crawlable (noindex,follow on the page
    // itself), so their outbound links still pass, but they're not advertised.
    sitemapPaths = [
      "", // the homepage / front door
      "discover",
      "for-universities",
      ...UNIVERSITIES.filter((u) => u.verified).map(
        (u) => `university/${u.id}`,
      ),
    ];
  }
  const urls = sitemapPaths
    .map((p) => `  <url><loc>${base}/${p}</loc></url>`)
    .join("\n");
  res
    .type("application/xml")
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    );
});

// Server-rendered profile pages (real HTML + per-page meta for crawlers).
app.get("/university/:id", (req, res) => {
  if (SLUG_REDIRECTS[req.params.id]) {
    return res.redirect(
      301,
      `/university/${encodeURIComponent(SLUG_REDIRECTS[req.params.id])}`,
    );
  }
  const uni = BY_ID.get(req.params.id);
  if (!uni) {
    return res.status(404).send(
      ssr.injectSSR(SHELL, {
        metaHtml: ssr.metaTags({
          title: "University not found — Universo",
          description: "This university could not be found.",
        }),
        viewHtml:
          '<div class="empty"><h3>University not found</h3><a href="/discover">Back to discover</a></div>',
      }),
    );
  }
  const loc = [uni.city, uni.country].filter(Boolean).join(", ");
  res.send(
    ssr.injectSSR(SHELL, {
      metaHtml: ssr.metaTags({
        title: `${uni.name}${loc ? " — " + loc : ""} | Universo`,
        description:
          uni.short_description ||
          `${uni.name} — discover programs, facts and how to apply.`,
        canonical: `${appOrigin(req)}/university/${uni.id}`,
        // Unverified = register-only boilerplate. noindex,FOLLOW: keep it out of
        // the index without orphaning the links on it. A profile becomes
        // indexable the moment it earns real content (or a university claims it).
        noindex: uni.verified ? false : "follow",
      }),
      viewHtml: ssr.profileView(withClaim(uni)),
    }),
  );
});

// The homepage IS the product: visitors see real, browsable university data
// immediately instead of a marketing page. Permanent redirect keeps one
// canonical URL for the directory.
// The front door: a logged-in student lands on their Dream Plan (the "what
// should I do next" home — their next best action, deadlines, progress), NOT a
// cold directory. Anonymous visitors get the marketing landing + live matcher.
app.get("/", (req, res) => {
  if (auth.loadStudent(req)) return res.redirect(302, "/journey");
  sendHtml(res, LANDING);
});

// One-click unsubscribe (no login, no JS) from an email footer link. The token
// is a stateless HMAC of the student id (lib/auth), so it works for any account
// at any time. `?cat=` unsubscribes one category; otherwise all email off.
app.get("/unsubscribe", (req, res) => {
  const page = (title, body) =>
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Universo</title><body style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#131B2E;line-height:1.6"><h1 style="font-size:1.3rem">${title}</h1>${body}<p style="margin-top:24px"><a href="/journey" style="color:#0d9488">Manage all email preferences →</a></p></body>`,
      );

  const id = auth.verifyUnsubscribeToken(req.query.token);
  if (!id) return page("Link expired", "<p>This unsubscribe link isn't valid. You can manage email preferences from your account settings.</p>");
  const students = store.read("students");
  const student = students.find((s) => s.student_id === id);
  if (!student) return page("Done", "<p>You won't receive these emails.</p>");

  if (!student.notifications || typeof student.notifications !== "object")
    student.notifications = {};
  const cat = req.query.cat;
  const targets = notify.NOTIFICATION_CATEGORIES.includes(cat)
    ? [cat]
    : notify.NOTIFICATION_CATEGORIES;
  for (const k of targets) student.notifications[k] = false;
  store.write("students", students);
  events.record("unsubscribe", { anon: req.anon });
  return page(
    "You're unsubscribed",
    `<p>You won't receive ${targets.length === 1 ? "these" : "Universo"} emails${targets.length === 1 ? "" : " anymore"}. You can turn any of them back on in your account settings whenever you like.</p>`,
  );
});

// Public, account-free directory — browsing and searching require nothing.
// Only actions gate on login (saving, recommendations), enforced at their own
// endpoints; the page itself is open and server-rendered for crawlers. Its
// pageview is recorded server-side so anonymous first visits (the top of the
// funnel) aren't invisible to analytics.
app.get("/discover", (req, res) => {
  events.record("pageview", {
    anon: req.anon,
    path: "/discover",
    ref: refDomain(req),
    lang: (req.get("Accept-Language") || "")
      .split(",")[0]
      .split(";")[0]
      .trim()
      .slice(0, 10),
    device: /mobile/i.test(req.get("User-Agent") || "") ? "mobile" : "desktop",
  });
  // SSR mirrors the client default: verified profiles first impression.
  const list = search.query(
    INDEX,
    { limit: 50, verified: "1" },
    clickOf,
  ).universities;
  res.send(
    ssr.injectSSR(SHELL, {
      metaHtml: ssr.metaTags({
        title: "Discover universities in Europe — Universo",
        description: `${VERIFIED_COUNT} verified EU university profiles — tuition, scholarships and apply links — in a directory of ${UNIVERSITIES.length.toLocaleString("en-US")} European institutions. Free to browse.`,
        canonical: `${appOrigin(req)}/discover`,
      }),
      viewHtml: ssr.directoryView(list, UNIVERSITIES.length),
    }),
  );
});

// /saved and /account previously fell through to the bare SPA shell: empty
// <main>, stale default meta, and indexable. They now ship real fallback
// content (visible before/without JS — the SPA replaces it on hydrate),
// page-appropriate meta, and noindex (no unique public content on either).
// Compare is a private view of the student's own shortlist — noindex, and the
// SSR fallback is a sign-in prompt, exactly like /saved.
app.get("/compare", (_req, res) => {
  res.send(
    ssr.injectSSR(SHELL, {
      metaHtml: ssr.metaTags({
        title: "Compare your universities — Universo",
        description:
          "Compare your saved European universities side by side on Universo.",
        noindex: true,
      }),
      viewHtml: `
      <section class="ssr">
        <h1>Compare your universities</h1>
        <p>Sign in to compare your shortlist side by side — saving universities is free, always.</p>
        <p><a href="/account">Sign in</a> · <a href="/account?mode=register&src=compare-ssr">Create a free account</a></p>
      </section>`,
    }),
  );
});

app.get("/saved", (_req, res) => {
  res.send(
    ssr.injectSSR(SHELL, {
      metaHtml: ssr.metaTags({
        title: "Your saved universities — Universo",
        description:
          "Your personal shortlist of European universities on Universo.",
        noindex: true,
      }),
      viewHtml: `
      <section class="ssr">
        <h1>Your saved universities</h1>
        <p>Sign in to see your shortlist — saving universities is free, always.</p>
        <p><a href="/account">Sign in</a> · <a href="/account?mode=register&src=saved-ssr">Create a free account</a></p>
      </section>`,
    }),
  );
});

app.get("/journey", (_req, res) => {
  res.send(
    ssr.injectSSR(SHELL, {
      metaHtml: ssr.metaTags({
        title: "Dream Plan — Universo",
        description:
          "Your personal study-abroad roadmap on Universo: your dream, readiness, next best step, documents, matches and scholarships.",
        noindex: true,
      }),
      viewHtml: `
      <section class="ssr">
        <h1>Your Dream Plan</h1>
        <p>Sign in to see your dream, how ready you are, your next best step, your document checklist, matches and scholarships — free, always.</p>
        <p><a href="/account">Sign in</a> · <a href="/account?mode=register&src=journey-ssr">Create a free account</a></p>
      </section>`,
    }),
  );
});

app.get("/account", (_req, res) => {
  res.send(
    ssr.injectSSR(SHELL, {
      metaHtml: ssr.metaTags({
        title: "Sign in or create your free account — Universo",
        description:
          "Log in to Universo or create a free student account to save universities and get matched to programs across Europe.",
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
    }),
  );
});

// SPA fallback for any other route.
app.get("*", (_req, res) => res.send(SHELL));

// Error handler (last).
app.use((err, req, res, _next) => {
  log.captureError(err, { id: req.id, path: req.path });
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong." });
});

// ---------------------------------------------------------------------------
// Start + graceful shutdown (only when run directly, not when imported by tests)
// ---------------------------------------------------------------------------
if (require.main === module) {
  const server = app.listen(cfg.PORT, () => {
    log.info("listening", {
      url: `http://localhost:${cfg.PORT}`,
      universities: UNIVERSITIES.length,
      errorMonitoring: log.errorMonitoringEnabled,
      aiExplanations: explain.LLM_ENABLED,
    });
    process.stdout.write(
      `\n  Universo → http://localhost:${cfg.PORT}   (admin: /admin)\n  ${UNIVERSITIES.length.toLocaleString("en-US")} universities loaded\n\n`,
    );
  });
  if (!process.env.SKIP_PHOTO_PREWARM)
    warmVerifiedPhotos().catch((e) =>
      log.warn("photo prewarm failed", { error: e.message }),
    );

  // Retention delivery: an in-process daily tick that emails due digests +
  // deadline reminders (lib/notify decides who's due, deduped by per-student
  // timestamps so a restart can't double-send). Only runs when email is live —
  // dormant deployments schedule nothing. Ceiling: a single web process; if you
  // scale out to multiple instances, move this to one worker / external cron.
  let notifTimer = null;
  if (email.ENABLED) {
    const origin =
      (() => {
        try {
          return process.env.UNIVERSO_APP_URL
            ? new URL(process.env.UNIVERSO_APP_URL).origin
            : "";
        } catch {
          return "";
        }
      })() || `http://localhost:${cfg.PORT}`;
    const send = (kind, student, payload) => {
      const unsubscribeUrl = `${origin}/unsubscribe?token=${auth.unsubscribeToken(student.student_id)}`;
      const data = { origin, unsubscribeUrl, ...payload };
      return kind === "digest"
        ? email.sendWeeklyDigest(student, data)
        : email.sendDeadlineReminder(student, data);
    };
    const runNotifications = async () => {
      const students = store.read("students");
      try {
        const r = await notify.runDueEmails({
          students,
          now: new Date(),
          buildData: buildJourneyData,
          send,
          persist: () => store.write("students", students),
        });
        if (r.digests || r.reminders) log.info("notifications sent", r);
      } catch (e) {
        log.captureError(e, { where: "notifications" });
      }
    };
    const DAY = 24 * 60 * 60 * 1000;
    notifTimer = setInterval(runNotifications, DAY);
    notifTimer.unref?.();
    setTimeout(runNotifications, 60 * 1000).unref?.(); // first pass ~1min after boot
  }

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", { signal });
    server.close();
    if (notifTimer) clearInterval(notifTimer);
    try {
      await events.flush();
    } catch {
      /* ignore */
    }
    store.flushAll(); // persist debounced writes (clicks, last-active, photos)
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app; // exported for tests
module.exports.buildJourneyData = buildJourneyData; // for digest/notify tests
