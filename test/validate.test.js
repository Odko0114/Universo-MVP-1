'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const validate = require('../lib/validate');

test('registration rejects missing consent', () => {
  const r = validate.registration({ full_name: 'A B', email: 'a@b.com', password: 'password1', consent: false });
  assert.equal(r.ok, false);
});

test('registration rejects short passwords', () => {
  const r = validate.registration({ full_name: 'A B', email: 'a@b.com', password: 'short', consent: true });
  assert.equal(r.ok, false);
});

test('registration rejects invalid email', () => {
  const r = validate.registration({ full_name: 'A B', email: 'nope', password: 'password1', consent: true });
  assert.equal(r.ok, false);
});

test('registration caps overly long fields', () => {
  const r = validate.registration({ full_name: 'A B', email: 'a@b.com', password: 'password1', consent: true, field_of_interest: 'x'.repeat(1000) });
  assert.equal(r.ok, true);
  assert.ok(r.value.field_of_interest.length <= validate.MAX.field);
});

test('registration normalizes email to lowercase', () => {
  const r = validate.registration({ full_name: 'A B', email: 'A@B.CoM', password: 'password1', consent: true });
  assert.equal(r.value.email, 'a@b.com');
});

test('login requires both fields', () => {
  assert.equal(validate.login({ email: 'a@b.com' }).ok, false);
  assert.equal(validate.login({ email: 'a@b.com', password: 'x' }).ok, true);
});

test('waitlist rejects an invalid email', () => {
  assert.equal(validate.waitlist({ email: 'nope' }).ok, false);
});

test('waitlist normalizes email to lowercase', () => {
  const r = validate.waitlist({ email: 'A@B.CoM' });
  assert.equal(r.ok, true);
  assert.equal(r.value.email, 'a@b.com');
});

test('pilotLead requires name, work email and university name', () => {
  assert.equal(validate.pilotLead({}).ok, false);
  assert.equal(validate.pilotLead({ contact_name: 'A B' }).ok, false);
  assert.equal(validate.pilotLead({ contact_name: 'A B', work_email: 'a@b.com' }).ok, false);
});

test('pilotLead accepts a minimal valid submission and caps the optional message', () => {
  const r = validate.pilotLead({
    contact_name: 'A B', work_email: 'a@b.com', university_name: 'Test U', message: 'x'.repeat(2000),
  });
  assert.equal(r.ok, true);
  assert.ok(r.value.message.length <= validate.MAX.message);
});

test('isBotSubmission flags a filled honeypot field', () => {
  assert.equal(validate.isBotSubmission({ email: 'a@b.com' }), false);
  assert.equal(validate.isBotSubmission({ email: 'a@b.com', company_website: 'http://spam.example' }), true);
});
