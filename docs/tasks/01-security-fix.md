# Task 1 — Security fix: exposed admin provisioning command

## Objective
Remove or properly secure the admin provisioning command/endpoint that is currently exposed in unauthenticated HTML, so it cannot be triggered or discovered by anyone who isn't an authenticated admin.

## Why this is first
Everything else on the roadmap assumes the app isn't trivially exploitable. This is a live production hole — it ships before any feature work, including analytics.

## Investigate first (do this before proposing a fix)
1. Search the codebase for where admin provisioning is triggered — likely a route, a client-side button/script, or an API endpoint reachable without auth.
2. Confirm exactly how it's exposed: is it rendered in page HTML/JS bundle for anonymous users, is the API endpoint missing an auth check, or both?
3. Check whether it's ever been called by someone other than the founders (review logs/DB if accessible) — this affects urgency but not scope.
4. Report findings back before touching code: where it lives, what it does, and the minimal fix.

## Fix requirements
- The provisioning action must require server-side verification of an authenticated admin session — not a client-side check, not a hidden URL, not a shared secret in the frontend bundle.
- No admin-only logic, routes, or credentials should be present in any unauthenticated HTML/JS response.
- If the mechanism was a one-off bootstrap (e.g. "make the first user admin"), replace it with something that can't be re-triggered post-setup, or gate it behind an environment variable only set during initial deploy.
- Do not silently leave a backdoor "for convenience" — if you're unsure whether removing something breaks legitimate admin setup, flag it and ask rather than leaving it reachable.

## Acceptance criteria
- [ ] Provisioning endpoint/command returns 401/403 for any unauthenticated request (verify with a raw curl/fetch, not just "the button is hidden").
- [ ] No trace of the admin provisioning logic appears in the rendered HTML or shipped JS for a logged-out user (check page source / network tab, not just the UI).
- [ ] Existing legitimate admin access still works after the fix.
- [ ] Change is deployed to production and re-verified there, not just locally.

## Out of scope
- Building a full admin auth system (roles, permissions UI) — that's not this task. Just make sure this specific hole is closed using whatever auth mechanism already exists.
- Any other unauthenticated API endpoints you notice — note them for a future task, don't fix them here unless they're part of this exact same exposure path.
