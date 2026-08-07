# Task 3 — Core student flow: fix + visual consistency pass

## Objective
Make register → discover → search → save → compare work reliably end to end, and apply a consistent visual style (spacing, typography, card style) across every screen in that path while you're touching it.

## Why this matters
This is the actual product — the sequence a student from Mongolia goes through to find and compare universities. If any step in this chain is broken or visually inconsistent, nothing else on the roadmap matters. This is also the largest task on the list; expect it may need more than one session even though the rule is "one task per session" — if so, stop at a clean sub-boundary (e.g. discover done, search not started) and log it clearly in the status log rather than leaving things half-wired.

## Known issues to check for (confirm each still applies before fixing — don't assume)
- Discover screen has read as a plain "phonebook-style" list rather than a browsable/scannable university catalogue.
- Two divergent university profile page templates exist — pick one, apply it everywhere, remove the other.
- Missing empty states (e.g. no saved universities yet, no search results) — these should guide the student toward the next action, not just show blank space.

## Investigate first
1. Walk the actual flow yourself (register → discover → search → save → compare) and note every break, dead end, or inconsistency — don't just trust the list above, it may be stale.
2. Identify the two profile templates if they still exist and decide which one is closer to correct, or whether a new shared component is warranted.
3. Check what "visual consistency" means elsewhere in the app already — spacing scale, card radius/shadow, font sizes — so the pass matches, rather than inventing a third style.

## Build requirements
- Fix functional breaks first, then apply the visual pass to whatever you touch.
- Discover and search should let a student browse/filter meaningfully — not just render a raw list. Card-based or similarly scannable layout, consistent with the rest of the app.
- One university profile template, used everywhere a profile is shown.
- Save and compare should work reliably (state persists at least within a session — Task 4 handles URL persistence specifically).
- Add empty states for: no saved universities, no search/filter results, no comparison items yet. Each should suggest a next action (e.g. "Discover universities" button), tying back to the priority filter.
- Fire the relevant analytics events (from Task 2) at each step if not already wired — register, dream created, save, compare.

## Acceptance criteria
- [ ] A new user can go register → discover → search → save → compare without hitting a dead end or broken state.
- [ ] Only one profile template exists in the codebase.
- [ ] Visual style (spacing/typography/cards) is consistent across all screens in this flow.
- [ ] Empty states exist and are tested for: no saves, no search results, no comparisons.
- [ ] Verified in production, not just locally.

## Out of scope
- URL-based persistence of filters/compare state — that's Task 4.
- Home page "continue where you left off" — that's Task 5.
- Admin-facing anything — that's Task 6.
