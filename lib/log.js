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
    // TODO(prod): Sentry.captureException(err, { extra: context });
  },
};

module.exports = log;
