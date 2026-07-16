'use strict';

/**
 * "Recommended for you" matching engine.
 *
 * This is a transparent, weighted scoring algorithm over the student's profile
 * (target degree, field of interest) and the platform's chosen niche (EU
 * member states, English-taught options, affordable tuition) — NOT a live
 * generative-AI call. That's a deliberate choice: a per-request call to an LLM
 * would need a paid API key, add real latency and cost per search, and (worse)
 * produce non-deterministic, unauditable rankings — a bad fit for something
 * students make five-figure decisions from. A scoring function is instant,
 * free, fully explainable (every point is traceable to a `reasons` string),
 * and easy to unit-test — the same content-based-filtering approach real
 * recommender systems use before reaching for anything generative.
 */

const { isEU } = require('./countries');

const WEIGHTS = { degree: 20, field: 25, eu: 10, english: 10, afford: 20, richness: 15 };

const FIELD_KEYWORDS = {
  // Free-text student input -> taxonomy tokens to look for in fields_of_study /
  // programs_offered. Keeps matching forgiving without needing an LLM to
  // interpret "comp sci" vs "Computer Science & IT".
  'computer science': ['computer', 'informatics', 'software', 'data', 'it'],
  'data science': ['data', 'computer', 'statistics', 'analytics'],
  business: ['business', 'management', 'economics', 'finance', 'administration'],
  economics: ['economics', 'business', 'finance'],
  engineering: ['engineering', 'technology', 'technical'],
  medicine: ['medic', 'health', 'clinical'],
  law: ['law', 'legal'],
  psychology: ['psycholog', 'social', 'cognitive'],
  biology: ['biolog', 'life science', 'science'],
  design: ['design', 'art', 'architecture'],
  education: ['education', 'teacher', 'pedagog'],
};

function tokenize(freeText) {
  const t = String(freeText || '').toLowerCase().trim();
  if (!t) return [];
  for (const [key, tokens] of Object.entries(FIELD_KEYWORDS)) {
    if (t.includes(key)) return tokens;
  }
  // No known mapping — fall back to the raw words themselves (still useful for
  // an exact-ish match against fields_of_study/programs_offered text).
  return t.split(/[\s,/]+/).filter((w) => w.length > 2);
}

function fieldScore(student, u) {
  const tokens = tokenize(student.field_of_interest);
  if (!tokens.length) return { pts: WEIGHTS.field * 0.4, reason: null }; // no stated interest — neutral
  const hay = [...(u.fields_of_study || []), ...(u.programs_offered || [])].join(' ').toLowerCase();
  if (!hay) return { pts: WEIGHTS.field * 0.45, reason: null }; // no program data — neutral, not penalized
  const hit = tokens.some((tok) => hay.includes(tok));
  return hit
    ? { pts: WEIGHTS.field, reason: `Offers programs related to ${student.field_of_interest}` }
    : { pts: WEIGHTS.field * 0.15, reason: null };
}

function degreeScore(student, u) {
  const want = String(student.target_degree_level || '').trim();
  if (!want) return { pts: WEIGHTS.degree * 0.4, reason: null };
  const levels = u.degree_levels || [];
  if (!levels.length) return { pts: WEIGHTS.degree * 0.5, reason: null }; // unknown, neutral
  return levels.includes(want)
    ? { pts: WEIGHTS.degree, reason: `Offers ${want} programs` }
    : { pts: 0, reason: null };
}

function nicheScore(u) {
  const reasons = [];
  let pts = 0;
  if (isEU(u.country)) { pts += WEIGHTS.eu; reasons.push('EU member state'); }
  const langs = (u.language_of_instruction || []).map((l) => l.toLowerCase());
  if (langs.includes('english')) { pts += WEIGHTS.english; reasons.push('English-taught options'); }
  return { pts, reasons };
}

function affordabilityScore(u) {
  const min = u.tuition_range ? (u.tuition_range.min ?? null) : null;
  if (min == null) return { pts: WEIGHTS.afford * 0.5, reason: null };
  if (min <= 3000) return { pts: WEIGHTS.afford, reason: 'Affordable tuition (€0–3,000/yr range)' };
  if (min <= 8000) return { pts: WEIGHTS.afford * 0.7, reason: 'Moderate tuition (under €8,000/yr)' };
  if (min <= 15000) return { pts: WEIGHTS.afford * 0.35, reason: null };
  return { pts: 0, reason: null };
}

function richnessScore(u) {
  if (u.source === 'curated') return WEIGHTS.richness;
  if (u.source === 'eter') return WEIGHTS.richness * 0.65;
  return WEIGHTS.richness * 0.2;
}

/** @returns {{ score:number, reasons:string[] }} score is 0-100 */
function scoreUniversity(student, u) {
  const degree = degreeScore(student, u);
  const field = fieldScore(student, u);
  const niche = nicheScore(u);
  const afford = affordabilityScore(u);
  const richness = richnessScore(u);

  const total = degree.pts + field.pts + niche.pts + afford.pts + richness;
  const reasons = [degree.reason, field.reason, ...niche.reasons, afford.reason].filter(Boolean);

  return { score: Math.round(total), reasons: reasons.slice(0, 4) };
}

/**
 * @param {object} student
 * @param {object[]} universities
 * @param {{ limit?:number, excludeIds?:Set<string> }} [opts]
 */
function recommend(student, universities, opts = {}) {
  const { limit = 6, excludeIds } = opts;
  const scored = universities
    .filter((u) => !excludeIds || !excludeIds.has(u.id))
    .map((u) => ({ u, ...scoreUniversity(student, u) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((r) => ({ ...r.u, match_score: r.score, match_reasons: r.reasons }));
}

module.exports = { scoreUniversity, recommend, tokenize };
