#!/usr/bin/env node
"use strict";

// One-time: geocode the cities of universities that have a real city but no
// coordinates, and write the results to data/seed/coords-overrides.json (a
// committed lookup keyed by "City|Country"). buildDataset() then applies these
// offline at every boot — no API call at runtime.
//
// City-level, so buildDataset marks the coords approx:true. Honest "which city
// the university is in", not a fabricated campus pin.
//
// Uses OpenStreetMap's Nominatim (free, 1 req/sec, requires a User-Agent).
//   node scripts/geocode-cities.js

const fs = require("fs");
const path = require("path");
const ds = require("./../lib/dataset");

const OUT = path.join(__dirname, "..", "data", "seed", "coords-overrides.json");
const UA = "Universo/0.1 (university discovery MVP; join.universo@gmail.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Skip junk city values (some source records carry "m" or other truncations —
// geocoding those returns arbitrary, WRONG coordinates).
const plausibleCity = (c) =>
  typeof c === "string" && c.trim().length >= 3 && /[a-zA-Z]{2,}/.test(c);

async function geocode(city, country) {
  const q = encodeURIComponent(`${city}, ${country}`);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.length) return null;
  return { lat: +(+j[0].lat).toFixed(5), lon: +(+j[0].lon).toFixed(5) };
}

(async () => {
  const list = ds.buildDataset();
  const need = new Map(); // "City|Country" -> {city, country}
  for (const u of list) {
    if ((u.coords && u.coords.lat != null) || !plausibleCity(u.city)) continue;
    need.set(`${u.city}|${u.country}`, { city: u.city, country: u.country });
  }
  const existing = fs.existsSync(OUT)
    ? JSON.parse(fs.readFileSync(OUT, "utf8"))
    : {};

  console.log(`${need.size} distinct cities to geocode.`);
  let ok = 0,
    fail = 0;
  for (const [key, { city, country }] of need) {
    if (existing[key]) {
      ok++;
      continue;
    } // resume-friendly
    try {
      const hit = await geocode(city, country);
      if (hit) {
        existing[key] = hit;
        ok++;
        console.log(`  ✓ ${key} -> ${hit.lat}, ${hit.lon}`);
      } else {
        fail++;
        console.log(`  · ${key} -> no result (left blank)`);
      }
    } catch (e) {
      fail++;
      console.log(`  ! ${key} -> ${e.message}`);
    }
    await sleep(1100); // Nominatim: max 1 req/sec
  }
  fs.writeFileSync(OUT, JSON.stringify(existing, null, 2) + "\n");
  console.log(`\nWrote ${Object.keys(existing).length} entries to ${path.relative(process.cwd(), OUT)} (ok ${ok}, blank/err ${fail}).`);
})();
