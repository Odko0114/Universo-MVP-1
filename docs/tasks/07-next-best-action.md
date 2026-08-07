# Task 7 — Next Best Action

## Objective
Design and build a "Next Best Action" suggestion for students, driven by the real funnel data from Task 6 — e.g. if a student has saved universities but never compared, suggest comparing; if they've compared but not applied, surface that.

## Why this matters
This is where the funnel data actually becomes useful to the student, not just to the admin. It's also the most likely place to accidentally reintroduce gamification (streak framing, notification nudges) — stay disciplined about scope; this is a single contextual suggestion, not a notification system.

## Dependency
Requires Task 6's funnel data to be real and reasonably populated (even a small amount of usage). If there isn't enough data yet to see where students actually drop off, say so rather than inventing a "next best action" logic based on assumptions.

## Investigate first
1. Pull the actual funnel drop-off pattern from Task 6's data — where do students most commonly stall (e.g. many save, few compare)?
2. Decide the suggestion logic based on that real pattern, not a guess. Document the reasoning briefly in a comment or the status log.

## Build requirements
- A single, contextual suggestion shown somewhere sensible (Home, or the relevant screen) based on the student's own state — e.g. "You've saved 3 universities — compare them" or "You compared 2 universities — see what's next to apply."
- Logic should be simple, rule-based, and traceable to real funnel stages — not a black-box scoring model.
- No push notifications, emails, or streak-style framing — this is an in-app, in-context suggestion only.
- Fire an analytics event when shown and when acted on, so this loop can itself be measured later.

## Acceptance criteria
- [ ] Suggestion shown is genuinely based on the student's real state (saved/compared/applied counts, etc.), not hardcoded.
- [ ] Suggestion logic is documented (comment or status log) with the funnel reasoning behind it.
- [ ] No notification/email/gamification mechanism introduced.
- [ ] Verified with at least one real test account moving through the flow, confirming the suggestion changes as their state changes.

## Out of scope
- Any ML/scoring model — rule-based only for now.
- Notifications or emails of any kind.
