# Task 8 — Launch prep

## Objective
SEO metadata/sitemap, custom domain, Google Search Console setup, performance pass (Lighthouse), and accessibility basics. This is the final roadmap item before treating Universo as launch-ready for real pilot traffic.

## Why this matters
Everything before this builds the product; this task makes it findable and not embarrassingly slow or broken for a first real visitor, including university staff evaluating it for the B2B pilot.

## Build requirements — SEO
- Meta titles/descriptions per key page (home, discover, individual university profiles at minimum) — real content, not generic boilerplate repeated everywhere.
- `sitemap.xml` generated (ideally dynamically for university profile pages) and `robots.txt` present.
- Submit sitemap via Google Search Console; verify domain ownership.

## Build requirements — Domain
- Point custom domain at the Render deployment (replacing `universo-bmkg.onrender.com` as the primary public URL).
- HTTPS working correctly on the custom domain.
- Old `.onrender.com` URL should redirect if reasonably easy, or at least not be the one shared going forward.

## Build requirements — Performance
- Run Lighthouse on the key pages (home, discover, profile) and fix anything scoring poorly on Performance — common culprits: unoptimized images, render-blocking scripts, oversized JS bundles.
- Don't chase a perfect 100 — target "no obvious embarrassing slowness," especially on discover/search given it's the highest-traffic page.

## Build requirements — Accessibility basics
- This is basics only (per the deferred list — full screen reader support is explicitly out of scope): sufficient color contrast, alt text on meaningful images, form inputs properly labeled, keyboard-reachable primary actions (register, search, save, compare buttons).

## Acceptance criteria
- [ ] Key pages have unique, real meta titles/descriptions.
- [ ] Sitemap live and submitted to Search Console; robots.txt present and correct.
- [ ] Custom domain is the live production URL with working HTTPS.
- [ ] Lighthouse Performance score reasonable on home/discover/profile (no major regressions from obvious fixable issues).
- [ ] Contrast, alt text, form labels, and keyboard access checked on the core student flow pages.

## Out of scope
- Full screen reader support / ARIA overhaul — explicitly deferred.
- Any new features — this task is polish and infrastructure only.
