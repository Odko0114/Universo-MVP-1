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

/**
 * One-time repair of an existing photo cache: blanks out `photo_url` on entries
 * whose image is logo-like, keeping the article extract and marking the entry so
 * it is never re-looked-up. Mutates `cache` in place; returns how many changed.
 *
 * Rewriting in place (rather than deleting the entry) matters: deleting would
 * send every affected profile back to Wikipedia on next view, and the lookup
 * would just reject the same image again.
 * @param {Record<string, any>} cache
 */
function pruneLogoPhotos(cache) {
  let n = 0;
  for (const entry of Object.values(cache || {})) {
    if (entry && entry.photo_url && isLogoLike(entry.photo_url)) {
      entry.photo_url = null;
      entry.attribution = null;
      entry.rejected = "logo"; // provenance: why this has no photo
      n++;
    }
  }
  return n;
}

module.exports = { isLogoLike, pruneLogoPhotos };
