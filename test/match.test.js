'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreUniversity, recommend } = require('../lib/match');

const student = { target_degree_level: 'Master', field_of_interest: 'Computer Science' };

const strongFit = {
  id: 'a', name: 'Strong Fit University', country: 'Germany', source: 'curated',
  degree_levels: ['Master'], fields_of_study: ['Computer Science & IT'],
  language_of_instruction: ['English'], tuition_range: { min: 0, max: 0 },
};
const weakFit = {
  id: 'b', name: 'Weak Fit University', country: 'United States', source: 'global',
  degree_levels: ['Bachelor'], fields_of_study: ['Law'],
  language_of_instruction: ['English'], tuition_range: { min: 30000, max: 50000 },
};
const noData = {
  id: 'c', name: 'No Data University', country: 'Brazil', source: 'global',
  degree_levels: [], fields_of_study: [], language_of_instruction: [], tuition_range: null,
};

test('a strong EU/affordable/English/field/degree match scores far higher than a weak one', () => {
  const strong = scoreUniversity(student, strongFit);
  const weak = scoreUniversity(student, weakFit);
  assert.ok(strong.score > weak.score, `expected strong (${strong.score}) > weak (${weak.score})`);
});

test('wrong degree level scores zero on the degree factor (reflected in a lower total)', () => {
  const right = scoreUniversity(student, strongFit);
  const wrongDegree = scoreUniversity(student, { ...strongFit, degree_levels: ['Bachelor'] });
  assert.ok(right.score > wrongDegree.score);
});

test('missing data is scored neutrally, not penalized to zero', () => {
  const { score } = scoreUniversity(student, noData);
  assert.ok(score > 0 && score < 60, `expected a middling neutral score, got ${score}`);
});

test('reasons explain the match in plain language', () => {
  const { reasons } = scoreUniversity(student, strongFit);
  assert.ok(reasons.length > 0);
  assert.ok(reasons.some((r) => /Master/.test(r)));
});

test('recommend() sorts descending and respects the limit', () => {
  const results = recommend(student, [weakFit, strongFit, noData], { limit: 2 });
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'a'); // strongFit should win
  assert.ok(results[0].match_score >= results[1].match_score);
});

test('recommend() excludes already-saved universities', () => {
  const results = recommend(student, [strongFit, weakFit], { excludeIds: new Set(['a']) });
  assert.ok(!results.some((r) => r.id === 'a'));
});

test('an empty student profile still returns neutral, non-crashing scores', () => {
  const { score } = scoreUniversity({}, strongFit);
  assert.ok(score >= 0 && score <= 100);
});
