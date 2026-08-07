# Task 5 — Continue Where You Left Off + progress indicator

## Objective
On Home, show a returning student their last visited page/state, and a basic progress indicator (profile completion %, saved count) — so coming back the next day feels like continuing, not starting over.

## Why this matters
This is the "come back tomorrow and feel progress" half of the priority filter. It's explicitly not gamification (no streaks/badges/notifications — those are deferred) — it's just making existing state visible and resumable.

## Dependency
Requires Task 4 (URL-based persistence / last-viewed university) to already be working. Verify that's actually true before starting, per the session-start protocol.

## Build requirements
- Home page shows a "Continue" element for returning users pointing at their last meaningful state — last-viewed university, last search/filter, or last compare view, whichever is most recent and reconstructable from Task 4's persisted state.
- Basic progress indicator: profile completion percentage (based on whatever profile fields exist) and saved-universities count. Keep the calculation simple and transparent — no hidden scoring logic.
- Should degrade gracefully for a brand-new user with no history — don't show a broken or empty "continue" card; show the empty state / call-to-action instead (consistent with Task 3's empty-state work).
- Fire an analytics event when a user engages with the continue element, so Task 7 can eventually use it.

## Acceptance criteria
- [ ] A returning user with prior activity sees a working "continue" link/card to their actual last state.
- [ ] A brand-new user sees an appropriate empty/first-time state instead, not a broken continue card.
- [ ] Progress indicator numbers are correct and update as the student saves items / completes profile fields.
- [ ] No streaks, badges, or notification logic introduced — flag to the user (Odko) if you're tempted to add one, don't just do it.

## Out of scope
- Any gamification. This is explicitly deferred — see CLAUDE.md's deferred list.
- Admin-facing views of this data — Task 6 is separate and admin-only.
