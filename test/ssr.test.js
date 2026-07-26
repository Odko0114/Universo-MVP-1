'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ssr = require('../lib/ssr');

test('esc escapes all five HTML-significant characters', () => {
  assert.equal(ssr.esc(`<script>alert("x")&'y'</script>`), '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;');
});

test('esc treats null/undefined as empty string', () => {
  assert.equal(ssr.esc(null), '');
  assert.equal(ssr.esc(undefined), '');
});

test('metaTags escapes title/description and includes canonical + OG tags', () => {
  const html = ssr.metaTags({ title: 'A & B', description: 'x "y"', canonical: 'https://e.com/x' });
  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /content="x &quot;y&quot;"/);
  assert.match(html, /rel="canonical" href="https:\/\/e\.com\/x"/);
  assert.match(html, /og:title/);
});

test('metaTags omits canonical/image tags when not provided', () => {
  const html = ssr.metaTags({ title: 'T', description: 'D' });
  assert.ok(!html.includes('rel="canonical"'));
  assert.ok(!html.includes('og:image'));
});

test('injectSSR replaces the shell title/description and injects meta + view content', () => {
  const shell = `<html><head><title>Old</title><meta name="description" content="old" /></head><body><main id="view" class="view"></main></body></html>`;
  const out = ssr.injectSSR(shell, { metaHtml: '<title>New</title>', viewHtml: '<p>hi</p>' });
  assert.ok(!out.includes('Old'));
  assert.match(out, /<title>New<\/title>/);
  assert.match(out, /<main id="view" class="view"><p>hi<\/p><\/main>/);
});

test('injectSSR leaves the view untouched when no viewHtml is given', () => {
  const shell = `<html><head><title>Old</title></head><body><main id="view"></main></body></html>`;
  const out = ssr.injectSSR(shell, { metaHtml: '<title>New</title>' });
  assert.match(out, /<main id="view"><\/main>/);
});

test('profileView renders name, location and escapes injected content (XSS-safe)', () => {
  const html = ssr.profileView({ name: '<b>Evil U</b>', city: 'Paris', country: 'France', short_description: 'desc' });
  assert.ok(!html.includes('<b>Evil U</b>'));
  assert.match(html, /&lt;b&gt;Evil U&lt;\/b&gt;/);
  assert.match(html, /Paris, France/);
});

test('profileView shows a tuition figure only for curated research', () => {
  const curated = ssr.profileView({
    name: 'X', ranking: { world_rank: 5, provider: 'CWUR' }, tuition_source: 'curated_research',
    tuition_range: { min: 0, max: 3000, period: 'year' },
  });
  assert.match(curated, /#5 world/);
  assert.match(curated, /€0–€3,000\/year/);

  // A country-level estimate must NOT render as a number, and must NOT render a
  // "check official site" link in the value slot either — a row that looks
  // answered but isn't. The row is omitted; an honest notice explains why.
  const estimated = ssr.profileView({
    name: 'Y', website: 'https://y.example', source: 'eter',
    tuition_source: 'country_estimate',
    tuition_range: { min: 0, max: 3000, period: 'year', estimated: true },
  });
  assert.ok(!estimated.includes('€3,000'), 'estimate range not displayed');
  assert.ok(!/<dt>Tuition \(intl\)<\/dt>/.test(estimated), 'no tuition row at all when unresearched');
  assert.match(estimated, /have not verified tuition, programs or entry requirements/);
  assert.match(estimated, /official European register/);
});

test('profileView omits the unverified notice on curated profiles', () => {
  const curated = ssr.profileView({
    name: 'X', source: 'curated', tuition_source: 'curated_research',
    tuition_range: { min: 0, max: 3000, period: 'year' },
  });
  assert.ok(!/have not verified tuition/.test(curated));
});

test('directoryView lists universities with links and escapes names', () => {
  const html = ssr.directoryView([{ id: 'a', name: 'A & Z', city: 'X', country: 'Y' }], 100);
  assert.match(html, /href="\/university\/a"/);
  assert.match(html, /A &amp; Z/);
  assert.match(html, /100/);
});
