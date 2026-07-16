'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalCountry, isEU, EU_COUNTRIES } = require('../lib/countries');

test('canonicalCountry merges known spelling variants', () => {
  assert.equal(canonicalCountry('Czech Republic'), 'Czechia');
  assert.equal(canonicalCountry('Czechia'), 'Czechia');
  assert.equal(canonicalCountry('Viet Nam'), 'Vietnam');
  assert.equal(canonicalCountry('Turkiye'), 'Türkiye');
});

test('canonicalCountry passes through unknown names unchanged', () => {
  assert.equal(canonicalCountry('Germany'), 'Germany');
  assert.equal(canonicalCountry(''), '');
});

test('isEU recognises member states under their canonical spelling', () => {
  assert.equal(isEU('Germany'), true);
  assert.equal(isEU('Czechia'), true);
  assert.equal(isEU(canonicalCountry('Czech Republic')), true); // the whole point of normalizing first
});

test('isEU excludes EEA-but-not-EU and non-European countries', () => {
  assert.equal(isEU('Norway'), false);
  assert.equal(isEU('Switzerland'), false);
  assert.equal(isEU('United Kingdom'), false);
  assert.equal(isEU('United States'), false);
});

test('EU_COUNTRIES has exactly 27 members', () => {
  assert.equal(EU_COUNTRIES.size, 27);
});
