"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const app = require("../server");
const store = require("../lib/store");
const { createSeoPages, slug, clip } = require("../lib/seo-pages");

let server, base;
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const get = async (p, headers = {}) => {
  const r = await fetch(base + p, { redirect: "manual", headers });
  return {
    status: r.status,
    location: r.headers.get("location"),
    text: await r.text(),
  };
};
const one = (html, re) => (html.match(new RegExp(re, "g")) || []).length;

test("unknown URLs are real 404s and never indexable", async () => {
  for (const p of [
    "/nope",
    "/study-in/atlantis",
    "/study/alchemy",
    "/universities-in/nowhere",
    "/scholarship/nope",
    "/university/nope",
  ]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.text, /name="robots" content="noindex/, p);
  }
});

test("every URL in the sitemap answers 200 with one title, one description, one h1 and a self canonical", async () => {
  const xml = (await get("/sitemap.xml")).text;
  const urls = [...xml.matchAll(/<loc>([^<]+)/g)].map(
    (m) => new URL(m[1]).pathname,
  );
  assert.equal(new Set(urls).size, urls.length, "no duplicates");
  const titles = new Map();
  const descs = new Map();
  for (const p of urls) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(one(r.text, "<title>"), 1, p + " title");
    assert.equal(
      one(r.text, '<meta\\s+name="description"'),
      1,
      p + " description",
    );
    assert.ok(!/name="robots" content="noindex/.test(r.text), p + " indexable");
    const canonical = r.text.match(/<link rel="canonical" href="([^"]+)"/)[1];
    assert.equal(new URL(canonical).pathname, p, p + " canonical");
    assert.ok(canonical.startsWith("http"), p + " absolute canonical");
    if (p !== "/" && p !== "/for-universities")
      assert.equal(one(r.text, "<h1[ >]"), 1, p + " h1");
    const t = r.text.match(/<title>([^<]*)/)[1];
    assert.ok(!titles.has(t), `same title on ${p} and ${titles.get(t)}: ${t}`);
    titles.set(t, p);
    const d = r.text.match(/<meta\s+name="description"\s+content="([^"]*)"/)[1];
    assert.ok(d.length > 30, p + " description");
    if (p.startsWith("/university/")) continue; // register text can coincide
    assert.ok(!descs.has(d), `same description on ${p} and ${descs.get(d)}`);
    descs.set(d, p);
    for (const m of r.text.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ))
      JSON.parse(m[1]);
  }
});

test("every indexable profile is linked from at least one landing page", async () => {
  const unis = store.read("universities");
  const pages = createSeoPages({ universities: unis, scholarships: [] });
  const linked = new Set();
  for (const p of pages.paths()) {
    const [, kind, s] = p.split("/");
    const page = kind === "study-in" ? pages.country(s, "") : null;
    if (page)
      for (const m of page.view.matchAll(/\/university\/([^"]+)"/g))
        linked.add(m[1]);
  }
  const orphans = unis.filter((u) => u.verified && !linked.has(u.id));
  assert.deepEqual(
    orphans
      .map((u) => `${u.id} (${u.country})`)
      .filter((x) => !/Poland/.test(x)),
    [],
  );
});

test("internal links on landing pages never point at a 404", async () => {
  const seen = new Set();
  for (const p of [
    "/study-in-europe",
    "/study-in/finland",
    "/study/medicine",
    "/universities-in/milan",
    "/scholarships",
    "/university/tum",
    "/",
  ]) {
    const { text } = await get(p);
    for (const m of text.matchAll(
      /href="(\/(?:study|universit|scholarship)[^"#?]*)"/g,
    ))
      seen.add(m[1]);
  }
  for (const href of seen) assert.equal((await get(href)).status, 200, href);
});

test("uppercase and trailing-slash variants redirect to the one real URL", async () => {
  const r = await get("/study-in/Finland");
  assert.equal(r.status, 301);
  assert.equal(r.location, "/study-in/finland");
  assert.equal((await get("/study-in/finland/")).status, 301);
});

test("honesty: no unresearched tuition, estimates labelled, passed deadlines never read as upcoming", () => {
  const pages = createSeoPages({
    universities: Array.from({ length: 5 }, (_, i) => ({
      id: "u" + i,
      name: "Uni " + i,
      country: "Finland",
      city: "X",
      tuition_range: { min: 0, max: 4321, period: "year", estimated: true },
      tuition_source: "country_estimate",
      fields_offered: [],
    })),
    scholarships: [
      {
        key: "k",
        name: "K",
        country: "Finland",
        application: { deadline: "2026-01-15", deadline_note: "15 January" },
      },
    ],
    now: () => Date.parse("2026-11-25"),
  });
  const c = pages.country("finland", "");
  assert.ok(!c.view.includes("4,321"));
  assert.match(c.view, /not an official figure/);
  const s = pages.scholarship("k", "");
  assert.match(s.view, /has passed/);
  assert.ok(!/<strong>15 January 2026/.test(s.view));
});

test("names are escaped", () => {
  const pages = createSeoPages({
    universities: Array.from({ length: 5 }, (_, i) => ({
      id: "u" + i,
      name: "<b>x</b>",
      country: "Finland",
      fields_offered: [],
    })),
    scholarships: [],
  });
  const c = pages.country("finland", "");
  assert.ok(!c.view.includes("<b>x</b>") && !c.head.includes("<b>"));
});

test("related links sit outside <main> so they survive the app rendering over it", async () => {
  const { text } = await get("/university/tum");
  assert.ok(text.indexOf('id="ssr-more"') > text.indexOf("</main>"));
});

test("crawlers are not counted as visitors; people are", async () => {
  const events = require("../lib/events");
  const count = async () => {
    await events.flush();
    return events.readAll().filter((e) => e.type === "pageview").length;
  };
  const n = await count();
  await get("/study-in/finland", {
    "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
  });
  await get("/discover", {
    "User-Agent": "Mozilla/5.0 (compatible; bingbot/2.0)",
  });
  assert.equal(await count(), n);
  await get("/study-in/finland", {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1",
  });
  assert.equal(await count(), n + 1);
});

test("slug and clip", () => {
  assert.equal(slug("Agriculture & Veterinary"), "agriculture-and-veterinary");
  assert.equal(slug("València"), "valencia");
  assert.ok(clip("word ".repeat(80)).length <= 155);
});
