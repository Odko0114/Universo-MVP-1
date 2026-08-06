"use strict";

/**
 * Admin authentication — deliberately separate from student auth (lib/auth.js):
 * its own store (data/admins.json), its own cookie/JWT claim, and a shorter
 * session lifetime. Nothing about /admin or /api/admin/* should be reachable
 * with a student session, and vice versa.
 *
 * Bootstrapping an admin account:
 *   - `npm run create-admin -- you@example.com "a strong password"`, or
 *   - set ADMIN_EMAIL + ADMIN_PASSWORD in the environment before first boot
 *     (bootstrapFromEnv() creates the account once, only if none exist yet).
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cfg = require("./config");
const store = require("./store");
const log = require("./log");
const auth = require("./auth"); // reuse cookie helpers (parseCookies, appendCookie via serializeCookie)

function findAdminByEmail(email) {
  return store.read("admins").find(
    (a) =>
      a.email ===
      String(email || "")
        .trim()
        .toLowerCase(),
  );
}

function signAdminToken(admin) {
  return jwt.sign({ sub: admin.admin_id, role: "admin" }, cfg.JWT_SECRET, {
    expiresIn: `${cfg.ADMIN_TOKEN_TTL_DAYS}d`,
  });
}

// serializeCookie/appendCookie aren't exported from auth.js (kept private there);
// duplicate the tiny cookie-write here rather than widen that module's surface.
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

function setAdminCookie(res, admin) {
  setCookie(
    res,
    cfg.COOKIE_ADMIN,
    signAdminToken(admin),
    cfg.ADMIN_TOKEN_TTL_DAYS,
  );
}

function clearAdminCookie(res) {
  setCookie(res, cfg.COOKIE_ADMIN, "", 0);
}

function loadAdmin(req) {
  const cookies = req._cookies || (req._cookies = auth.parseCookies(req));
  const token = cookies[cfg.COOKIE_ADMIN];
  if (!token) return null;
  let payload;
  try {
    payload = /** @type {any} */ (jwt.verify(token, cfg.JWT_SECRET));
  } catch {
    return null;
  }
  if (payload.role !== "admin") return null;
  const admin = store.read("admins").find((a) => a.admin_id === payload.sub);
  return admin || null;
}

function requireAdmin(req, res, next) {
  const admin = loadAdmin(req);
  if (!admin) {
    clearAdminCookie(res);
    return res.status(401).json({ error: "Admin authentication required." });
  }
  req.admin = admin;
  next();
}

async function createAdmin(email, password) {
  const norm = String(email || "")
    .trim()
    .toLowerCase();
  if (!norm || !password || password.length < 10) {
    throw new Error(
      "A valid email and a password of at least 10 characters are required.",
    );
  }
  const admins = store.read("admins");
  const existing = admins.find((a) => a.email === norm);
  const password_hash = await bcrypt.hash(password, cfg.BCRYPT_ROUNDS);
  if (existing) {
    existing.password_hash = password_hash;
    existing.updated_at = new Date().toISOString();
  } else {
    admins.push({
      admin_id: crypto.randomUUID(),
      email: norm,
      password_hash,
      created_at: new Date().toISOString(),
    });
  }
  await store.write("admins", admins);
  return norm;
}

/** One-time convenience bootstrap from env vars, only if no admin exists yet. */
async function bootstrapFromEnv() {
  if (store.read("admins").length > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  try {
    await createAdmin(email, password);
    log.info("admin bootstrapped from environment", { email }); // email logged once, deliberately, for operator confirmation
  } catch (e) {
    log.warn("admin bootstrap from environment failed", { error: e.message });
  }
}

module.exports = {
  findAdminByEmail,
  setAdminCookie,
  clearAdminCookie,
  loadAdmin,
  requireAdmin,
  createAdmin,
  bootstrapFromEnv,
};
