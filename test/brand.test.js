"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const brand = require("../lib/brand");

const PUB = path.join(__dirname, "..", "public");

test("favicon + logo.svg use the canonical mark paths from lib/brand", () => {
  for (const f of ["favicon.svg", "img/logo.svg"]) {
    const svg = fs.readFileSync(path.join(PUB, f), "utf8");
    for (const d of brand.MARK_PATHS)
      assert.ok(svg.includes(d), `${f} is out of sync with lib/brand.MARK_PATHS`);
  }
});

test("no HTML page hardcodes the mark — every page pulls it from the token", () => {
  for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(PUB, f), "utf8");
    for (const d of brand.MARK_PATHS)
      assert.ok(
        !html.includes(d),
        `${f} hardcodes a logo path — use <!--BRAND_MARK--> so it stays in sync`,
      );
  }
});

test("app.js does not hardcode the mark (auth card clones the shell logo)", () => {
  const js = fs.readFileSync(path.join(PUB, "js", "app.js"), "utf8");
  for (const d of brand.MARK_PATHS)
    assert.ok(!js.includes(d), "app.js hardcodes a logo path — clone the shell instead");
});

test("markSvgInline is a currentColor drop-in carrying both mark paths", () => {
  const svg = brand.markSvgInline();
  assert.match(svg, /fill="currentColor"/);
  assert.ok(!/width=|height=/.test(svg), "inline variant leaves sizing to CSS");
  for (const d of brand.MARK_PATHS) assert.ok(svg.includes(d));
});
