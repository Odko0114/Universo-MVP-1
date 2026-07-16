'use strict';

/**
 * Small, dependency-free input validation. Returns a `{ ok, value|error }`
 * result so callers stay explicit and we never trust request bodies. Caps every
 * string length so a hostile client can't store megabytes per field.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX = { name: 120, email: 254, password: 200, field: 120, country: 80 };

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
};

module.exports = validate;
