'use strict';

/**
 * Create or update an admin account for the /admin dashboard.
 *
 * Usage:
 *   node scripts/create-admin.js you@example.com "a strong password"
 *   npm run create-admin -- you@example.com "a strong password"
 *
 * Safe to re-run: an existing email gets its password updated (upsert).
 */

const store = require('../lib/store');
const adminAuth = require('../lib/admin-auth');

async function run() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.js <email> <password>');
    process.exit(1);
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
