'use strict';

/**
 * Transactional email service. Fully wired, OFF until a provider key is
 * present — the same dormant-seam pattern as lib/explain.js's LLM path and
 * lib/log.js's Sentry hook. With no key, every send*() call logs what would
 * have been sent and returns success, so the rest of the app (registration,
 * password reset) behaves identically whether or not email is actually live.
 * Flip it on by setting RESEND_API_KEY — no other code changes required.
 *
 * Provider: Resend, via a plain fetch call (no SDK) — consistent with how
 * every other outbound call in this app is made (lib/http.js). Swapping
 * providers later means changing sendMail()'s single fetch call, not the
 * templates or call sites.
 */

const log = require('./log');
const { esc } = require('./ssr');
const { fetchWithResilience } = require('./http');

const API_KEY = process.env.RESEND_API_KEY || '';
const ENABLED = !!API_KEY;
const FROM = process.env.UNIVERSO_EMAIL_FROM || 'Universo <onboarding@resend.dev>';

// ---- layout --------------------------------------------------------------
// Table-based layout (email-client-safe), inline styles, Universo's own
// navy/gold palette. A prefers-color-scheme block covers the handful of
// clients that honor it (Apple Mail, some mobile Gmail); everyone else just
// gets the light version, which is a safe, readable default either way.

function layout({ preheader = '', bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Universo</title>
<style>
  body { margin:0; padding:0; background:#F3F5F8; }
  @media (prefers-color-scheme: dark) {
    body { background:#0A0F19 !important; }
    .u-card { background:#111927 !important; }
    .u-text { color:#DCE2EC !important; }
    .u-muted { color:#9AA7BD !important; }
  }
</style>
</head>
<body>
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F8;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" class="u-card" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:10px;overflow:hidden;">
        <tr><td style="background:#0B1F3A;padding:22px 28px;">
          <span style="font-family:Georgia,serif;font-style:italic;font-weight:700;font-size:20px;color:#FFFFFF;">Universo</span>
          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:.06em;color:#E9B949;text-transform:uppercase;margin-top:2px;">Same Start. Equal Chance.</div>
        </td></tr>
        <tr><td class="u-text" style="padding:32px 28px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#131B2E;">
          ${bodyHtml}
        </td></tr>
        <tr><td class="u-muted" style="padding:18px 28px 26px;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#6B7690;border-top:1px solid #EEF1F6;">
          You're receiving this because you have a Universo account. Universo — university discovery for international students.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="background:#E9B949;border-radius:8px;">
    <a href="${esc(href)}" style="display:inline-block;padding:12px 26px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#0B1F3A;text-decoration:none;">${esc(label)}</a>
  </td></tr></table>`;
}

// ---- templates -------------------------------------------------------------
// Each returns { subject, html, text }. Plain-text alternative is required
// for deliverability (spam filters weigh HTML-only mail negatively) and for
// clients that don't render HTML.

function verifyEmailTemplate({ name, link }) {
  const first = esc((name || '').split(' ')[0] || 'there');
  return {
    subject: 'Verify your email — Universo',
    html: layout({
      preheader: 'One click to activate your Universo account.',
      bodyHtml: `
        <p style="margin:0 0 14px">Hi ${first},</p>
        <p style="margin:0 0 14px">Welcome to Universo. Click below to verify your email and activate your account.</p>
        ${button(link, 'Verify email')}
        <p style="margin:14px 0 0;font-size:13px;color:#6B7690">This link expires in 24 hours. If you didn't create a Universo account, you can ignore this email.</p>
      `,
    }),
    text: `Hi ${name || 'there'},\n\nVerify your Universo email: ${link}\n\nThis link expires in 24 hours. If you didn't create a Universo account, ignore this email.`,
  };
}

function emailVerifiedTemplate({ name }) {
  const first = esc((name || '').split(' ')[0] || 'there');
  return {
    subject: "You're verified — Universo",
    html: layout({
      preheader: 'Your email is confirmed.',
      bodyHtml: `
        <p style="margin:0 0 14px">Hi ${first},</p>
        <p style="margin:0 0 14px">Your email is verified — your Universo account is fully active.</p>
      `,
    }),
    text: `Hi ${name || 'there'},\n\nYour email is verified — your Universo account is fully active.`,
  };
}

function passwordResetTemplate({ name, link }) {
  const first = esc((name || '').split(' ')[0] || 'there');
  return {
    subject: 'Reset your password — Universo',
    html: layout({
      preheader: 'Reset your Universo password.',
      bodyHtml: `
        <p style="margin:0 0 14px">Hi ${first},</p>
        <p style="margin:0 0 14px">We got a request to reset your Universo password. Click below to choose a new one.</p>
        ${button(link, 'Reset password')}
        <p style="margin:14px 0 0;font-size:13px;color:#6B7690">This link expires in 1 hour. If you didn't request this, your password is still safe — you can ignore this email.</p>
      `,
    }),
    text: `Hi ${name || 'there'},\n\nReset your Universo password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  };
}

function welcomeTemplate({ name }) {
  const first = esc((name || '').split(' ')[0] || 'there');
  return {
    subject: 'Welcome to Universo',
    html: layout({
      preheader: 'Set up matching and start comparing universities.',
      bodyHtml: `
        <p style="margin:0 0 14px">Hi ${first},</p>
        <p style="margin:0 0 14px">You're in. A couple of things worth doing first:</p>
        <p style="margin:0 0 6px">— Set up your matching profile so results are ranked for you, not just alphabetical</p>
        <p style="margin:0 0 14px">— Save a shortlist as you compare universities</p>
        ${button(`${process.env.UNIVERSO_APP_URL || ''}/discover`, 'Start exploring')}
      `,
    }),
    text: `Hi ${name || 'there'},\n\nYou're in. Set up your matching profile so results are ranked for you, and save a shortlist as you compare universities.`,
  };
}

// ---- send primitive + public API -------------------------------------------

/** @param {{to:string, subject:string, html:string, text:string}} msg */
async function sendMail(msg) {
  if (!ENABLED) {
    log.info('email dormant (no RESEND_API_KEY) — not sent', { to: msg.to, subject: msg.subject });
    return { sent: false, dormant: true };
  }
  try {
    const res = await fetchWithResilience('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ from: FROM, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
      timeoutMs: 8000,
      retries: 1,
      label: 'resend',
    });
    if (!res.ok) throw new Error(`resend ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return { sent: true, id: data.id };
  } catch (e) {
    // Email failures must never break the request that triggered them
    // (registration, password reset all succeed regardless of mail delivery).
    log.captureError(e, { where: 'email', to: msg.to, subject: msg.subject });
    return { sent: false, error: e.message };
  }
}

const sendVerificationEmail = (student, link) => sendMail({ to: student.email, ...verifyEmailTemplate({ name: student.full_name, link }) });
const sendEmailVerifiedEmail = (student) => sendMail({ to: student.email, ...emailVerifiedTemplate({ name: student.full_name }) });
const sendPasswordResetEmail = (student, link) => sendMail({ to: student.email, ...passwordResetTemplate({ name: student.full_name, link }) });
const sendWelcomeEmail = (student) => sendMail({ to: student.email, ...welcomeTemplate({ name: student.full_name }) });

module.exports = {
  ENABLED,
  sendMail,
  sendVerificationEmail,
  sendEmailVerifiedEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
  // exported for template-level tests
  verifyEmailTemplate, emailVerifiedTemplate, passwordResetTemplate, welcomeTemplate,
};
