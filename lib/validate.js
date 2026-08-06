"use strict";

/**
 * Small, dependency-free input validation. Returns a `{ ok, value|error }`
 * result so callers stay explicit and we never trust request bodies. Caps every
 * string length so a hostile client can't store megabytes per field.
 */

const { FIELD_SET } = require("./fields");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX = {
  name: 120,
  email: 254,
  password: 200,
  field: 120,
  country: 80,
  org: 160,
  message: 1000,
};
const DEGREES = new Set(["Bachelor", "Master", "PhD"]);
const CITY_PREFS = new Set(["large", "mid", "small"]); // '' / absent = no preference

const str = (v) => (typeof v === "string" ? v.trim() : "");

function fail(error) {
  return { ok: false, error };
}
function pass(value) {
  return { ok: true, value };
}

/**
 * Sanitize the matching-profile fields (shared by registration and the profile
 * PATCH). Everything here is optional — a partial or empty profile is valid, it
 * just means the matching layer stays off until enough is filled in. Never
 * throws on junk; silently drops out-of-list values so a hostile client can't
 * inject arbitrary strings into fields both sides of the match trust.
 */
function matchProfileFields(body = {}) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const fields_of_interest = arr(body.fields_of_interest)
    .filter((f) => FIELD_SET.has(f))
    .slice(0, 3);
  const preferred_languages = arr(body.preferred_languages)
    .map((l) => str(l))
    .filter((l) => l && l.length <= 40)
    .slice(0, 6);
  const country_preference = arr(body.country_preference)
    .map((c) => str(c).slice(0, MAX.country))
    .filter(Boolean)
    .slice(0, 10);

  let budget = null;
  if (body.budget_max_eur_year != null && body.budget_max_eur_year !== "") {
    const n = Math.round(Number(body.budget_max_eur_year));
    if (Number.isFinite(n) && n >= 0) budget = Math.min(n, 1_000_000);
  }

  const degree = str(body.degree_level);
  const city = str(body.city_preference);
  return {
    fields_of_interest,
    budget_max_eur_year: budget,
    preferred_languages,
    degree_level: DEGREES.has(degree) ? degree : "",
    city_preference: CITY_PREFS.has(city) ? city : "",
    country_preference,
    home_country: str(body.home_country).slice(0, MAX.country),
  };
}

const validate = {
  MAX,

  registration(body = {}) {
    const full_name = str(body.full_name);
    const email = str(body.email).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";

    if (!full_name) return fail("Full name is required.");
    if (full_name.length > MAX.name) return fail("Full name is too long.");
    if (!EMAIL_RE.test(email) || email.length > MAX.email)
      return fail("A valid email address is required.");
    if (password.length < 8)
      return fail("Password must be at least 8 characters.");
    if (password.length > MAX.password) return fail("Password is too long.");
    if (body.consent !== true)
      return fail("You must accept the privacy policy to create an account.");

    return pass({
      full_name,
      email,
      password,
      country_of_origin: str(body.country_of_origin).slice(0, MAX.country),
      field_of_interest: str(body.field_of_interest).slice(0, MAX.field),
      target_degree_level: str(body.target_degree_level).slice(0, 40),
      // Separate, optional consent for product-update emails — never bundled
      // into the required privacy consent (GDPR: unbundled, opt-in only).
      updates_optin: body.updates_optin === true,
      // Matching profile may be supplied at signup or filled in later via the
      // onboarding wizard / /account (see profile()).
      ...matchProfileFields(body),
    });
  },

  /** Profile update (PATCH /api/me/profile) — all matching fields, all optional. */
  profile(body = {}) {
    return pass(matchProfileFields(body));
  },

  /**
   * The "dream" fields (Dream Plan) — kept SEPARATE from the matching profile
   * so a profile save can't wipe them and vice versa. All optional.
   *   target_intake      controlled "<Season> <Year>" string (or empty)
   *   career_goal        free text, capped + escaped on display
   *   scholarship_required boolean
   */
  dream(body = {}) {
    const intakeRaw = str(body.target_intake);
    const target_intake = /^(Fall|Spring|Summer|Winter) \d{4}$/.test(intakeRaw)
      ? intakeRaw
      : "";
    return pass({
      target_intake,
      career_goal: str(body.career_goal).slice(0, 120),
      scholarship_required: body.scholarship_required === true,
    });
  },

  login(body = {}) {
    const email = str(body.email).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (
      !email ||
      !password ||
      email.length > MAX.email ||
      password.length > MAX.password
    ) {
      return fail("Email and password are required.");
    }
    return pass({ email, password });
  },

  forgotPassword(body = {}) {
    const email = str(body.email).toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > MAX.email)
      return fail("A valid email address is required.");
    return pass({ email });
  },

  // Raw tokens are 32 random bytes as hex — always exactly 64 lowercase hex
  // chars. Reject anything else before it ever reaches a hash comparison.
  token(body = {}) {
    const token = str(body.token);
    if (!/^[0-9a-f]{64}$/.test(token)) return fail("Invalid or expired link.");
    return pass({ token });
  },

  changeEmail(body = {}) {
    const new_email = str(body.new_email).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!EMAIL_RE.test(new_email) || new_email.length > MAX.email)
      return fail("A valid new email address is required.");
    if (!password)
      return fail("Your current password is required to change your email.");
    return pass({ new_email, password });
  },

  resetPassword(body = {}) {
    const tokenResult = validate.token(body);
    if (!tokenResult.ok) return tokenResult;
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8)
      return fail("Password must be at least 8 characters.");
    if (password.length > MAX.password) return fail("Password is too long.");
    return pass({ token: tokenResult.value.token, password });
  },

  // University pilot-interest lead (landing-page contact form) — a
  // sales-qualified lead form, not a self-serve signup, so it asks for more
  // than an email.
  pilotLead(body = {}) {
    const contact_name = str(body.contact_name);
    const work_email = str(body.work_email).toLowerCase();
    const university_name = str(body.university_name);
    const country = str(body.country).slice(0, MAX.country);
    const message = str(body.message).slice(0, MAX.message);

    if (!contact_name) return fail("Your name is required.");
    if (contact_name.length > MAX.name) return fail("Name is too long.");
    if (!EMAIL_RE.test(work_email) || work_email.length > MAX.email)
      return fail("A valid work email is required.");
    if (!university_name) return fail("University name is required.");
    if (university_name.length > MAX.org)
      return fail("University name is too long.");

    return pass({
      contact_name,
      work_email,
      university_name,
      country,
      message,
    });
  },

  /**
   * Honeypot check for public, unauthenticated lead forms. `company_website`
   * is a field real visitors never see (positioned off-screen client-side) or
   * fill in; a simple form-filling bot that grabs every input on the page will
   * populate it. No CAPTCHA vendor, no extra dependency — matches this app's
   * preference for dependency-free defenses (see lib/rate-limit.js). Callers
   * should respond as if the submission succeeded (never reveal the trap was
   * tripped) but skip persisting it.
   */
  isBotSubmission(body = {}) {
    return str(body.company_website).length > 0;
  },
};

module.exports = validate;
