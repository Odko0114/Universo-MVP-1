"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const email = require("../lib/email");

test("email is dormant without RESEND_API_KEY (the test/dev default)", () => {
  assert.equal(email.ENABLED, false);
});

test("sendMail never attempts a network call while dormant", async () => {
  const originalFetch = global.fetch;
  global.fetch = () => {
    throw new Error("fetch should not be called while email is dormant");
  };
  try {
    const result = await email.sendMail({
      to: "x@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      text: "hi",
    });
    assert.equal(result.sent, false);
    assert.equal(result.dormant, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("verifyEmailTemplate includes the link, escapes the name, and expires-in-24h copy", () => {
  const t = email.verifyEmailTemplate({
    name: "<script>alert(1)</script>",
    link: "https://universo.app/verify-email?token=abc123",
  });
  assert.match(t.subject, /Verify/);
  assert.match(t.html, /https:\/\/universo\.app\/verify-email\?token=abc123/);
  assert.ok(
    !t.html.includes("<script>alert(1)</script>"),
    "raw name must not appear unescaped",
  );
  assert.match(t.html, /&lt;script&gt;/);
  assert.match(t.html, /24 hours/);
  assert.match(t.text, /verify-email\?token=abc123/);
});

test("passwordResetTemplate includes the link and expires-in-1-hour copy", () => {
  const t = email.passwordResetTemplate({
    name: "Ana",
    link: "https://universo.app/reset-password?token=xyz789",
  });
  assert.match(t.subject, /Reset/);
  assert.match(t.html, /reset-password\?token=xyz789/);
  assert.match(t.html, /1 hour/);
});

test("emailVerifiedTemplate and welcomeTemplate render without a link and handle a missing name", () => {
  const verified = email.emailVerifiedTemplate({});
  assert.match(verified.html, /verified/i);
  assert.match(verified.html, /Hi there/);

  const welcome = email.welcomeTemplate({ name: "Mira Alvarez" });
  assert.match(welcome.html, /Hi Mira/);
  assert.match(welcome.subject, /Welcome/);
});

test("all templates produce a non-empty plain-text alternative (deliverability)", () => {
  const templates = [
    email.verifyEmailTemplate({ name: "A", link: "https://x.test/v" }),
    email.emailVerifiedTemplate({ name: "A" }),
    email.passwordResetTemplate({ name: "A", link: "https://x.test/r" }),
    email.welcomeTemplate({ name: "A" }),
  ];
  for (const t of templates) {
    assert.ok(
      t.text && t.text.length > 10,
      `text alternative missing for "${t.subject}"`,
    );
    assert.ok(t.subject && t.subject.length > 0);
    assert.match(t.html, /<!doctype html>/i);
  }
});

test("layout uses the real mark + sans wordmark, not the old serif italic", () => {
  const t = email.welcomeTemplate({ name: "A" });
  assert.ok(
    !/font-style:italic;font-weight:700;font-size:20px;color:#FFFFFF/.test(t.html),
    "old serif-italic wordmark is gone",
  );
  assert.match(t.html, /viewBox="0 0 200 200"/, "the shared mark SVG is present");
});

test("weeklyDigestTemplate: built from real state, includes tasks/deadlines + unsubscribe", () => {
  const t = email.weeklyDigestTemplate({
    name: "Bat",
    origin: "https://universo.app",
    actionPlan: [{ label: "Finish Helsinki motivation letter", detail: "due in 3 days" }],
    agenda: [{ label: "Helsinki — application deadline", days_left: 3 }],
    funding: { annual_max: 25200, gap: 10200 },
    unsubscribeUrl: "https://universo.app/unsubscribe?token=s1.abc",
  });
  assert.match(t.subject, /Universo week/);
  assert.match(t.html, /Finish Helsinki motivation letter/);
  assert.match(t.html, /due in 3 days/);
  assert.match(t.html, /universo\.app\/journey/);
  assert.match(t.html, /unsubscribe\?token=s1\.abc/);
  assert.match(t.html, /over your budget/, "funding gap surfaces only as real");
  assert.match(t.text, /Finish Helsinki/);
});

test("deadlineReminderTemplate: factual urgency + missing docs, deep-links to the app", () => {
  const t = email.deadlineReminderTemplate({
    name: "Bat",
    origin: "https://universo.app",
    application: { uni_id: "tum", name: "Helsinki", days_left: 3, missing_required: ["Diploma", "CV"] },
    unsubscribeUrl: "https://universo.app/unsubscribe?token=s1.abc",
  });
  assert.match(t.subject, /due in 3 days/);
  assert.match(t.html, /2 required documents still incomplete: Diploma, CV/);
  assert.match(t.html, /journey#app-tum/);
  assert.ok(!/LAST CHANCE|hurry|don't miss/i.test(t.html), "no manufactured urgency");
});
