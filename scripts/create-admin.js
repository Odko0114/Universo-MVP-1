'use strict';

/**
 * Create or update an admin account for the /admin dashboard.
 *
 * Usage:
 *   node scripts/create-admin.js you@example.com
 *   npm run create-admin -- you@example.com
 *
 * The password is read interactively from stdin with echo suppressed, so it
 * never lands in shell history or `ps` output. (A second positional argument
 * is still accepted for non-interactive automation, with a warning — prefer
 * the prompt.)
 *
 * Safe to re-run: an existing email gets its password updated (upsert).
 */

const readline = require('readline');
const store = require('../lib/store');
const adminAuth = require('../lib/admin-auth');

/**
 * One shared readline interface for both prompts (a fresh interface per
 * prompt loses buffered piped input), with echo suppressed while a password
 * is being typed via readline's _writeToOutput hook.
 */
function makeHiddenPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let muted = false;
  const anyRl = /** @type {any} */ (rl);
  const orig = anyRl._writeToOutput.bind(rl);
  anyRl._writeToOutput = (s) => { if (!muted) orig(s); };

  // Buffer every line as it arrives instead of using rl.question(): with piped
  // stdin, a line that lands between two question() calls has no listener yet
  // and is silently dropped — a queue can't lose it.
  const pending = [];
  const waiters = [];
  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w(line); else pending.push(line);
  });

  return {
    ask(question) {
      process.stdout.write(question);
      muted = true;
      return new Promise((resolve) => {
        const take = (line) => { muted = false; process.stdout.write('\n'); resolve(line); };
        if (pending.length) take(pending.shift());
        else waiters.push(take);
      });
    },
    close() { rl.close(); },
  };
}

async function run() {
  const [email, passwordArg] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: node scripts/create-admin.js <email>   (you will be prompted for the password)');
    process.exit(1);
  }

  let password = passwordArg;
  if (password) {
    console.warn('[create-admin] WARNING: passing the password as an argument leaves it in shell history — prefer running with just the email and typing it at the prompt.');
  } else {
    const prompter = makeHiddenPrompter();
    password = await prompter.ask('Password (min 10 chars, input hidden): ');
    const confirm = await prompter.ask('Confirm password: ');
    prompter.close();
    if (password !== confirm) {
      console.error('[create-admin] FAILED: passwords do not match.');
      process.exit(1);
    }
  }

  store.init('admins', []);
  try {
    const normalized = await adminAuth.createAdmin(email, password);
    console.log(`[create-admin] Admin account ready: ${normalized}`);
    console.log('[create-admin] Log in at /admin with this email and password.');
  } catch (e) {
    console.error('[create-admin] FAILED:', e.message);
    process.exit(1);
  }
}

run();
