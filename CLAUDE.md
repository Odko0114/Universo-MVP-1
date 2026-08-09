# Universo — Build Plan & Context

## Session start protocol

At the start of every session, before I ask you anything:

1. Read this file, including the status log at the bottom.
2. State which roadmap item is next (first unchecked box).
3. Open the linked task file for that item (`docs/tasks/0N-*.md`) — that file is the master prompt with full detail. Read it fully before proposing anything.
4. Verify the *previous* item is actually true — don't trust the checkbox blindly. Spot-check the codebase for evidence it was really done (e.g. if item 1 is checked, confirm the fix is actually in the code, not just marked complete).
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

Animations/microinteractions beyond consistency pass, retention gamification (streaks/badges/reminders), scroll restoration, product/search analytics dashboards, founder morning-brief dashboard, screen reader support, architecture refactors, viral loops/partnerships, competitive benchmarking UI.

## Status log

(Update after each session — one line: date, item number, what shipped, any issue found.)

<!-- 2026-08-07 | Item 0 | Repo restructured: CLAUDE.md split into index + per-task master prompts under docs/tasks/. No code changed. -->

2026-08-09 | Item 1 | Already fixed in an earlier session — verified in production with raw curl: all admin provisioning endpoints 401, no admin logic in shipped JS, login still works. No code changed. Residual: an HTML comment in the /admin shell still mentions where provisioning is documented (cosmetic, not a hole).

2026-08-09 | Item 2 | Marked NOT APPLICABLE. Task premise was false — this deploys on Render's paid Starter tier with a 1GB persistent disk at /var/data, not ephemeral free-tier storage (proven: the photo cache survived a redeploy with 130 pre-existing entries). No Supabase exists to migrate to; it would be a new dependency. Its other three acceptance criteria (survives restart, non-blocking writes, anonymous capture) are already met by the current design. Revisit when scaling past one instance or when SQL access is needed — lib/store.js is the seam.

2026-08-09 | Item 3a | Shipped /compare: side-by-side comparison of saved universities, the missing last step of the core flow (journey.js previously linked "compare" to /saved, a list). Gaps render "Not verified" rather than blank, since an empty cell next to Tuition reads as free. Sticky attribute column, table scrolls in its own container. Two empty states (0 saved, 1 saved). Fires a compare event (count only, anonymous).

2026-08-09 | Item 3b | SSR profile brought to parity with the client view: added living cost, application deadline and fields of study. Found and fixed an honesty inconsistency — the crawlable page rendered estimated living cost and teaching language as plain facts while the client marked them "est."/"typical", so the page Google indexes was the less honest of the two. Affects all 300 indexed profiles.
