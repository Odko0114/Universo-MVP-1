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
  for (const url of real) assert.ok(photos.isLogoLike(url), `should reject ${url}`);
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
  for (const url of keep) assert.ok(!photos.isLogoLike(url), `should keep ${url}`);
});

test("isLogoLike: handles null/empty and malformed encoding without throwing", () => {
  assert.equal(photos.isLogoLike(null), false);
  assert.equal(photos.isLogoLike(undefined), false);
  assert.equal(photos.isLogoLike(""), false);
  assert.equal(photos.isLogoLike("https://example.org/a%ZZ_campus.jpg"), false);
  assert.equal(photos.isLogoLike("https://example.org/a%ZZ_logo.jpg"), true);
});

test("pruneLogoPhotos: blanks logo entries, keeps the extract, leaves photos alone", () => {
  const cache = {
    tum: {
      photo_url: "https://upload.wikimedia.org/x/Logo_of_TUM.svg",
      attribution: { artist: "Someone" },
      extract: "The Technical University of Munich is…",
    },
    aarhus: {
      photo_url: "https://upload.wikimedia.org/x/Aarhus_main_building.jpg",
      extract: "Aarhus University is…",
    },
    nothing: { none: true },
  };

  assert.equal(photos.pruneLogoPhotos(cache), 1);

  assert.equal(cache.tum.photo_url, null, "logo image dropped");
  assert.equal(cache.tum.attribution, null, "credit for a dropped image goes too");
  assert.equal(cache.tum.rejected, "logo", "records why it has no photo");
  assert.match(cache.tum.extract, /Technical University/, "overview text survives");

  assert.match(cache.aarhus.photo_url, /Aarhus_main_building/, "real photo untouched");
  assert.equal(cache.aarhus.rejected, undefined);

  assert.equal(photos.pruneLogoPhotos(cache), 0, "second run is a no-op");
});

test("pruneLogoPhotos: tolerates an empty or missing cache", () => {
  assert.equal(photos.pruneLogoPhotos({}), 0);
  assert.equal(photos.pruneLogoPhotos(null), 0);
});
