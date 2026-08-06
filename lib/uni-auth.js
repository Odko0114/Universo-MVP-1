"use strict";

/**
 * University-partner authentication — the third, separate auth realm (students
 * in lib/auth.js, admins in lib/admin-auth.js). A university account belongs
 * to exactly ONE university (university_id is fixed at account creation by an
 * admin) and every partner-facing endpoint derives the university it may see
 * from the session — never from a client-supplied id. That server-side scoping
 * is this stack's equivalent of row-level security: a logged-in university can
 * only ever query its own rows, enforced where the data is read.
 *
 * Accounts are created by an admin (POST /api/admin/uni-accounts) after a
 * claim request is verified — there is no self-serve signup, deliberately:
 * "claiming" a university profile is an identity check, not a form.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cfg = require("./config");
const store = require("./store");
const auth = require("./auth"); // parseCookies

const COOKIE_UNI = "uv_uni";
const TOKEN_TTL_DAYS = 7;

function findByEmail(email) {
  return store.read("uni_accounts").find(
    (a) =>
      a.email ===
      String(email || "")
        .trim()
        .toLowerCase(),
  );
}

function signToken(account) {
  return jwt.sign(
    { sub: account.account_id, role: "university" },
    cfg.JWT_SECRET,
    { expiresIn: `${TOKEN_TTL_DAYS}d` },
  );
}

function setCookie(res, name, value, maxAgeDays) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (cfg.PROD) parts.push("Secure");
  if (maxAgeDays) parts.push(`Max-Age=${Math.round(maxAgeDays * 86400)}`);
  const prev = res.getHeader("Set-Cookie");
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join("; "));
  res.setHeader("Set-Cookie", list);
}

const setUniCookie = (res, account) =>
  setCookie(res, COOKIE_UNI, signToken(account), TOKEN_TTL_DAYS);
const clearUniCookie = (res) => setCookie(res, COOKIE_UNI, "", 0);

function loadUniAccount(req) {
  const cookies = req._cookies || (req._cookies = auth.parseCookies(req));
  const token = cookies[COOKIE_UNI];
  if (!token) return null;
  let payload;
  try {
    payload = /** @type {any} */ (jwt.verify(token, cfg.JWT_SECRET));
  } catch {
    return null;
  }
  if (payload.role !== "university") return null;
  return (
    store.read("uni_accounts").find((a) => a.account_id === payload.sub) || null
  );
}

function requireUni(req, res, next) {
  const account = loadUniAccount(req);
  if (!account) {
    clearUniCookie(res);
    return res.status(401).json({ error: "University sign-in required." });
  }
  req.uniAccount = account;
  next();
}

/**
 * Create a partner account bound to one university (admin-only path).
 * @returns the stored account (without password hash).
 */
async function createUniAccount({
  email,
  password,
  university_id,
  university_name,
}) {
  const norm = String(email || "")
    .trim()
    .toLowerCase();
  if (!norm || !password || String(password).length < 10) {
    throw new Error(
      "A valid email and a password of at least 10 characters are required.",
    );
  }
  const accounts = store.read("uni_accounts");
  if (accounts.some((a) => a.email === norm))
    throw new Error("An account with this email already exists.");

  const account = {
    account_id: crypto.randomUUID(),
    email: norm,
    password_hash: await bcrypt.hash(String(password), cfg.BCRYPT_ROUNDS),
    university_id,
    university_name,
    created_at: new Date().toISOString(),
  };
  accounts.push(account);
  await store.write("uni_accounts", accounts);
  const { password_hash, ...safe } = account;
  return safe;
}

module.exports = {
  COOKIE_UNI,
  findByEmail,
  setUniCookie,
  clearUniCookie,
  loadUniAccount,
  requireUni,
  createUniAccount,
};
