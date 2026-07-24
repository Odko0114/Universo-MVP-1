'use strict';

/**
 * Best-effort `city_size_category` for the match's soft "city preference"
 * bonus. There is no per-city population field in the source data, so this is
 * a heuristic: a curated set of Europe's large metros, with a university-size
 * proxy as a fallback (very large institutions are almost always in larger
 * cities). It is intentionally approximate — city size is only ever a +20 soft
 * bonus that's skipped entirely when the student states no preference, never a
 * hard filter, so an occasional wrong guess can't hide a good match.
 *
 * Values: 'large' | 'mid' | 'small' | null (unknown).
 */

// Major European cities (>~500k metro) — folded to a diacritic-free lowercase key.
const LARGE_CITIES = new Set([
  'london', 'paris', 'madrid', 'barcelona', 'berlin', 'munich', 'munchen', 'hamburg', 'cologne', 'koln',
  'frankfurt', 'rome', 'roma', 'milan', 'milano', 'naples', 'napoli', 'turin', 'torino', 'amsterdam',
  'rotterdam', 'vienna', 'wien', 'warsaw', 'warszawa', 'krakow', 'cracow', 'lodz', 'wroclaw', 'poznan',
  'budapest', 'prague', 'praha', 'bucharest', 'bucuresti', 'brussels', 'bruxelles', 'antwerp', 'antwerpen',
  'stockholm', 'gothenburg', 'goteborg', 'copenhagen', 'kobenhavn', 'helsinki', 'oslo', 'lisbon', 'lisboa',
  'porto', 'athens', 'athina', 'thessaloniki', 'dublin', 'zurich', 'geneva', 'geneve', 'zagreb', 'sofia',
  'valencia', 'seville', 'sevilla', 'malaga', 'zaragoza', 'bilbao', 'lyon', 'marseille', 'toulouse', 'lille',
  'nice', 'nantes', 'bordeaux', 'strasbourg', 'stuttgart', 'dusseldorf', 'dusseldorf', 'dortmund', 'essen',
  'leipzig', 'dresden', 'hannover', 'nuremberg', 'nurnberg', 'manchester', 'birmingham', 'glasgow', 'leeds',
  'liverpool', 'edinburgh', 'bristol', 'sheffield', 'the hague', 'den haag', 'utrecht', 'eindhoven',
  'gdansk', 'riga', 'vilnius', 'tallinn', 'bratislava', 'ljubljana', 'palma', 'bologna', 'florence', 'firenze',
]);

// Known smaller university towns — genuinely small places worth tagging 'small'
// rather than guessing from size.
const SMALL_TOWNS = new Set([
  'leuven', 'louvain', 'delft', 'wageningen', 'lund', 'uppsala', 'heidelberg', 'tubingen', 'tubingen',
  'gottingen', 'gottingen', 'freiburg', 'konstanz', 'marburg', 'jena', 'oxford', 'cambridge', 'st andrews',
  'coimbra', 'siena', 'pisa', 'ferrara', 'pavia', 'tartu', 'aarhus', 'odense', 'trondheim', 'bergen',
  'jyvaskyla', 'oulu', 'tampere', 'twente', 'enschede', 'maastricht', 'groningen', 'nijmegen', 'ghent', 'gent',
]);

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * @param {{ city?: string, student_count?: number }} u
 * @returns {'large'|'mid'|'small'|null}
 */
function citySizeCategory(u) {
  const key = fold(u.city);
  if (key && LARGE_CITIES.has(key)) return 'large';
  if (key && SMALL_TOWNS.has(key)) return 'small';
  // Fallback proxy: institution size correlates loosely with city size.
  const n = u.student_count;
  if (typeof n === 'number' && n > 0) {
    if (n >= 25000) return 'large';
    if (n >= 6000) return 'mid';
    return 'small';
  }
  return null;
}

module.exports = { citySizeCategory, LARGE_CITIES, SMALL_TOWNS };
