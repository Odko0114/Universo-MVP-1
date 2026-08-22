"use strict";

/**
 * Country-level ESTIMATES for fields that don't exist per-university at global
 * scale: typical international tuition (EUR/year), living cost (EUR/month), and
 * primary language(s) of instruction. These are ballpark figures by country —
 * NOT verified per-institution facts — so every value we fill this way is tagged
 * `estimated: true` and the UI labels it and shows a "verify" note.
 *
 * Figures are rounded, best-effort public knowledge and will drift; treat as
 * orientation only. Countries not listed fall back to a regional/default band.
 */

// [tuitionMin, tuitionMax] EUR/yr (intl), [livingMin, livingMax] EUR/mo, [languages]
const C = {
  "United States": [20000, 55000, 1200, 2200, ["English"]],
  "United Kingdom": [15000, 38000, 1100, 1900, ["English"]],
  Canada: [14000, 35000, 900, 1600, ["English", "French"]],
  Australia: [18000, 40000, 1200, 2000, ["English"]],
  "New Zealand": [16000, 30000, 1000, 1700, ["English"]],
  Ireland: [10000, 45000, 1100, 1800, ["English"]],
  Germany: [0, 3000, 900, 1400, ["German", "English"]],
  France: [2770, 13000, 850, 1500, ["French", "English"]],
  Netherlands: [8000, 16000, 900, 1400, ["English", "Dutch"]],
  Belgium: [1000, 6000, 850, 1300, ["Dutch", "French", "English"]],
  Spain: [1500, 12000, 900, 1400, ["Spanish", "English"]],
  Italy: [900, 5000, 800, 1300, ["Italian", "English"]],
  Portugal: [1000, 8000, 700, 1200, ["Portuguese", "English"]],
  Switzerland: [1000, 4000, 1500, 2500, ["German", "French", "English"]],
  Austria: [0, 1500, 950, 1450, ["German", "English"]],
  Sweden: [0, 16000, 900, 1400, ["Swedish", "English"]],
  Norway: [0, 12000, 1100, 1700, ["Norwegian", "English"]],
  Denmark: [0, 16000, 1000, 1500, ["Danish", "English"]],
  Finland: [0, 18000, 900, 1400, ["Finnish", "English"]],
  Poland: [2000, 8000, 500, 1000, ["Polish", "English"]],
  Czechia: [0, 8000, 600, 1100, ["Czech", "English"]],
  Hungary: [1500, 8000, 500, 1000, ["Hungarian", "English"]],
  Greece: [1500, 9000, 600, 1100, ["Greek", "English"]],
  Romania: [2000, 6000, 400, 900, ["Romanian", "English"]],
  Estonia: [1000, 7500, 600, 1000, ["Estonian", "English"]],
  Türkiye: [500, 12000, 400, 900, ["Turkish", "English"]],
  Russia: [2000, 8000, 400, 900, ["Russian", "English"]],
  Ukraine: [1500, 5000, 350, 700, ["Ukrainian", "English"]],
  China: [3000, 10000, 500, 1200, ["Chinese", "English"]],
  Japan: [4000, 12000, 900, 1500, ["Japanese", "English"]],
  "South Korea": [4000, 11000, 700, 1300, ["Korean", "English"]],
  India: [1000, 8000, 250, 700, ["English", "Hindi"]],
  Singapore: [12000, 30000, 1200, 2000, ["English"]],
  Malaysia: [3000, 10000, 500, 1000, ["Malay", "English"]],
  Indonesia: [2000, 7000, 350, 800, ["Indonesian", "English"]],
  Thailand: [2000, 8000, 400, 900, ["Thai", "English"]],
  "Hong Kong": [12000, 30000, 1300, 2200, ["English", "Chinese"]],
  Taiwan: [3000, 9000, 600, 1100, ["Chinese", "English"]],
  Pakistan: [800, 5000, 200, 600, ["English", "Urdu"]],
  Bangladesh: [800, 4000, 200, 500, ["Bengali", "English"]],
  "United Arab Emirates": [8000, 25000, 900, 1800, ["English", "Arabic"]],
  "Saudi Arabia": [0, 15000, 700, 1400, ["Arabic", "English"]],
  Israel: [8000, 20000, 1000, 1700, ["Hebrew", "English"]],
  Egypt: [1000, 8000, 300, 700, ["Arabic", "English"]],
  "South Africa": [2000, 8000, 500, 1000, ["English", "Afrikaans"]],
  Nigeria: [500, 6000, 250, 600, ["English"]],
  Kenya: [1000, 6000, 300, 700, ["English", "Swahili"]],
  Ghana: [1000, 6000, 300, 600, ["English"]],
  Brazil: [0, 12000, 500, 1000, ["Portuguese"]],
  Mexico: [3000, 15000, 500, 1000, ["Spanish"]],
  Argentina: [0, 6000, 400, 800, ["Spanish"]],
  Chile: [3000, 12000, 600, 1100, ["Spanish"]],
  Colombia: [2000, 9000, 400, 800, ["Spanish"]],
  Mongolia: [1000, 4000, 300, 700, ["Mongolian", "English"]],
  // EU/EEA countries whose universities were falling through to the regional
  // default (which has no language) — leaving language blank on ~340 records.
  // Best-effort country-level figures; language is the national language plus
  // English where English-taught programmes are common. Flagged as estimates.
  Bulgaria: [1500, 8000, 400, 800, ["Bulgarian", "English"]],
  Slovakia: [0, 5000, 500, 900, ["Slovak", "English"]],
  Slovenia: [0, 12000, 600, 1000, ["Slovenian", "English"]],
  Iceland: [0, 5000, 1000, 1600, ["Icelandic", "English"]],
  Latvia: [2000, 11000, 500, 900, ["Latvian", "English"]],
  Cyprus: [3500, 12500, 700, 1200, ["Greek", "English"]],
  Croatia: [1000, 8000, 500, 900, ["Croatian", "English"]],
  Lithuania: [1500, 12000, 500, 900, ["Lithuanian", "English"]],
  Malta: [1000, 12000, 700, 1200, ["English", "Maltese"]],
  Luxembourg: [400, 800, 1100, 1800, ["French", "German", "English"]],
  Liechtenstein: [0, 1200, 1200, 1900, ["German", "English"]],
};

// Regional defaults for countries not individually listed.
const DEFAULT = [1000, 10000, 500, 1200, []];

/**
 * Return the estimate band for a country name, or a sensible default.
 * @returns {{ tuition:[number,number], living:[number,number], languages:string[] }}
 */
function forCountry(country) {
  const e = C[country] || DEFAULT;
  return { tuition: [e[0], e[1]], living: [e[2], e[3]], languages: e[4] };
}

/**
 * Fill missing tuition / living-cost / language on a university from its
 * country estimate. Real values (curated/ETER) are never overwritten. Returns
 * the same object (mutated) for convenience.
 */
function enrich(u) {
  const est = forCountry(u.country);
  if (!u.tuition_range) {
    u.tuition_range = {
      min: est.tuition[0],
      max: est.tuition[1],
      currency: "EUR",
      period: "year",
      estimated: true,
    };
  }
  if (!u.estimated_living_cost) {
    u.estimated_living_cost = {
      min: est.living[0],
      max: est.living[1],
      currency: "EUR",
      period: "month",
      estimated: true,
    };
  }
  if (
    !(u.language_of_instruction && u.language_of_instruction.length) &&
    est.languages.length
  ) {
    u.language_of_instruction = est.languages;
    u.language_estimated = true;
  }
  return u;
}

module.exports = { forCountry, enrich, COUNTRIES: C };
