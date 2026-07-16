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
