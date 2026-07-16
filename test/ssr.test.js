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

test('profileView includes ranking and tuition facts when present', () => {
  const html = ssr.profileView({
    name: 'X', ranking: { world_rank: 5, provider: 'CWUR' },
    tuition_range: { min: 0, max: 3000, period: 'year', estimated: true },
  });
  assert.match(html, /#5 world/);
  assert.match(html, /est\./);
});

test('directoryView lists universities with links and escapes names', () => {
  const html = ssr.directoryView([{ id: 'a', name: 'A & Z', city: 'X', country: 'Y' }], 100);
  assert.match(html, /href="\/university\/a"/);
  assert.match(html, /A &amp; Z/);
  assert.match(html, /100/);
});
