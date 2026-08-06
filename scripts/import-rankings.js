"use strict";

/**
 * Imports university rankings from the openly-licensed CWUR dataset (world rank
 * + national rank) and writes data/seed/rankings.json keyed by normalised name.
 *
 * Source: https://github.com/arnaudbenard/university-ranking (CWUR, CC data)
 *
 * Coverage note: rankings only exist for the top ~1,000–2,000 universities
 * worldwide. Everyone else is genuinely unranked — we do NOT fabricate a number.
 * National rank is CWUR's own within-country rank (i.e. rank among ranked peers).
 */

const fs = require("fs");
const path = require("path");
const manifest = require("../lib/manifest");

const SOURCE =
  process.env.RANKINGS_URL ||
  "https://raw.githubusercontent.com/arnaudbenard/university-ranking/master/cwurData.csv";

// Normalised institution name for joining to our dataset (accents/punct/case).
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Minimal CSV line splitter that respects double-quoted fields.
function splitCsv(line) {
  const out = [];
  let cur = "",
    q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function run() {
  console.log("[import-rankings] Fetching CWUR rankings…");
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Source returned ${res.status}`);
  const text = await res.text();

  const lines = text.trim().split("\n");
  const header = splitCsv(lines[0]);
  const col = (name) => header.indexOf(name);
  const iName = col("institution"),
    iWorld = col("world_rank"),
    iNat = col("national_rank"),
    iCountry = col("country"),
    iYear = col("year");

  // Keep the most recent row per institution (maximises coverage + freshness).
  const byName = new Map();
  for (let i = 1; i < lines.length; i++) {
    const r = splitCsv(lines[i]);
    if (r.length < header.length) continue;
    const key = normName(r[iName]);
    if (!key) continue;
    const year = Number(r[iYear]) || 0;
    const prev = byName.get(key);
    if (!prev || year >= prev.year) {
      byName.set(key, {
        world_rank: Number(r[iWorld]) || null,
        national_rank: Number(r[iNat]) || null,
        country: r[iCountry],
        year,
        name: r[iName],
      });
    }
  }

  const out = {};
  for (const [key, v] of byName)
    out[key] = {
      world_rank: v.world_rank,
      national_rank: v.national_rank,
      country: v.country,
      year: v.year,
    };

  const records = Object.values(out);
  manifest.assertQuality(records, {
    source: "rankings",
    minCount: 800,
    requireField: "world_rank",
  });

  const target = path.join(__dirname, "..", "data", "seed", "rankings.json");
  fs.writeFileSync(target, JSON.stringify(out, null, 2));
  manifest.write("rankings", records, { source_url: SOURCE, provider: "CWUR" });

  console.log(
    `[import-rankings] Wrote ${records.length} ranked institutions to ${path.relative(process.cwd(), target)}`,
  );
  console.log(
    `[import-rankings]   countries: ${new Set(records.map((r) => r.country)).size}`,
  );
}

run().catch((e) => {
  console.error("[import-rankings] FAILED:", e.message);
  process.exit(1);
});
