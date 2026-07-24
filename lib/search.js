'use strict';

/**
 * University search / filter / sort — pure functions over a prebuilt index, so
 * they're fast (no per-request haystack rebuilds) and unit-testable.
 *
 * Search is diacritic-insensitive ("sao paulo" matches "São Paulo") and ranked
 * by relevance (name-prefix > word-prefix > name-substring > anywhere) rather
 * than returning matches in arbitrary order.
 */

const { isEU } = require('./countries');

// Fold to a diacritic-free lowercase form for accent-insensitive matching.
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Precompute per-record search fields once (dataset is static at runtime). */
function buildIndex(all) {
  return all.map((u) => {
    const name = fold(u.name);
    const hay = fold([
      u.name, u.name_native, u.acronym, u.city, u.region, u.country,
      u.short_description, ...(u.programs_offered || []), ...(u.fields_of_study || []),
    ].filter(Boolean).join(' '));
    return { u, name, hay };
  });
}

function buildFilters(all) {
  const countries = new Set();
  const fields = new Set();
  const languages = new Set();
  const degrees = new Set();
  const types = new Set();
  for (const u of all) {
    if (u.country) countries.add(u.country);
    (u.fields_of_study || []).forEach((f) => fields.add(f));
    (u.language_of_instruction || []).forEach((l) => languages.add(l));
    (u.degree_levels || []).forEach((d) => degrees.add(d));
    if (u.institution_type) types.add(u.institution_type);
  }
  const sorted = (set) => [...set].sort((a, b) => a.localeCompare(b));
  return {
    countries: sorted(countries),
    fields_of_study: sorted(fields),
    languages: sorted(languages),
    degree_levels: ['Bachelor', 'Master', 'PhD'].filter((d) => degrees.has(d)),
    institution_types: ['University', 'University of Applied Sciences', 'Other institution'].filter((t) => types.has(t)),
  };
}

// Relevance score for a keyword against a record's folded name/haystack.
function score(entry, q) {
  if (entry.name === q) return 5;
  if (entry.name.startsWith(q)) return 4;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(entry.name)) return 3;
  if (entry.name.includes(q)) return 2;
  if (entry.hay.includes(q)) return 1;
  return 0;
}

/**
 * @param {Array} index      output of buildIndex()
 * @param {object} params    { q, country, region, type, source, verified, field, language, degree, maxTuition, sort, offset, limit }
 * @param {(id:string)=>number} clickOf  click count lookup
 * @param {{ scoreFn?: (u:object)=>number }} [opts]  match scorer for sort=match
 */
function query(index, params, clickOf = () => 0, opts = {}) {
  const { q, country, region, type, source, verified, field, language, degree, maxTuition, sort } = params;
  const { scoreFn } = opts;
  const term = fold((q || '').trim());

  let rows = index;

  if (term) {
    rows = rows.map((e) => ({ e, s: score(e, term) })).filter((x) => x.s > 0);
  } else {
    rows = rows.map((e) => ({ e, s: 0 }));
  }

  const keep = (u) => {
    if (country && u.country !== country) return false;
    if (region === 'EU' && !isEU(u.country)) return false;
    if (type && u.institution_type !== type) return false;
    if (source && (u.source || 'curated') !== source) return false;
    // '1'/'true' → verified profiles only (the Discover default); anything else
    // (absent, '0', 'all') imposes no verified constraint.
    if ((verified === '1' || verified === 'true' || verified === true) && !u.verified) return false;
    if (field && !(u.fields_of_study || []).includes(field)) return false;
    if (language && !(u.language_of_instruction || []).includes(language)) return false;
    if (degree && !(u.degree_levels || []).includes(degree)) return false;
    if (maxTuition !== undefined && maxTuition !== '' && !Number.isNaN(Number(maxTuition))) {
      if (!u.tuition_range || (u.tuition_range.min ?? 0) > Number(maxTuition)) return false;
    }
    return true;
  };
  rows = rows.filter((x) => keep(x.e.u));

  const byName = (a, b) => a.e.u.name.localeCompare(b.e.u.name);
  // sort=match ranks by the injected match scorer (a logged-in student's fit).
  // It wins over text relevance so "best fit" ordering is honoured even during
  // a search; falls back to name when no scorer is supplied.
  if (sort === 'match' && scoreFn) {
    rows.sort((a, b) => scoreFn(b.e.u) - scoreFn(a.e.u) || (term ? b.s - a.s : 0) || byName(a, b));
  } else if (term) {
    rows.sort((a, b) => b.s - a.s || byName(a, b));
  } else {
    switch (sort) {
      case 'tuition':
        rows.sort((a, b) => {
          const at = a.e.u.tuition_range ? a.e.u.tuition_range.min ?? 0 : Infinity;
          const bt = b.e.u.tuition_range ? b.e.u.tuition_range.min ?? 0 : Infinity;
          return at - bt || byName(a, b);
        });
        break;
      case 'popular':
        rows.sort((a, b) => clickOf(b.e.u.id) - clickOf(a.e.u.id) || byName(a, b));
        break;
      case 'size':
        rows.sort((a, b) => (b.e.u.student_count || 0) - (a.e.u.student_count || 0) || byName(a, b));
        break;
      default:
        rows.sort(byName);
    }
  }

  const total = rows.length;
  const offset = Math.max(0, parseInt(params.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(params.limit, 10) || 48));
  const page = rows.slice(offset, offset + limit).map((x) => ({ ...x.e.u, click_count: clickOf(x.e.u.id) }));

  return { count: total, offset, limit, has_more: offset + limit < total, universities: page };
}

module.exports = { fold, buildIndex, buildFilters, query };
