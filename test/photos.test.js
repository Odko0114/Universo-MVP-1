"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const photos = require("../lib/photos");

test("isLogoLike: rejects the real logo URLs that were cached as cover photos", () => {
  // Every one of these was actually in data/photos.json as a "cover photo".
  const real = [
    "https://upload.wikimedia.org/wikipedia/commons/c/cc/Harvard_University_coat_of_arms.svg",
    "https://upload.wikimedia.org/wikipedia/commons/c/c8/Logo_of_the_Technical_University_of_Munich.svg",
    "https://upload.wikimedia.org/wikipedia/commons/2/2c/Siegel_der_Albert-Ludwigs-Universit%C3%A4t_Freiburg.svg",
    "https://upload.wikimedia.org/wikipedia/commons/9/9a/Escudo_de_la_Universidad_Aut%C3%B3noma_de_Madrid.svg",
    "https://upload.wikimedia.org/wikipedia/commons/0/0e/Logo_UPF.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/5/5f/UNAV.svg",
  ];
  for (const url of real)
    assert.ok(photos.isLogoLike(url), `should reject ${url}`);
});

test("isLogoLike: rejects raster thumbnails rendered from an SVG", () => {
  // Wikipedia serves SVGs to `pageimages` as a .png thumbnail of the .svg.
  assert.ok(
    photos.isLogoLike(
      "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/UNAV.svg/1000px-UNAV.svg.png",
    ),
  );
});

test("isLogoLike: keeps genuine campus photographs", () => {
  const keep = [
    "https://upload.wikimedia.org/wikipedia/commons/7/7e/Aarhus_University_main_building.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/1/12/Campus_of_Trinity_College_Dublin.JPG",
    "https://upload.wikimedia.org/wikipedia/commons/a/a4/Sorbonne_courtyard_2019.jpeg",
  ];
  for (const url of keep)
    assert.ok(!photos.isLogoLike(url), `should keep ${url}`);
});

test("isLogoLike: handles null/empty and malformed encoding without throwing", () => {
  assert.equal(photos.isLogoLike(null), false);
  assert.equal(photos.isLogoLike(undefined), false);
  assert.equal(photos.isLogoLike(""), false);
  assert.equal(photos.isLogoLike("https://example.org/a%ZZ_campus.jpg"), false);
  assert.equal(photos.isLogoLike("https://example.org/a%ZZ_logo.jpg"), true);
});

test("dropStale: retries logos and old misses, keeps working photos", () => {
  const V = photos.LOOKUP_VERSION;
  const cache = {
    // A seal cached as a photo by the original lookup.
    tum: {
      photo_url: "https://upload.wikimedia.org/x/Logo_of_TUM.svg",
      extract: "The Technical University of Munich is…",
    },
    // Blanked in place by the previous filter — no photo_url left to match on.
    freiburg: { photo_url: null, rejected: "logo", extract: "Freiburg is…" },
    // A miss from the old strategy. Indistinguishable from a genuine "no photo
    // exists", which is exactly why the version stamp decides it.
    poisoned: { none: true },
    // Already looked up under the current strategy and genuinely found nothing.
    genuinely_none: { none: true, v: V },
    // A real photo: never re-fetched, whatever version wrote it.
    aarhus: {
      photo_url: "https://upload.wikimedia.org/x/Aarhus_main_building.jpg",
      extract: "Aarhus University is…",
    },
  };

  assert.equal(photos.dropStale(cache), 3);

  assert.ok(!("tum" in cache), "seal dropped so a retry can find a photo");
  assert.ok(!("freiburg" in cache), "already-blanked entry retries too");
  assert.ok(
    !("poisoned" in cache),
    "a miss from an older strategy gets one retry",
  );
  assert.ok(
    "genuinely_none" in cache,
    "a miss under the CURRENT strategy stands",
  );
  assert.match(
    cache.aarhus.photo_url,
    /Aarhus_main_building/,
    "working photo untouched",
  );

  assert.equal(photos.dropStale(cache), 0, "second run is a no-op");
});

test("dropStale: tolerates an empty or missing cache", () => {
  assert.equal(photos.dropStale({}), 0);
  assert.equal(photos.dropStale(null), 0);
});

test("pickBestPhoto: takes the first usable candidate, preserving search relevance", () => {
  const best = photos.pickBestPhoto([
    {
      title: "File:Logo of X.svg",
      url: "https://c/Logo_of_X.svg",
      width: 2000,
      height: 1200,
      mime: "image/svg+xml",
    },
    {
      title: "File:X campus.jpg",
      url: "https://c/X_campus.jpg",
      width: 4000,
      height: 2250,
      mime: "image/jpeg",
    },
    {
      title: "File:X library.jpg",
      url: "https://c/X_library.jpg",
      width: 6720,
      height: 4480,
      mime: "image/jpeg",
    },
  ]);
  assert.equal(
    best.title,
    "File:X campus.jpg",
    "not the largest — the first usable one",
  );
});

test("pickBestPhoto: rejects portrait, tiny and non-photo candidates", () => {
  // Real shapes seen in Commons results for these universities.
  assert.equal(
    photos.pickBestPhoto([
      {
        title: "File:TUM tower.jpg",
        url: "https://c/a.jpg",
        width: 3240,
        height: 4320,
        mime: "image/jpeg",
      },
    ]),
    null,
    "portrait loses its subject to a 16:9 crop",
  );

  assert.equal(
    photos.pickBestPhoto([
      {
        title: "File:Small.jpg",
        url: "https://c/b.jpg",
        width: 400,
        height: 220,
        mime: "image/jpeg",
      },
    ]),
    null,
    "too small to upscale into a banner",
  );

  assert.equal(
    photos.pickBestPhoto([
      {
        title: "File:Seal.svg",
        url: "https://c/c.svg",
        width: 2000,
        height: 2000,
        mime: "image/svg+xml",
      },
    ]),
    null,
    "vector art is never a photograph",
  );

  assert.equal(
    photos.pickBestPhoto([
      { title: "File:Nice.jpg", url: "https://c/d.jpg", mime: "image/jpeg" },
    ]),
    null,
    "unknown dimensions can't be judged",
  );
});

test("pickBestPhoto: returns null for empty or missing input", () => {
  assert.equal(photos.pickBestPhoto([]), null);
  assert.equal(photos.pickBestPhoto(null), null);
});
