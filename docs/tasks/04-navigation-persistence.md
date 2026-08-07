# Task 4 — Navigation: URL-based persistence

## Objective
Make filters, search state, and compare selections persist in the URL (query params), and make the last-viewed university retrievable, so back/forward navigation and shared/reloaded links don't lose a student's place.

## Why this matters
A student comparing 3 universities who accidentally hits back, or refreshes, or shares a link with a friend, should not lose their work. This is a retention-relevant reliability fix, and it's a dependency for Task 5 (Continue Where You Left Off pulls from this).

## Investigate first
1. Confirm current behavior: what state is lost today on refresh/back for discover filters, search query, and compare selections?
2. Identify what routing setup exists (React Router or similar) and how query params are currently handled, if at all.

## Build requirements
- Discover/search filters (e.g. country, field of study, whatever exists) reflected in URL query params, and readable back out on load — a copied URL should reproduce the same filtered view.
- Compare selections persisted in the URL (e.g. list of university ids) so a compare view survives refresh and is shareable.
- Last-viewed university stored (URL-based if the profile route already includes an id, otherwise a lightweight persisted value) so Task 5 can read "last thing this student looked at."
- Keep param names short and readable — this is also a mild SEO/shareability win, not just internal plumbing.

## Acceptance criteria
- [ ] Refreshing the discover/search page preserves active filters.
- [ ] Refreshing or reopening a compare view preserves the same universities being compared.
- [ ] A copied URL, opened fresh (e.g. incognito), reproduces the same filtered/compare view.
- [ ] Last-viewed university is retrievable for use in Task 5.
- [ ] Browser back/forward behaves sanely (doesn't skip states or trap the user).

## Out of scope
- The actual "Continue Where You Left Off" UI on Home — that's Task 5. This task only needs to make the underlying state retrievable.
- Any new filter types or search capabilities — only persist what already exists.
