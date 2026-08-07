# Task 2 — Analytics infra: Supabase event writes

## Objective
Move event tracking off ephemeral disk storage and onto Supabase, so events survive deploys/restarts. No dashboard yet — this is pure plumbing that steps 6 and 7 will depend on.

## Why this matters
Render's free tier disk is ephemeral — every restart/redeploy wipes it, so any analytics currently written to disk is already partially lost. Step 6 (admin dashboard) and step 7 (Next Best Action) are both worthless without a durable, queryable event log. Get this right now rather than retrofitting it later.

## Investigate first
1. Find where events are currently written (disk file, in-memory, log lines — whatever it is).
2. List which events currently exist or are needed to support the funnel defined in Task 6: Visitor → Register → Dream → Save → Compare → Apply.
3. Check current Supabase schema/tables to see what's already there.

## Build requirements
- Create a Supabase table for events — minimum columns: event name, user id (nullable for anonymous), session/anonymous id, timestamp, and a flexible metadata field (jsonb) for event-specific properties.
- Instrument writes for at least the funnel-relevant events: visit, register, dream created, save (favorite), compare, apply-click. Add any others already fired elsewhere in the app — don't remove existing tracking, just relocate it.
- Writes should not block or slow down the user-facing action they're attached to (fire-and-forget or async; a failed analytics write must never break the actual feature).
- Handle both authenticated and anonymous users — a visitor who hasn't registered yet still needs to be tracked (use a session/anonymous id, reconcile with user id after registration if straightforward, otherwise note it as a known gap).

## Acceptance criteria
- [ ] Events land in Supabase, not disk — verified by triggering each event type and checking the table directly.
- [ ] Restarting/redeploying the app does not lose previously written events (this is the whole point — actually test it).
- [ ] No user-facing action is measurably slower or breaks if the analytics write fails.
- [ ] Anonymous (pre-registration) activity is captured, not just logged-in users.

## Out of scope
- No dashboard, no charts, no admin UI — that's Task 6.
- No Next Best Action logic — that's Task 7 and depends on real data existing first.
- Don't over-engineer the schema for events you don't need yet; keep it extensible (jsonb metadata) rather than exhaustive.
