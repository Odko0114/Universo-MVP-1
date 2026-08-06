"use strict";

/**
 * Centralised configuration, validated once at boot. Fail-fast on bad config in
 * production rather than discovering it at request time.
 */

const crypto = require("crypto");
const log = require("./log");

const PROD = process.env.NODE_ENV === "production";

let jwtSecret = process.env.UNIVERSO_JWT_SECRET;
if (!jwtSecret) {
  if (PROD) {
    // In production a stable secret is mandatory (random-per-boot would sign out
    // everyone on every deploy and breaks multi-instance deployments).
    throw new Error("UNIVERSO_JWT_SECRET must be set in production.");
  }
  jwtSecret = crypto.randomBytes(32).toString("hex");
  log.warn(
    "UNIVERSO_JWT_SECRET not set — using a random dev secret (tokens reset on restart).",
  );
}

module.exports = {
  PROD,
  PORT: Number(process.env.PORT) || 3000,
  JWT_SECRET: jwtSecret,
  TOKEN_TTL_DAYS: 7,
  COOKIE_TOKEN: "uv_token",
  COOKIE_ANON: "uv_anon",
  BCRYPT_ROUNDS: 10,
  // Admin session is a separate cookie/claim from student auth, and shorter-lived.
  COOKIE_ADMIN: "uv_admin",
  ADMIN_TOKEN_TTL_DAYS: 1,
};
