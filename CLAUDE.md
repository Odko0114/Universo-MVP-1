# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Universo — a mobile-first MVP that helps international students discover and compare universities abroad. Node.js + Express backend, file-based JSON storage, vanilla HTML/CSS/JS frontend (no build step, hash-routed SPA). See [README.md](README.md) for the full feature list, data model, and API reference — don't duplicate that here; this file is about working in the code.

## Commands

```bash
npm install
npm run dev              # node --watch server.js, http://localhost:3000
npm start                # plain run, no watch
npm test                 # node --test --test-concurrency=1 (all tests in test/)
npm run typecheck        # tsc -p jsconfig.json (checkJs over the plain-JS backend)
npm run seed             # rebuild data/universities.json from curated + seed caches
npm run import:eter [year]   # refresh data/seed/eter-universities.json (default year 2022)
npm run import:global    # refresh data/seed/global-universities.json
npm run import:rankings  # refresh data/seed/rankings.json
npm run import:all       # all three imports above
npm run create-admin -- you@example.com   # create/update an /admin account (interactive password prompt)
```

Run a single test file: `node --test test/dataset.test.js`. Node's test runner also supports filtering by name: `node --test --test-name-pattern="apply-click" test/api.test.js`.

CI (`.github/workflows/ci.yml`) runs on Node 20.x and 22.x: `npm ci` → `npm run seed` → `npm test` → `npm run typecheck` → `npm audit --omit=dev --audit-level=high`. The full seed dataset isn't committed (only the cached ETER import is), so tests always run against a freshly built `data/universities.json` — don't assume a stale local `data/universities.json` matches what CI sees; re-run `npm run seed` after touching anything in `data/seed/` or `lib/dataset.js`.

No database and no frontend build step — `data/*.json` (git-ignored except `data/seed/`) is rebuilt from seed files on every boot via `store.initFresh`.

## Architecture

**`server.js`** is a single Express app (~1500 lines) that wires every `lib/` module together. Two route surfaces live in it: page routes (`app.get('/discover')`, `/university/:id`, `/admin`, etc. — mostly server-rendered via `lib/ssr.js`) and a `/api` router (`api.get/post/...`) mounted at the bottom. When looking for a route, `grep -n "^api\.\(get\|post\|delete\|patch\)" server.js` for API endpoints or `grep -n "app\.get("` for pages — the README's API table covers the stable endpoints but server.js has grown ahead of it (email verification flow, student journey/milestones/dream-plan endpoints, university-partner portal login/stats, pilot-lead capture).

**The `lib/store.js` seam is the key architectural boundary.** Every module reads/writes data only through `store.init/read/write/writeDebounced` — never touches `data/*.json` directly. This is deliberate: it's what would let file-based JSON storage be swapped for Postgres/SQLite later without touching route handlers or business logic. Respect this seam when adding persistence — don't reach for `fs` directly in a new module.

**Three data tiers merge into one dataset** (`lib/dataset.js`): curated (`data/seed/universities.js`, 40 hand-built rich profiles) → ETER (European register import, ~3,400) → global (Hipolabs list, ~9,000), deduped by web domain with curated always winning a clash. On top of the merge, `lib/estimates.js` fills country-level tuition/cost/language bands only where no real value exists, and results are tagged by confidence (`real` vs `estimated`) — never invent a per-university fact where only a country-level estimate exists. `lib/data-quality.js` scores/flags records and `data/seed/manifest.json` tracks import provenance (fetch dates, counts, checksums); the `import-*.js` scripts fail loudly on malformed source data rather than silently ingesting it.

**Two completely separate auth systems, by design**: student auth (`lib/auth.js`, cookie `uv_token`) and admin auth (`lib/admin-auth.js`, cookie `uv_admin`) use different stores, different JWT claims, and different middleware (`auth.requireAuth` vs `adminAuth.requireAdmin`), so a compromised student session can never reach `/api/admin/*`. A third, `lib/uni-auth.js` (`requireUni`), gates the university-partner portal (`/api/uni/*`). When adding a protected route, be deliberate about which of the three you're gating with — they are not interchangeable.

**Student "journey" / dream-plan features** (`lib/journey.js`, `lib/explain.js`, `lib/match.js`) compute recommendations and milestone/readiness tracking against a student's saved universities and profile — these are pure functions over the dataset plus stored student state, unit-tested independently of the HTTP layer in `test/*.test.js`.

**Analytics is first-party and PII-free**: every user action becomes a timestamped, anonymized event appended to `data/events.jsonl`; all funnel/retention/traffic aggregation is pure, unit-tested math in `lib/events.js`, surfaced through the `/admin` dashboard. Never attach an email or student id to an event — only the anonymous browser id.

**Frontend has no build step.** `public/js/api.js` is the API client, `public/js/app.js` (~1500 lines) is the SPA's views/router (hash-based routing for client-rendered pages), `public/css/styles.css` is shared by both the landing page and the app. Server-rendered pages (`/discover`, `/university/:id`) get their HTML/meta tags from `lib/ssr.js` for SEO; everything else renders client-side after the shell loads.

**Resilience/ops modules worth knowing about before touching outbound calls or request handling**: `lib/http.js` (timeout + retry + circuit breaker for ETER/Wikipedia/logo fetches — route new outbound calls through this, don't add raw `fetch`), `lib/rate-limit.js` (in-memory sliding-window limiter, applied per-route in server.js), `lib/validate.js` (request-body validation/length-capping), `lib/log.js` (structured JSON logs + the error-capture sink).

## Testing conventions

Tests are plain `node:test` files in `test/`, one per `lib/` module plus `test/api.test.js` for full HTTP round-trips (auth, save/unsave, export, delete, admin isolation). New `lib/` logic should get a matching `test/<name>.test.js`. Tests that touch storage use a temp/isolated data dir rather than the real `data/` — follow the existing pattern in `test/store.test.js` / `test/api.test.js` rather than pointing tests at the real seeded dataset.
