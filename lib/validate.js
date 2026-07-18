'use strict';

/**
 * Small, dependency-free input validation. Returns a `{ ok, value|error }`
 * result so callers stay explicit and we never trust request bodies. Caps every
 * string length so a hostile client can't store megabytes per field.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX = { name: 120, email: 254, password: 200, field: 120, country: 80, org: 160, message: 1000 };

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function fail(error) { return { ok: false, error }; }
function pass(value) { return { ok: true, value }; }

const validate = {
  MAX,

  registration(body = {}) {
    const full_name = str(body.full_name);
    const email = str(body.email).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    if (!full_name) return fail('Full name is required.');
    if (full_name.length > MAX.name) return fail('Full name is too long.');
    if (!EMAIL_RE.test(email) || email.length > MAX.email) return fail('A valid email address is required.');
    if (password.length < 8) return fail('Password must be at least 8 characters.');
    if (password.length > MAX.password) return fail('Password is too long.');
    if (body.consent !== true) return fail('You must accept the privacy policy to create an account.');

    return pass({
      full_name,
      email,
      password,
      country_of_origin: str(body.country_of_origin).slice(0, MAX.country),
      field_of_interest: str(body.field_of_interest).slice(0, MAX.field),
      target_degree_level: str(body.target_degree_level).slice(0, 40),
    });
  },

  login(body = {}) {
    const email = str(body.email).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || email.length > MAX.email || password.length > MAX.password) {
      return fail('Email and password are required.');
    }
    return pass({ email, password });
  },

  // Student waitlist (the /join page) — deliberately just an email, per the
  // "keep friction low" brief for that CTA.
  waitlist(body = {}) {
    const email = str(body.email).toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > MAX.email) return fail('A valid email address is required.');
    return pass({ email });
  },

  // University pilot-interest lead (the /join page) — this is a sales-qualified
  // lead form, not a self-serve signup, so it asks for more than an email.
  pilotLead(body = {}) {
    const contact_name = str(body.contact_name);
    const work_email = str(body.work_email).toLowerCase();
    const university_name = str(body.university_name);
    const country = str(body.country).slice(0, MAX.country);
    const message = str(body.message).slice(0, MAX.message);

    if (!contact_name) return fail('Your name is required.');
    if (contact_name.length > MAX.name) return fail('Name is too long.');
    if (!EMAIL_RE.test(work_email) || work_email.length > MAX.email) return fail('A valid work email is required.');
    if (!university_name) return fail('University name is required.');
    if (university_name.length > MAX.org) return fail('University name is too long.');

    return pass({ contact_name, work_email, university_name, country, message });
  },

  /**
   * Honeypot check for the /join page's two public, unauthenticated lead
   * forms. `company_website` is a field real visitors never see (positioned
   * off-screen client-side) or fill in; a simple form-filling bot that grabs
   * every input on the page will populate it. No CAPTCHA vendor, no extra
   * dependency — matches this app's preference for dependency-free defenses
   * (see lib/rate-limit.js). Callers should respond as if the submission
   * succeeded (never reveal the trap was tripped) but skip persisting it.
   */
  isBotSubmission(body = {}) {
    return str(body.company_website).length > 0;
  },
};

module.exports = validate;
