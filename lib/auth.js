'use strict';

/**
 * Authentication: JWT in an httpOnly cookie (not localStorage, so it can't be
 * exfiltrated by XSS), with a per-user token version for revocation, plus an
 * anonymous client id cookie for PII-free analytics.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cfg = require('./config');
const store = require('./store');

// --- cookies ---------------------------------------------------------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** @param {{ maxAgeDays?: number, httpOnly?: boolean }} [opts] */
function serializeCookie(name, value, opts = {}) {
  const { maxAgeDays, httpOnly = true } = opts;
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (cfg.PROD) parts.push('Secure');
  if (maxAgeDays) parts.push(`Max-Age=${Math.round(maxAgeDays * 86400)}`);
  return parts.join('; ');
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

// --- tokens ----------------------------------------------------------------

function signToken(student) {
  return jwt.sign(
    { sub: student.student_id, ver: student.token_version || 0 },
    cfg.JWT_SECRET,
    { expiresIn: `${cfg.TOKEN_TTL_DAYS}d` },
  );
}

function setAuthCookie(res, student) {
  appendCookie(res, serializeCookie(cfg.COOKIE_TOKEN, signToken(student), { maxAgeDays: cfg.TOKEN_TTL_DAYS }));
}

function clearAuthCookie(res) {
  appendCookie(res, `${cfg.COOKIE_TOKEN}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${cfg.PROD ? '; Secure' : ''}`);
}

function findStudentById(id) {
  return store.read('students').find((s) => s.student_id === id);
}

// --- middleware ------------------------------------------------------------

/** Ensure every client has an anonymous id (for dedup analytics; no PII). */
function anon(req, res, next) {
  const cookies = req._cookies || (req._cookies = parseCookies(req));
  let id = cookies[cfg.COOKIE_ANON];
  if (!id) {
    id = crypto.randomUUID();
    appendCookie(res, serializeCookie(cfg.COOKIE_ANON, id, { maxAgeDays: 365 }));
  }
  req.anon = id;
  next();
}

const lastActiveWrites = new Map(); // student_id -> ms of last persisted touch
const ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

function tokenFrom(req) {
  const cookies = req._cookies || (req._cookies = parseCookies(req));
  if (cookies[cfg.COOKIE_TOKEN]) return cookies[cfg.COOKIE_TOKEN];
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null; // bearer still accepted for API clients
}

/** Attach req.student if a valid session exists; otherwise leave it undefined. */
function loadStudent(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  let payload;
  try { payload = /** @type {any} */ (jwt.verify(token, cfg.JWT_SECRET)); } catch { return null; }
  const student = findStudentById(payload.sub);
  if (!student) return null;
  if ((student.token_version || 0) !== (payload.ver || 0)) return null; // revoked
  return student;
}

/** Best-effort "last active" touch, throttled + debounced to avoid hot writes. */
function touchActive(student) {
  const now = Date.now();
  if (now - (lastActiveWrites.get(student.student_id) || 0) < ACTIVE_THROTTLE_MS) return;
  lastActiveWrites.set(student.student_id, now);
  student.last_active_date = new Date().toISOString();
  store.writeDebounced('students', store.read('students'));
}

function requireAuth(req, res, next) {
  const student = loadStudent(req);
  if (!student) {
    clearAuthCookie(res);
    return res.status(401).json({ error: 'Authentication required.' });
  }
  touchActive(student);
  req.student = student;
  next();
}

module.exports = {
  parseCookies, signToken, setAuthCookie, clearAuthCookie,
  anon, requireAuth, loadStudent, findStudentById,
};
