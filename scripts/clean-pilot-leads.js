#!/usr/bin/env node
"use strict";

// Remove synthetic/test pilot-lead submissions from pilot_leads.json while
// keeping genuine leads. Backs up the file before writing.
//
// Local:            node scripts/clean-pilot-leads.js --dry   (preview)
//                   node scripts/clean-pilot-leads.js         (apply)
// On the server:    set UNIVERSO_DATA_DIR to the live data dir first, so it
//                   cleans production's file on the persistent disk, e.g.
//                   UNIVERSO_DATA_DIR=/var/data node scripts/clean-pilot-leads.js --dry
//
// A "test" lead is one that looks generated, never a real university enquiry:
// an example.edu / test / mailinator address, a pilot_<timestamp>@ address, or
// a "Test University" / placeholder name.

const fs = require("fs");
const path = require("path");

const DIR = process.env.UNIVERSO_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DIR, "pilot_leads.json");
const dry = process.argv.includes("--dry");

const domain = (e) => (String(e || "").split("@")[1] || "").toLowerCase();
const isTest = (r) => {
  const d = domain(r.work_email);
  const u = String(r.university_name || "").toLowerCase();
  const n = String(r.contact_name || "").toLowerCase();
  return (
    /example\.(edu|com|org)|mailinator|\.test$/.test(d) ||
    /^pilot_\d+@/.test(String(r.work_email || "")) ||
    /test university|test uni|\bexample\b|\basdf\b|\bdemo\b/.test(u) ||
    /\btest\b|asdf|qwerty/.test(n)
  );
};

if (!fs.existsSync(FILE)) {
  console.log("No pilot_leads.json at", FILE);
  process.exit(0);
}

const all = JSON.parse(fs.readFileSync(FILE, "utf8"));
const kept = all.filter((r) => !isTest(r));
const removed = all.length - kept.length;

console.log(FILE);
console.log(`  total ${all.length} · test ${removed} · keep ${kept.length}`);

if (dry) {
  console.log("  (dry run — nothing written; drop --dry to apply)");
  process.exit(0);
}
if (removed === 0) {
  console.log("  nothing to remove.");
  process.exit(0);
}

const backup = `${FILE}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, JSON.stringify(kept, null, 2) + "\n");
console.log(`  removed ${removed}. backup: ${path.basename(backup)}`);
