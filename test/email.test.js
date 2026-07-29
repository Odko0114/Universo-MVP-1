'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const email = require('../lib/email');

test('email is dormant without RESEND_API_KEY (the test/dev default)', () => {
  assert.equal(email.ENABLED, false);
});

test('sendMail never attempts a network call while dormant', async () => {
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('fetch should not be called while email is dormant'); };
  try {
    const result = await email.sendMail({ to: 'x@example.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' });
    assert.equal(result.sent, false);
    assert.equal(result.dormant, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('verifyEmailTemplate includes the link, escapes the name, and expires-in-24h copy', () => {
  const t = email.verifyEmailTemplate({ name: '<script>alert(1)</script>', link: 'https://universo.app/verify-email?token=abc123' });
  assert.match(t.subject, /Verify/);
  assert.match(t.html, /https:\/\/universo\.app\/verify-email\?token=abc123/);
  assert.ok(!t.html.includes('<script>alert(1)</script>'), 'raw name must not appear unescaped');
  assert.match(t.html, /&lt;script&gt;/);
  assert.match(t.html, /24 hours/);
  assert.match(t.text, /verify-email\?token=abc123/);
});

test('passwordResetTemplate includes the link and expires-in-1-hour copy', () => {
  const t = email.passwordResetTemplate({ name: 'Ana', link: 'https://universo.app/reset-password?token=xyz789' });
  assert.match(t.subject, /Reset/);
  assert.match(t.html, /reset-password\?token=xyz789/);
  assert.match(t.html, /1 hour/);
});

test('emailVerifiedTemplate and welcomeTemplate render without a link and handle a missing name', () => {
  const verified = email.emailVerifiedTemplate({});
  assert.match(verified.html, /verified/i);
  assert.match(verified.html, /Hi there/);

  const welcome = email.welcomeTemplate({ name: 'Mira Alvarez' });
  assert.match(welcome.html, /Hi Mira/);
  assert.match(welcome.subject, /Welcome/);
});

test('all templates produce a non-empty plain-text alternative (deliverability)', () => {
  const templates = [
    email.verifyEmailTemplate({ name: 'A', link: 'https://x.test/v' }),
    email.emailVerifiedTemplate({ name: 'A' }),
    email.passwordResetTemplate({ name: 'A', link: 'https://x.test/r' }),
    email.welcomeTemplate({ name: 'A' }),
  ];
  for (const t of templates) {
    assert.ok(t.text && t.text.length > 10, `text alternative missing for "${t.subject}"`);
    assert.ok(t.subject && t.subject.length > 0);
    assert.match(t.html, /<!doctype html>/i);
  }
});
