'use strict';

/**
 * Tiny structured logger. Emits one JSON object per line (easy to ship to a log
 * aggregator later) and never logs PII. Swap the `sink` for Sentry/Datadog/etc.
 * at the boundary in `captureError` without touching call sites.
 *
 * Levels: debug < info < warn < error. Set LOG_LEVEL to raise the floor.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const FLOOR = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

// Error-monitoring seam. Off unless a Sentry-compatible DSN is configured, so
// there's no dependency, account, or cost until you want it — set SENTRY_DSN
// (or UNIVERSO_ERROR_DSN) in the environment and captured errors POST to
// Sentry's store endpoint. Dormant otherwise; structured stderr logs as today.
const ERROR_DSN = process.env.SENTRY_DSN || process.env.UNIVERSO_ERROR_DSN || '';
let sentry = null; // { url, publicKey } parsed once
if (ERROR_DSN) {
  try {
    const u = new URL(ERROR_DSN);
    const projectId = u.pathname.replace(/^\//, '');
    sentry = { url: `${u.protocol}//${u.host}/api/${projectId}/store/`, publicKey: u.username };
  } catch { /* malformed DSN — stay dormant */ }
}

function reportToSentry(err, context) {
  if (!sentry || typeof fetch !== 'function') return;
  const body = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    platform: 'node',
    message: err && err.message ? err.message : 'error',
    exception: { values: [{ type: err && err.name, value: err && err.message, stacktrace: { frames: [] } }] },
    extra: context || {},
  });
  // Fire-and-forget: monitoring must never block or crash a request path.
  fetch(sentry.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${sentry.publicKey}, sentry_client=universo/1.0`,
    },
    body,
  }).catch(() => {});
}

function emit(level, msg, fields) {
  if (LEVELS[level] < FLOOR) return;
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),

  /**
   * Central error sink — the one place to wire an error-monitoring service.
   * @param {Error} err
   * @param {object} [context]
   */
  captureError(err, context) {
    emit('error', err && err.message ? err.message : 'error', {
      ...context,
      stack: err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : undefined,
    });
    reportToSentry(err, context); // no-op unless a DSN is configured
  },

  /** True when an error-monitoring DSN is configured (for a boot-time log line). */
  errorMonitoringEnabled: !!sentry,
};

module.exports = log;
