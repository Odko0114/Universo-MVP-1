'use strict';

/**
 * Country-name canonicalisation + the EU member-state list.
 *
 * The three data sources spell some countries differently (ETER uses ISO
 * short names, the global Hipolabs list uses long-form UN names), which
 * silently split a single country into two filter buckets — e.g. "Czechia"
 * (56 records) vs. "Czech Republic" (10 records), or "Vietnam" vs. "Viet Nam".
 * That's a real correctness bug: a country filter or an EU-membership check
 * against only one spelling would silently miss records. This module fixes it
 * once, at dataset-build time, so every downstream consumer (search, filters,
 * admin stats, the EU niche filter) sees one clean name per country.
 */

// alias (as it appears in a source) -> canonical display name
const CANONICAL_COUNTRY = {
  'Czech Republic': 'Czechia',
  'Turkiye': 'Türkiye',
  'Viet Nam': 'Vietnam',
  'Korea, Republic of': 'South Korea',
  "Korea, Democratic People's Republic of": 'North Korea',
  'Russian Federation': 'Russia',
  'Moldova, Republic of': 'Moldova',
  'Bolivia, Plurinational State of': 'Bolivia',
  'Venezuela, Bolivarian Republic of': 'Venezuela',
  'Tanzania, United Republic of': 'Tanzania',
  "Lao People's Democratic Republic": 'Laos',
  'Syrian Arab Republic': 'Syria',
  'Congo, the Democratic Republic of the': 'DR Congo',
  'Palestine, State of': 'Palestine',
  'Brunei Darussalam': 'Brunei',
  'Taiwan, Province of China': 'Taiwan',
  'Holy See (Vatican City State)': 'Vatican City',
  'Virgin Islands, British': 'British Virgin Islands',
};

function canonicalCountry(name) {
  return CANONICAL_COUNTRY[name] || name;
}

// The 27 EU member states, in their canonical spelling per the map above.
// Deliberately EU membership only (not the wider EEA) — Norway, Iceland,
// Liechtenstein and Switzerland are excluded even though ETER covers them,
// matching what was actually asked for.
const EU_COUNTRIES = new Set([
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark',
  'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Ireland',
  'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands',
  'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden',
]);

const isEU = (country) => EU_COUNTRIES.has(country);

// The platform's current data scope: EU + EEA (Norway, Iceland, Liechtenstein)
// + UK + Switzerland. Records outside this set are dropped at dataset-build
// time (see lib/dataset.js) — the product is Europe-only today. Every kept
// record is stamped region:'europe' so a future global expansion is a filter
// change plus a new region value, not a schema migration.
const EUROPEAN_SCOPE = new Set([
  ...EU_COUNTRIES,
  'Norway', 'Iceland', 'Liechtenstein', 'United Kingdom', 'Switzerland',
]);

const isEuropeanScope = (country) => EUROPEAN_SCOPE.has(country);

module.exports = { CANONICAL_COUNTRY, canonicalCountry, EU_COUNTRIES, isEU, EUROPEAN_SCOPE, isEuropeanScope };
