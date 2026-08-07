# Task 6 — Admin dashboard: Overview + Funnel only

## Objective
Build an admin-only dashboard with exactly two panels: Overview (DAU/WAU/MAU, new vs returning) and Funnel (Visitor → Register → Dream → Save → Compare → Apply). Nothing else.

## Why this matters
This is the first real payoff of Task 2's analytics plumbing, and it's also the data source Task 7 (Next Best Action) depends on. Scope discipline matters here — it's tempting to add more panels; don't. The roadmap explicitly defers product/search analytics dashboards and founder morning-brief dashboards.

## Dependency
Requires Task 2 (Supabase event writes) to be genuinely working in production — verify real events exist in the table, not just that the code was written, before starting.

## Build requirements
- Route/page accessible only to authenticated admins (reuse whatever auth exists post-Task-1 fix — do not build a new auth mechanism).
- **Overview panel**: DAU, WAU, MAU computed from the events table; new vs returning user split for a selected period.
- **Funnel panel**: counts and conversion rates at each stage — Visitor → Register → Dream → Save → Compare → Apply — using the actual event names wired in Task 2. If any funnel stage's event doesn't exist yet, flag it rather than fabricating a number.
- Reasonable default time range (e.g. last 30 days) with the ability to adjust if trivial to add — don't over-build the date picker.
- Numbers should be verifiably correct — spot-check a couple against raw Supabase queries before calling this done.

## Acceptance criteria
- [ ] Dashboard is unreachable by non-admins (verify with a logged-out or non-admin session, not just hidden nav).
- [ ] Overview panel shows DAU/WAU/MAU and new-vs-returning, matching a manual spot-check against Supabase.
- [ ] Funnel panel shows all six stages with real counts, not placeholders.
- [ ] No panels beyond these two exist on this dashboard.

## Out of scope
- Next Best Action logic — Task 7, and it should read from this same funnel data rather than duplicating queries.
- Any other analytics view (search analytics, founder brief, etc.) — explicitly deferred.
