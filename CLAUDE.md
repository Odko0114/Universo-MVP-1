# Universo — Build Plan & Context

## Session start protocol

At the start of every session, before I ask you anything:

1. Read this file, including the status log at the bottom.
2. State which roadmap item is next (first unchecked box).
3. Open the linked task file for that item (`docs/tasks/0N-*.md`) — that file is the master prompt with full detail. Read it fully before proposing anything.
4. Verify the _previous_ item is actually true — don't trust the checkbox blindly. Spot-check the codebase for evidence it was really done (e.g. if item 1 is checked, confirm the fix is actually in the code, not just marked complete).
5. If the previous item looks incomplete, flag it and stop — don't start new work on top of an unverified fix.
6. If it checks out, propose the next task in one sentence (pulled from the task file's Objective) and wait for my go-ahead before touching code.

Do this unprompted, every session, without me asking "what's next."

## Priority filter for every decision

Before building anything, ask: can a student from Mongolia who wants to study in Finland —

- Discover universities?
- Compare them?
- Save favorites?
- Create a dream?
- See what to do next?
- Come back tomorrow and continue?
- Feel they're making progress?

If a task doesn't move one of these forward, it's not next.

## Rules for this repo

- One task per session. Implement it, I test it manually, then commit. Do not bundle multiple roadmap items into one prompt.
- Do not start the next item until the current one is confirmed working in production, not just locally.
- Do not add features not on this list without explicit approval — especially anything gamification-shaped (streaks, badges, notifications).
- When touching a screen for a roadmap item, apply consistent spacing/typography/card style while you're in that code. Don't schedule a separate "polish pass."
- Task files under `docs/tasks/` are the source of truth for scope on that item. If something feels missing from a task file, flag it before starting rather than improvising.

## Roadmap (in order — do not reorder without discussion)

- [ ] 1. **Security fix** — remove/secure the exposed admin provisioning command → [`docs/tasks/01-security-fix.md`](docs/tasks/01-security-fix.md)
- [ ] 2. **Analytics infra** — move event writes from ephemeral disk to Supabase; basic event tracking (no dashboard yet) → [`docs/tasks/02-analytics-infra.md`](docs/tasks/02-analytics-infra.md)
- [ ] 3. **Core student flow** — fix + apply visual consistency pass: register → discover → search → save → compare → [`docs/tasks/03-core-student-flow.md`](docs/tasks/03-core-student-flow.md)
- [ ] 4. **Navigation** — URL-based filter/compare persistence, last-viewed university → [`docs/tasks/04-navigation-persistence.md`](docs/tasks/04-navigation-persistence.md)
- [ ] 5. **Continue Where You Left Off** — last visited page/state on Home, basic progress indicator (profile %, saved count) → [`docs/tasks/05-continue-where-left-off.md`](docs/tasks/05-continue-where-left-off.md)
- [ ] 6. **Admin dashboard** — Overview (DAU/WAU/MAU, new vs returning) + Funnel (Visitor → Register → Dream → Save → Compare → Apply) only → [`docs/tasks/06-admin-dashboard.md`](docs/tasks/06-admin-dashboard.md)
- [ ] 7. **Next Best Action** — design using real funnel data from step 6, not guesses → [`docs/tasks/07-next-best-action.md`](docs/tasks/07-next-best-action.md)
- [ ] 8. **Launch prep** — SEO metadata/sitemap, custom domain, Search Console, performance (Lighthouse), accessibility basics → [`docs/tasks/08-launch-prep.md`](docs/tasks/08-launch-prep.md)

## Explicitly deferred (do not build until revisited)

Animations/microinteractions beyond consistency pass, retention gamification (streaks/badges/reminders), product/search analytics dashboards, founder morning-brief dashboard, screen reader support, architecture refactors, viral loops/partnerships, competitive benchmarking UI.

## Status log

(Update after each session — one line: date, item number, what shipped, any issue found.)

<!-- 2026-08-07 | Item 0 | Repo restructured: CLAUDE.md split into index + per-task master prompts under docs/tasks/. No code changed. -->

2026-08-09 | Item 1 | Already fixed in an earlier session — verified in production with raw curl: all admin provisioning endpoints 401, no admin logic in shipped JS, login still works. No code changed. Residual: an HTML comment in the /admin shell still mentions where provisioning is documented (cosmetic, not a hole).

2026-08-09 | Item 2 | Marked NOT APPLICABLE. Task premise was false — this deploys on Render's paid Starter tier with a 1GB persistent disk at /var/data, not ephemeral free-tier storage (proven: the photo cache survived a redeploy with 130 pre-existing entries). No Supabase exists to migrate to; it would be a new dependency. Its other three acceptance criteria (survives restart, non-blocking writes, anonymous capture) are already met by the current design. Revisit when scaling past one instance or when SQL access is needed — lib/store.js is the seam.

2026-08-09 | Item 3a | Shipped /compare: side-by-side comparison of saved universities, the missing last step of the core flow (journey.js previously linked "compare" to /saved, a list). Gaps render "Not verified" rather than blank, since an empty cell next to Tuition reads as free. Sticky attribute column, table scrolls in its own container. Two empty states (0 saved, 1 saved). Fires a compare event (count only, anonymous).

2026-08-09 | Item 3b | SSR profile brought to parity with the client view: added living cost, application deadline and fields of study. Found and fixed an honesty inconsistency — the crawlable page rendered estimated living cost and teaching language as plain facts while the client marked them "est."/"typical", so the page Google indexes was the less honest of the two. Affects all 300 indexed profiles.

2026-08-09 | Item 4 | Discover filters were already fully URL-backed (verified, not assumed) — a cold URL reproduces the filtered view. Added the two real gaps: /compare?ids=a,b,c so a comparison survives refresh AND opens for someone without an account (acceptance criteria say "incognito", which forces this), and last-viewed university in localStorage for Task 5. Unknown ids drop out of a shared link rather than breaking it. Kept replaceState for filter changes: back then leaves the page instead of unwinding filters one at a time. readLastViewed() is intentionally unused until Task 5.

2026-08-20 | Item 8 (partial) | Performance + accessibility basics — the half of launch prep that isn't blocked on the domain. Measured first: payloads already lean (gzip on, fonts subsetted, JS 30KB/CSS 15KB gzip, ~82ms domInteractive), and a11y already had lang/alt/labels/skip-link/aria-live/focus-visible/reduced-motion. Three real gaps fixed: (1) static assets were cache-control max-age=0, forcing a revalidation round-trip per asset every visit — fonts now immutable/1yr, CSS+JS 300s, HTML no-cache; (2) --ink-faint muted text failed WCAG AA contrast (3.4 vs 4.5) — darkened #7a879b -> #616e82 (4.82), fixes all muted text + field labels at once; (3) heading order skipped h1->h3 on Discover logged-out — added an sr-only "Search results" h2. Domain/Search Console half of item 8 still blocked on the purchase. Also fixed forgot-password lying when email is dormant (separate commit) — now reports delivery:"unavailable" and points at join.universo@gmail.com instead of "check your email"; self-reverts when RESEND_API_KEY is set.

2026-08-09 | Item 6 | Overview panel added (DAU/WAU/MAU with a new-vs-returning split, over distinct anon ids — "new" = first-ever event inside the window, judged against the whole log so a short window can't make everyone look new). Funnel re-pointed from visit/search/profile_view/save/apply_click to the six stages the roadmap specifies: Visitor -> Register -> Dream -> Save -> Compare -> Apply. All six events already existed; nothing fabricated. Spot-checked the Overview numbers against a raw recomputation of events.jsonl — exact match. DEVIATION, agreed with Odko: the acceptance criterion "no panels beyond these two" was NOT applied. Deleting retention/traffic/search-terms/data-quality/leads would remove working tooling earlier items built deliberately, and University leads is the only place a B2B enquiry surfaces. Caveat: at 6 signups the funnel is directionally meaningless until real traffic arrives.

2026-08-09 | Item 5 | REDEFINED after Odko clarified: navigation/state restoration, not a resume card. Removed the wrongly-built "pick up where you left off" card. Root cause of lost scroll was that renderDiscover called loadResults() WITHOUT awaiting it, so the view's promise resolved while only 6 skeletons were on screen (~4000px) and the real list (~26000px) arrived after — every restore attempt, the browser's own included, got clamped to the top. Fix: await loadResults so "rendered" means "painted", take scrollRestoration = manual, stash the offset on the history entry when leaving, re-apply once painted. Retries use setTimeout, NOT requestAnimationFrame — rAF is frozen in a hidden/background tab, which also silently defeated my earlier verification. Verified at 600 / 2400 / 3000 / 5200px, across profile->profile->back->back, with filters+sort intact and scrolling continuing normally afterwards. Un-defers "scroll restoration" at Odko's request.

2026-08-09 | Item 3 | DEVIATION from the acceptance criteria, deliberate: "Only one profile template exists" is NOT met, and I recommend it stays that way. The two templates serve different jobs (crawlable HTML vs interactive) and merging them needs a shared module across the CommonJS/browser boundary — this repo has no build step, and architecture refactors are on the deferred list. The real risk was drift, which is not hypothetical (see 3b). Closed instead with parity tests in test/ssr.test.js that fail if a fact, section or honesty marker exists in one template and not the other; verified by breaking each template in turn and confirming the tests catch it. Revisit if a build step ever arrives for another reason.
