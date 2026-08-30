"use strict";

/**
 * Single source of truth for the Universo mark.
 *
 * The logo is the two angular halves (traced from the real mark). It used to be
 * copy-pasted as inline SVG into ~6 HTML files, an auth card, the favicon, and a
 * divergent serif wordmark in email — which is exactly how it drifted (landing
 * showed the new mark while the app shell showed an old one). Everything that
 * renders the mark server-side or in email now pulls it from here, so changing
 * these two paths changes it everywhere at once.
 *
 * (The static HTML pages reference /img/logo.svg — the same art in file form —
 * so a build step isn't required to share it; see docs/ and Phase 2.)
 */

// viewBox 0 0 200 200. Byte-for-byte the mark on the landing page + favicon.
const MARK_PATHS = [
  "M21.5 38.8 L28.6 42.7 L29.7 44.9 L65 70 L70.1 72.2 L80.6 80.6 L83.8 86.3 L85.3 86.8 L85.3 127.3 L86.1 127.8 L85.3 129.5 L85.7 146.7 L84.9 148 L86.1 148.9 L88.5 158.6 L94.7 164.8 L94.3 167 L92.4 165.2 L93.5 164.8 L92.8 163.9 L88.5 163.4 L80.6 158.6 L77.5 155.1 L29.4 120.3 L21.9 111 L19.2 101.3 L20 99.1 L19.2 88.5 L20.4 81.9 L19.6 67 L18.8 67.8 L20.4 60.8 L19.6 47.1 L20.4 39.6 Z",
  "M178.5 38.8 L171.4 42.7 L170.3 44.9 L135 70 L129.9 72.2 L119.4 80.6 L116.2 86.3 L114.7 86.8 L114.7 127.3 L113.9 127.8 L114.7 129.5 L114.3 146.7 L115.1 148 L113.9 148.9 L111.5 158.6 L105.3 164.8 L105.7 167 L107.6 165.2 L106.5 164.8 L107.2 163.9 L111.5 163.4 L119.4 158.6 L122.5 155.1 L170.6 120.3 L178.1 111 L180.8 101.3 L180 99.1 L180.8 88.5 L179.6 81.9 L180.4 67 L181.2 67.8 L179.6 60.8 L180.4 47.1 L179.6 39.6 Z",
];

const WORDMARK = "Universo";
const TAGLINE = "Same Start. Equal Chance.";
const NAVY = "#0B1F3A";
const GOLD = "#E9B949";

/**
 * Inline SVG for the mark at a given pixel size and fill colour.
 * @param {{size?:number, color?:string, title?:string}} [opts]
 */
function markSvg({ size = 24, color = NAVY, title = WORDMARK } = {}) {
  const paths = MARK_PATHS.map((d) => `<path fill="${color}" d="${d}"/>`).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${title}">${paths}</svg>`;
}

// Inline web variant: no width/height (CSS sizes it) and fill=currentColor (CSS
// `color` tints it) — a drop-in for the hardcoded inline marks in the served
// HTML pages, which the server fills from this one source (server.js#withBrand).
function markSvgInline({ color = "currentColor" } = {}) {
  const paths = MARK_PATHS.map((d) => `<path fill="${color}" d="${d}"/>`).join("");
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${paths}</svg>`;
}

// Full standalone SVG document, used to write public/img/logo.svg (white mark on
// the navy tile — matches the favicon).
function logoFileSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${NAVY}"/><g fill="#FFFFFF">${MARK_PATHS.map(
    (d) => `<path d="${d}"/>`,
  ).join("")}</g></svg>`;
}

module.exports = {
  MARK_PATHS,
  WORDMARK,
  TAGLINE,
  NAVY,
  GOLD,
  markSvg,
  markSvgInline,
  logoFileSvg,
};
