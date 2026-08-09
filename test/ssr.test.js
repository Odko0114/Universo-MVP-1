"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const ssr = require("../lib/ssr");

test("esc escapes all five HTML-significant characters", () => {
  assert.equal(
    ssr.esc(`<script>alert("x")&'y'</script>`),
    "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;",
  );
});

test("esc treats null/undefined as empty string", () => {
  assert.equal(ssr.esc(null), "");
  assert.equal(ssr.esc(undefined), "");
});

test("metaTags escapes title/description and includes canonical + OG tags", () => {
  const html = ssr.metaTags({
    title: "A & B",
    description: 'x "y"',
    canonical: "https://e.com/x",
  });
  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /content="x &quot;y&quot;"/);
  assert.match(html, /rel="canonical" href="https:\/\/e\.com\/x"/);
  assert.match(html, /og:title/);
});

test("metaTags omits canonical/image tags when not provided", () => {
  const html = ssr.metaTags({ title: "T", description: "D" });
  assert.ok(!html.includes('rel="canonical"'));
  assert.ok(!html.includes("og:image"));
});

test("injectSSR replaces the shell title/description and injects meta + view content", () => {
  const shell = `<html><head><title>Old</title><meta name="description" content="old" /></head><body><main id="view" class="view"></main></body></html>`;
  const out = ssr.injectSSR(shell, {
    metaHtml: "<title>New</title>",
    viewHtml: "<p>hi</p>",
  });
  assert.ok(!out.includes("Old"));
  assert.match(out, /<title>New<\/title>/);
  assert.match(out, /<main id="view" class="view"><p>hi<\/p><\/main>/);
});

test("injectSSR leaves the view untouched when no viewHtml is given", () => {
  const shell = `<html><head><title>Old</title></head><body><main id="view"></main></body></html>`;
  const out = ssr.injectSSR(shell, { metaHtml: "<title>New</title>" });
  assert.match(out, /<main id="view"><\/main>/);
});

test("profileView renders name, location and escapes injected content (XSS-safe)", () => {
  const html = ssr.profileView({
    name: "<b>Evil U</b>",
    city: "Paris",
    country: "France",
    short_description: "desc",
  });
  assert.ok(!html.includes("<b>Evil U</b>"));
  assert.match(html, /&lt;b&gt;Evil U&lt;\/b&gt;/);
  assert.match(html, /Paris, France/);
});

test("profileView shows a tuition figure only for curated research", () => {
  const curated = ssr.profileView({
    name: "X",
    ranking: { world_rank: 5, provider: "CWUR" },
    tuition_source: "curated_research",
    tuition_range: { min: 0, max: 3000, period: "year" },
  });
  assert.match(curated, /#5 world/);
  assert.match(curated, /€0–€3,000\/year/);

  // A country-level estimate must NOT render as a number, and must NOT render a
  // "check official site" link in the value slot either — a row that looks
  // answered but isn't. The row is omitted; an honest notice explains why.
  const estimated = ssr.profileView({
    name: "Y",
    website: "https://y.example",
    source: "eter",
    tuition_source: "country_estimate",
    tuition_range: { min: 0, max: 3000, period: "year", estimated: true },
  });
  assert.ok(!estimated.includes("€3,000"), "estimate range not displayed");
  assert.ok(
    !/<dt>Tuition \(intl\)<\/dt>/.test(estimated),
    "no tuition row at all when unresearched",
  );
  assert.match(
    estimated,
    /have not verified tuition, programs or entry requirements/,
  );
  assert.match(estimated, /official European register/);
});

test("profileView omits the unverified notice on curated profiles", () => {
  const curated = ssr.profileView({
    name: "X",
    source: "curated",
    tuition_source: "curated_research",
    tuition_range: { min: 0, max: 3000, period: "year" },
  });
  assert.ok(!/have not verified tuition/.test(curated));
});

test("directoryView lists universities with links and escapes names", () => {
  const html = ssr.directoryView(
    [{ id: "a", name: "A & Z", city: "X", country: "Y" }],
    100,
  );
  assert.match(html, /href="\/university\/a"/);
  assert.match(html, /A &amp; Z/);
  assert.match(html, /100/);
});

// --- SSR / client template parity -------------------------------------------
// There are deliberately two profile templates: lib/ssr.js renders crawlable
// HTML for search engines and no-JS visitors, public/js/app.js renders the
// interactive one. Merging them would need a shared module across the
// CommonJS/browser boundary, which this codebase has no build step for.
//
// The risk that split creates is drift, and it is not hypothetical: the SSR
// view once showed estimated living cost and teaching language as plain facts
// while the client marked them "est."/"typical", so the page Google indexed was
// the less honest of the two. These tests fail if a fact is added to one
// template and not the other.
//
// Matching app.js as source text is crude — it's browser code this process
// can't import — but it does catch the drift that actually happened.

const fs = require("fs");
const path = require("path");
const CLIENT_SRC = fs.readFileSync(
  path.join(__dirname, "..", "public", "js", "app.js"),
  "utf8",
);

/** Facts both profile templates are expected to render. */
const SHARED_FACTS = [
  "Ranking",
  "Tuition (intl)",
  "Living cost",
  "Language",
  "Degree levels",
  "Application deadline",
  "Institution type",
  "Legal status",
  "Founded",
  "Students",
  "Website",
];

/** Sections both are expected to render. */
const SHARED_SECTIONS = [
  "Programs offered",
  "Fields of study",
  "Admission requirements",
];

const fullUni = {
  id: "parity-test",
  name: "Parity University",
  city: "Helsinki",
  country: "Finland",
  short_description: "A fixture with every field populated.",
  source: "curated",
  ranking: { world_rank: 42, national_rank: 2, provider: "CWUR" },
  tuition_range: { min: 0, max: 12000, period: "year" },
  tuition_source: "curated_research",
  estimated_living_cost: { min: 900, max: 1400, period: "month" },
  language_of_instruction: ["English", "Finnish"],
  degree_levels: ["Bachelor", "Master"],
  application_deadline: "Jan 15",
  institution_type: "University",
  legal_status: "Public",
  founded: 1900,
  student_count: 12345,
  website: "https://example.fi",
  programs_offered: ["Computer Science"],
  fields_of_study: ["Engineering"],
  acceptance_requirements: "A secondary school diploma.",
};

test("parity: every shared fact label is rendered by the SSR profile", () => {
  const html = ssr.profileView(fullUni);
  for (const label of SHARED_FACTS) {
    assert.ok(
      html.includes(`<dt>${label}</dt>`),
      `SSR profile is missing the "${label}" fact`,
    );
  }
});

test("parity: every shared fact label also exists in the client profile", () => {
  for (const label of SHARED_FACTS) {
    assert.ok(
      CLIENT_SRC.includes(`"${label}"`),
      `client profile is missing the "${label}" fact — the two templates have drifted`,
    );
  }
});

test("parity: shared sections exist in both templates", () => {
  const html = ssr.profileView(fullUni);
  for (const s of SHARED_SECTIONS) {
    assert.ok(html.includes(s), `SSR profile is missing the "${s}" section`);
    assert.ok(
      CLIENT_SRC.includes(`"${s}"`),
      `client profile is missing the "${s}" section`,
    );
  }
});

test("parity: both templates mark estimated values rather than stating them as fact", () => {
  const estimated = {
    ...fullUni,
    source: "eter",
    tuition_source: null,
    estimated_living_cost: {
      min: 900,
      max: 1400,
      period: "month",
      estimated: true,
    },
    language_estimated: true,
  };
  const html = ssr.profileView(estimated);

  assert.ok(
    html.includes("Living cost · est."),
    "SSR must flag an estimated living cost",
  );
  assert.ok(html.includes("~€"), "estimated money keeps its ~ prefix");
  assert.ok(
    html.includes("Language · typical"),
    "SSR must flag an estimated language",
  );

  assert.ok(
    CLIENT_SRC.includes("· est."),
    "client must flag estimated living cost",
  );
  assert.ok(
    CLIENT_SRC.includes("· typical"),
    "client must flag estimated language",
  );
});

test("parity: neither template invents a tuition figure it hasn't researched", () => {
  const unresearched = { ...fullUni, source: "eter", tuition_source: null };
  const html = ssr.profileView(unresearched);
  assert.ok(
    !html.includes("<dt>Tuition (intl)</dt>"),
    "a tuition row without curated_research reads as a verified figure it isn't",
  );
  assert.ok(
    CLIENT_SRC.includes("curated_research"),
    "client must still gate tuition on tuition_source",
  );
});
