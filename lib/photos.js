"use strict";

// Cover-photo filtering.
//
// Wikipedia's `pageimages` for a university article is very often the
// institution's seal, coat of arms or wordmark rather than a photograph of the
// place. Rendered into a 16:9 cover with `center/cover`, a wide wordmark gets
// cropped into unreadable letter fragments — on a card grid that reads as
// broken, and on a profile hero the cropped text collides with the overlaid
// university name.
//
// A rejected image is better than a mangled one: the card and profile already
// fall back to a deliberate placeholder glyph, which looks intentional.
// Rejecting the image never discards the article `extract` — that text is what
// fills the Overview section and is genuinely useful.

// ponytail: filename heuristic, not image analysis. It cannot see a logo whose
// filename says nothing (e.g. "University_of_X_1.jpg"), and it will reject the
// rare real photo with one of these words in its name. Upgrade path if that
// matters: read width/height from the Commons `imageinfo` API and reject on
// aspect ratio + flat-colour ratio instead.
const LOGO_WORDS =
  /(logo|logotyp|wordmark|seal|siegel|sigill|escudo|emblem|crest|insignia|coat[-_ ]?of[-_ ]?arms|blason|sceau|stemma|wapen|signet|shield)/i;

/**
 * True when a Wikipedia/Commons image URL looks like institutional artwork
 * rather than a photograph.
 * @param {string|null|undefined} url
 */
function isLogoLike(url) {
  if (!url) return false;
  let s = String(url);
  try {
    s = decodeURIComponent(s);
  } catch {
    // Malformed percent-encoding — fall through and match the raw string.
  }
  // Vector art on Wikipedia is essentially never a photograph. Matches both the
  // original (".../Foo.svg") and its raster thumbnail (".../Foo.svg/800px-Foo.svg.png").
  if (/\.svg(\/|$|\?)/i.test(s) || /\.svg\.(png|jpe?g)/i.test(s)) return true;
  return LOGO_WORDS.test(s.split("/").pop() || "");
}

// Bump when the lookup strategy changes in a way that could turn a past miss
// into a hit. Entries record the version that produced them, so a miss from an
// older strategy can be retried exactly once instead of on every boot.
//   1 — Wikipedia lead image only (kept seals; cached failures permanently)
//   2 — seals rejected, Commons photo search as fallback
const LOOKUP_VERSION = 2;

/**
 * Drops cache entries worth looking up again under the current strategy.
 * Mutates `cache` in place; returns how many were removed.
 *
 * Two kinds go:
 *
 * - A logo-like image. Deleting rather than blanking in place is the change
 *   from the previous version: blanking was right when rejecting a seal was the
 *   end of the road, but now a retry can find real campus photography.
 *
 * - Any entry with no photo produced by an older strategy. That covers seals
 *   the previous filter blanked, and — more importantly — lookups that failed on
 *   a timeout or an open circuit breaker and got recorded as a permanent "this
 *   university has no photo". Those two are indistinguishable after the fact, so
 *   the version stamp gives both one clean attempt.
 *
 * Entries that already hold a real photo are never touched; there is nothing to
 * gain by re-fetching a picture that works.
 *
 * Self-limiting: everything written afterwards carries the current version, so
 * a second pass finds nothing.
 * @param {Record<string, any>} cache
 * @param {number} [version]
 */
function dropStale(cache, version = LOOKUP_VERSION) {
  let n = 0;
  for (const [id, entry] of Object.entries(cache || {})) {
    if (!entry) continue;
    const isLogo = entry.photo_url && isLogoLike(entry.photo_url);
    const staleMiss = !entry.photo_url && entry.v !== version;
    if (isLogo || staleMiss) {
      delete cache[id];
      n++;
    }
  }
  return n;
}

// A cover renders as a 16:9 banner via `center/cover`. Portrait and square
// images lose their subject to the crop, and anything small gets upscaled into
// mush, so both are rejected rather than displayed badly.
const MIN_WIDTH = 800;
const MIN_RATIO = 1.2;
const PHOTO_MIME = /^image\/(jpeg|png|webp)$/i;

/**
 * Picks the first candidate that is actually usable as a cover photo.
 *
 * Returns the FIRST survivor rather than the largest or widest: candidates
 * arrive in search-relevance order, and the most relevant usable image beats a
 * bigger but less related one.
 * @param {Array<{title?:string,url?:string,width?:number,height?:number,mime?:string}>} candidates
 */
function pickBestPhoto(candidates) {
  for (const c of candidates || []) {
    if (!c || !c.url) continue;
    if (c.mime && !PHOTO_MIME.test(c.mime)) continue;
    if (isLogoLike(c.title) || isLogoLike(c.url)) continue;
    if (!c.width || !c.height) continue;
    if (c.width < MIN_WIDTH) continue;
    if (c.width / c.height < MIN_RATIO) continue;
    return c;
  }
  return null;
}

module.exports = { isLogoLike, dropStale, pickBestPhoto, LOOKUP_VERSION };
