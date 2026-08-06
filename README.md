# Universo 🎓

A mobile-first MVP that helps **international students discover and compare universities abroad**.

Browse and search **12,000+ universities worldwide**, filter by country / institution type / field / budget / language / degree, view detailed profiles, save a shortlist to your account, and click through to each university's official website. The MVP exists to prove students will use a discovery tool — so the core funnel (**sign-ups, searches, saves, Apply-Now clicks**) is easy to observe.

### Three tiers of data (merged, deduped by web domain)

| Tier        | Count  | Source                                                                              | What it has                                                                                        |
| ----------- | ------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Curated** | 40     | Hand-built (`data/seed/universities.js`)                                            | Full profiles: tuition, programs, admission requirements, deadlines, languages, degree levels      |
| **ETER**    | ~3,400 | [European Tertiary Education Register](https://eter-project.com) v4 API             | European register facts: city, coordinates, type, legal status, founding year, enrollment, website |
| **Global**  | ~9,000 | [Hipolabs world universities list](https://github.com/Hipo/university-domains-list) | Worldwide breadth: name, country, region, website/domain                                           |

Total ≈ **12,500 universities across ~199 countries**. Priority on a domain clash is **curated → ETER → global**, so each university appears once, at its richest: a European university keeps its ETER detail, the rest of the world gets solid basics, and the 40 curated profiles always win.

### Per-university enrichment (so every profile has something)

On top of the three tiers, every university is enriched at build/serve time — always **clearly labeled by confidence**:

| Field                               | How it's filled                                                                           | Confidence                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Degree levels & majors (fields)** | Derived from ETER's real enrollment-by-level (ISCED 6/7) and field-of-education data      | **Real** (European ~3,400)                                                             |
| **Ranking (world + national)**      | Matched to the open **CWUR** dataset by name + country                                    | **Real**, but only the ~top 2,000 exist anywhere; the rest are honestly "unranked"     |
| **Tuition, living cost, language**  | Country-level typical bands (`lib/estimates.js`), applied only where no real value exists | **Estimate** — tagged `estimated`, shown with `~` / "est." / "typical" + a verify note |
| **Overview**                        | Wikipedia article extract, fetched lazily and cached (like photos)                        | **Real** where a Wikipedia page exists                                                 |

**Images (work for every university, worldwide):** a **logo** derived from the university's website domain (via `icons.duckduckgo.com`, with an initials-on-gradient fallback), plus a **cover photo from Wikipedia** on each profile — fetched lazily and cached in `data/photos.json`, so photos load only for universities people actually open (no upfront calls for 12,000 schools).

---

## Quick start

```bash
npm install
npm run dev
```

Then open:

- **App:** http://localhost:3000
- **Funnel metrics:** http://localhost:3000/admin

`npm run dev` uses Node's built-in `--watch` (restarts on file changes). Use `npm start` for a plain run. On first launch the server seeds `data/universities.json` from the combined dataset (curated + the cached ETER import in `data/seed/eter-universities.json`) automatically — **no network needed** to run the app.

To **refresh the imported data** from the live sources (each writes a seed file, then re-seed):

```bash
npm run import:eter        # ETER register → data/seed/eter-universities.json (year 2022 by default)
npm run import:eter -- 2021 #   …or a specific reference year
npm run import:global      # global list → data/seed/global-universities.json
npm run import:rankings    # CWUR world+national ranks → data/seed/rankings.json
npm run import:all         # all three of the above
npm run seed               # rebuild data/universities.json (merge + enrich: estimates, rankings)
```

> Requires Node.js 18+ (developed on Node 24). No database or build step needed. The app runs offline from the cached seed files; only the `import:*` scripts and the lazy Wikipedia cover photos need internet.

---

## Tech stack

| Layer    | Choice                                                                      |
| -------- | --------------------------------------------------------------------------- |
| Backend  | Node.js + Express                                                           |
| Storage  | File-based JSON (`/data/*.json`) via a small caching store (`lib/store.js`) |
| Auth     | Email + password (bcrypt-hashed) with JWT bearer tokens                     |
| Frontend | Plain HTML/CSS/JS SPA (hash routing) — **no build step**                    |

Vanilla frontend was chosen over React deliberately: for an MVP of this size it keeps the whole thing runnable with a single `npm install` and zero build tooling, which is easier to trust and hand off.

---

## Project layout

```
Universo/
├── server.js                      # Express app: routes, wires lib/ modules together
├── lib/
│   ├── config.js                  # env-driven config, validated once at boot
│   ├── store.js                   # file-based JSON store (cache, debounced/atomic writes)
│   ├── dataset.js                 # merges curated + ETER + global into one deduped dataset
│   ├── search.js                  # pure search/filter/sort over a prebuilt index
│   ├── auth.js                    # student cookie-session auth
│   ├── admin-auth.js              # admin cookie-session auth (fully separate from students)
│   ├── events.js                  # PII-free event log + funnel/retention/traffic aggregation
│   ├── validate.js                # request-body validation
│   ├── rate-limit.js              # in-memory sliding-window limiter
│   ├── http.js                    # outbound fetch with timeout/retry/circuit-breaker
│   ├── ssr.js                     # server-rendered meta tags + content for SEO
│   ├── manifest.js                # provenance/quality-gate tracking for data imports
│   └── log.js                     # structured JSON logging + error sink
├── data/
│   ├── seed/universities.js       # 40 curated universities (rich data, source of truth)
│   ├── seed/eter-universities.json    # ETER import cache (generated by import:eter)
│   ├── seed/global-universities.json  # global import cache (generated by import:global)
│   ├── seed/rankings.json             # rankings cache (generated by import:rankings)
│   ├── seed/manifest.json             # import provenance (fetch dates, counts, checksums)
│   └── *.json, events.jsonl           # live runtime data (generated on first run; git-ignored)
├── scripts/
│   ├── seed.js                    # (re)build universities.json from all sources
│   ├── import-eter.js             # fetch + map the ETER register
│   ├── import-global.js           # fetch + map the global universities list
│   ├── import-rankings.js         # fetch + map university rankings
│   └── create-admin.js            # create/update an admin account for /admin
├── test/                          # node --test unit + API integration tests
├── jsconfig.json, types/          # TypeScript checkJs config for the plain-JS backend
└── public/                        # frontend (no build step)
    ├── landing.html                # marketing homepage (/) — static, no JS, shares styles.css
    ├── index.html                 # app shell (bottom tabs on mobile, top nav on desktop)
    ├── admin.html                 # admin dashboard — login-gated (/admin)
    ├── css/styles.css             # navy / teal / gold, mobile-first (landing + app share this file)
    └── js/{api.js, app.js}        # API client + SPA views/router
```

### Routing

| Path                             | What it is                                                                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                              | Marketing landing page (`landing.html`, static). A visitor with a valid session is redirected straight to `/discover` — no re-selling returning students.                                                         |
| `/discover`                      | The actual search/browse tool — **requires an account** (anonymous visitors are redirected to sign-up with a `next` back-link; the bounce is recorded as a `gate` event). Server-rendered for logged-in students. |
| `/university/:id`                | Server-rendered profile page.                                                                                                                                                                                     |
| `/saved`, `/account`, `/privacy` | SPA routes (client-rendered). `/account?mode=register` opens straight to the sign-up tab.                                                                                                                         |
| `/admin`                         | Login-gated admin dashboard, entirely separate auth from student accounts.                                                                                                                                        |

---

## Core features

1. **University Directory** — searchable list (name, acronym, city, program keywords) across 3,400+ institutions, with filters for country, institution type, field of study, tuition budget, language of instruction, and degree level; sorting (name / largest / lowest tuition / most popular); and paginated "Load more".
2. **University Profile** — overview, key facts, real logo + Wikipedia cover photo, a **Save/Bookmark** button, and an **Apply Now** button that opens the official site in a new tab **and** increments an anonymous `click_count` (no personal data attached). Curated profiles add programs, admission requirements, tuition & living costs, and deadlines; ETER profiles show register facts and note that the rest lives on the official site.
3. **Sign-up / Login** — email + password (bcrypt), JWT auth, profile fields (name, country of origin, field of interest, target degree level). Sign-up requires an explicit, **not pre-ticked** consent checkbox referencing a placeholder privacy policy.
4. **Saved / Bookmarks page** — the logged-in student's shortlist, tied to their account.

### Out of scope (intentionally not built)

Short-form video feed, student-to-student chat/networking, and lead-capture forms that send personal data to universities.

---

## Measuring success — admin dashboard, traffic & behavior

`/admin` is a **password-protected** dashboard (separate admin login — see [Admin setup](#admin-setup)) showing:

- **Stat cards & rolling windows** — sign-ups, searches, saves, Apply-Now clicks (raw + deduplicated-unique), pageviews, students, last-24h/7d breakdowns.
- **Acquisition funnel** — distinct clients reaching Visit → Search → View a profile → Save → Apply, each stage as a % of the first stage, over a selectable 7/14/30-day window.
- **Traffic** — unique visitors, pageviews, top pages, top referrer domains, device split (mobile/desktop), all first-party (no third-party analytics script, no cookie-consent banner needed).
- **Weekly retention** — a cohort grid: of the clients first seen in a given week, what % came back in each following week.
- **Top search terms** and **top universities by Apply-Now clicks / by profile views**.

This is powered by a first-party, **PII-free** event log (`data/events.jsonl`) — every action is a timestamped event (`{ ts, type, anon, … }`) tied to a random anonymous browser id, never an email. It's the same log a warehouse or product-analytics tool would ingest; the aggregation (funnel/retention/traffic math) lives in pure, unit-tested functions in `lib/events.js`.

### Admin setup

The dashboard has **no default account** — create one before `/admin` is usable. Pass only the email; the script prompts for the password interactively with echo suppressed, so it never lands in shell history or `ps` output:

```bash
npm run create-admin -- you@example.com
```

Or set `ADMIN_EMAIL` + `ADMIN_PASSWORD` in the environment before the **first** boot (auto-creates one admin if none exist yet). If the dev server is already running when you create an admin via the CLI, **restart it** — the in-memory store only reads `data/admins.json` at boot.

The `/admin` sign-in page deliberately does **not** describe this on-page (it's a public URL, even if login-gated) — this README is the source of truth for admin provisioning.

---

## API reference

| Method            | Endpoint                            | Auth | Purpose                                                                                                                                                                    |
| ----------------- | ----------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`            | `/api/auth/register`                | —    | Create account (requires `consent: true`); sets httpOnly session cookie                                                                                                    |
| `POST`            | `/api/auth/login`                   | —    | Log in; sets httpOnly session cookie (rate-limited)                                                                                                                        |
| `POST`            | `/api/auth/logout`                  | —    | Clear the session cookie                                                                                                                                                   |
| `GET`             | `/api/auth/me`                      | ✅   | Current student                                                                                                                                                            |
| `GET`             | `/api/universities`                 | —    | List/search/filter/paginate (`q, country, region, type, field, language, degree, source, maxTuition, sort, offset, limit`; `region=EU` filters to the 27 EU member states) |
| `GET`             | `/api/universities/filters`         | —    | Distinct filter values (countries, institution types, fields, languages, degrees)                                                                                          |
| `GET`             | `/api/universities/:id`             | —    | University profile                                                                                                                                                         |
| `POST`            | `/api/universities/:id/apply-click` | —    | Record an anonymous apply-click (rate-limited)                                                                                                                             |
| `GET`             | `/api/universities/:id/photo`       | —    | Lazy Wikipedia cover photo + attribution + overview extract (cached)                                                                                                       |
| `GET`             | `/api/logo?domain=`                 | —    | Cached logo proxy (no third-party hotlinking)                                                                                                                              |
| `GET`             | `/api/me/saved`                     | ✅   | Saved universities                                                                                                                                                         |
| `POST` / `DELETE` | `/api/me/saved/:id`                 | ✅   | Save / unsave                                                                                                                                                              |
| `GET`             | `/api/me/recommendations?limit=`    | ✅   | "Recommended for you" — weighted match against the student's profile (see `lib/match.js`); excludes already-saved universities                                             |
| `GET`             | `/api/me/export`                    | ✅   | **GDPR:** download all stored account data                                                                                                                                 |
| `DELETE`          | `/api/me`                           | ✅   | **GDPR:** permanently delete the account **and its linked behavioral event history**                                                                                       |
| `POST`            | `/api/track`                        | —    | First-party analytics beacon (`pageview` \| `profile_view` \| `filter_used`); rate-limited, no PII accepted                                                                |
| `POST`            | `/api/admin/login`                  | —    | Admin sign-in (separate cookie/session from student auth; rate-limited)                                                                                                    |
| `POST`            | `/api/admin/logout`                 | —    | Clear the admin session                                                                                                                                                    |
| `GET`             | `/api/admin/me`                     | 🔐   | Current admin                                                                                                                                                              |
| `GET`             | `/api/admin/stats`                  | 🔐   | Totals, 24h/7d windows, top universities by clicks & by views                                                                                                              |
| `GET`             | `/api/admin/funnel?days=`           | 🔐   | Visit→search→view→save→apply funnel with conversion %                                                                                                                      |
| `GET`             | `/api/admin/retention?weeks=`       | 🔐   | Weekly cohort retention grid                                                                                                                                               |
| `GET`             | `/api/admin/traffic?days=`          | 🔐   | Visitors, pageviews, top pages/referrers/devices                                                                                                                           |
| `GET`             | `/api/admin/searches?days=&limit=`  | 🔐   | Most common search terms                                                                                                                                                   |
| `GET`             | `/healthz`                          | —    | Health check (status, dataset size, uptime)                                                                                                                                |
| `GET`             | `/sitemap.xml`, `/robots.txt`       | —    | SEO                                                                                                                                                                        |

✅ = requires a student session · 🔐 = requires an **admin** session (separate login, see [Admin setup](#admin-setup))

---

## ⚠️ Data accuracy — read before any public launch

**Curated data** (`data/seed/universities.js`) uses **real** names, countries, cities, and best-effort **official application links**, but:

- **Tuition, living costs, deadlines, and admission requirements are realistic estimates, not verified facts.** They change yearly and differ for EU/EEA vs. non-EU students.
- Every record carries **`data_verified: false`**, and the app shows a visible "verify before you rely on this" banner on each profile.

**ETER data** is official register data (names, cities, types, enrollment, websites are reliable), but:

- It reflects a **reference year** (2022 by default) — enrollment counts and even institution status may have changed since.
- ETER's standardized institution categories are applied as-is; a handful of institutions may sit in a bucket you'd classify differently.

**Global data** (Hipolabs) is community-maintained public data:

- Names, countries and domains are generally good but **unverified**, and it carries no city, type, or enrollment — only the basics. Some entries may be stale or duplicated.

**Estimates (tuition / living cost / language):** these don't exist per-university at global scale, so they're **country-level typical bands**, not per-institution facts. Every estimated value is tagged and shown with `~` / "est." / "typical" and a verify note. A university with unusual fees (private, specialised) will often differ.

**Rankings:** real world + national rank from **CWUR**, but only ~2,000 universities are ranked by anyone — the rest show nothing (we don't invent a number). National rank is CWUR's within-country rank (i.e. among ranked peers). Name-based matching means a few may be mis-joined or missed.

**Overviews & images (all tiers):** overviews and cover photos come from **Wikipedia**, matched by name — heuristic, so a wrong article/image is possible, and the long tail of small institutions has none. Logos come through a caching proxy over a favicon service and may occasionally be blank/low-res (initials fallback).

**Verify figures, links, and images against each university's official page before showing this to real students.** Re-seed at any time with `npm run seed`; refresh ETER with `npm run import:eter`.

---

## Quality & operations

| Area               | What's in place                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tests**          | `npm test` — Node's built-in runner: 52 tests covering search/dedup/validation/enrichment logic, a full student API round-trip (auth, save, export, delete), admin auth (login/session/isolation from student sessions), and the funnel/retention/traffic/purge analytics math.                                                                                                                      |
| **Types**          | `npm run typecheck` — TypeScript `checkJs` over the backend (no build step) catches wrong arg counts, bad property access, and typos.                                                                                                                                                                                                                                                                |
| **Auth**           | Passwords bcrypt-hashed and never returned. Student and **admin sessions are fully separate** — different cookies (`uv_token` / `uv_admin`), different stores, different JWT claims — so a compromised student session can never reach `/api/admin/*`. Both are **httpOnly, SameSite, Secure-in-prod cookies** (not `localStorage`), with a per-user `token_version` for student-session revocation. |
| **Input**          | Every request body validated and length-capped (`lib/validate.js`); JSON body limit of 16 kB.                                                                                                                                                                                                                                                                                                        |
| **Rate limiting**  | In-memory sliding-window limits on login/register, admin login, apply-clicks, the tracking beacon, photo lookups, and the logo proxy (`lib/rate-limit.js`).                                                                                                                                                                                                                                          |
| **Analytics**      | Append-only, PII-free event log (pageviews, profile views, filters, search, save, apply-click) with deduplicated, time-windowed, funnel, retention, and traffic aggregation — all pure/unit-tested functions in `lib/events.js`.                                                                                                                                                                     |
| **Privacy (GDPR)** | Explicit consent, data **export**, **account deletion**, no PII in logs, and deleting an account **purges its linked anonymous event trail** (not just the account row) — see `DELETE /api/me`.                                                                                                                                                                                                      |
| **Resilience**     | All outbound calls (ETER, Wikipedia, logos) go through a timeout + retry + circuit-breaker helper (`lib/http.js`); photos/logos are cached; concurrent first-lookups are de-duped.                                                                                                                                                                                                                   |
| **Observability**  | Structured JSON logs with request ids (`lib/log.js`), a `/healthz` endpoint, and graceful shutdown that flushes pending writes.                                                                                                                                                                                                                                                                      |
| **SEO**            | Server-rendered `<title>`/description/Open-Graph tags and content for `/discover` and every `/university/:id`, plus a static, crawlable `/` landing page, `sitemap.xml`, and `robots.txt`.                                                                                                                                                                                                           |
| **Data pipeline**  | Imports validate the fetched shape and **fail loudly** on junk, and write a provenance manifest (`data/seed/manifest.json`) with counts, checksums, and fetch dates.                                                                                                                                                                                                                                 |

## Configuration

| Env var                          | Default               | Notes                                                                                                                                                                                                                                            |
| -------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                           | `3000`                | HTTP port                                                                                                                                                                                                                                        |
| `NODE_ENV`                       | —                     | Set to `production` to require a stable secret and mark cookies `Secure`.                                                                                                                                                                        |
| `UNIVERSO_JWT_SECRET`            | random per boot (dev) | **Required in production** (boot fails without it). A random dev secret signs everyone out on restart and can't be shared across instances.                                                                                                      |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | —                     | If set and no admin exists yet, auto-creates one admin account on boot. Otherwise use `npm run create-admin -- email` (prompts for the password).                                                                                                |
| `UNIVERSO_DATA_DIR`              | `./data`              | Where runtime data (accounts, clicks, events, caches) lives. In production, point at a **persistent volume outside the repo tree** — see [DEPLOYMENT.md](DEPLOYMENT.md). Seed data (`data/seed/*`) always ships with the code and is unaffected. |
| `LOG_LEVEL`                      | `info`                | `debug` \| `info` \| `warn` \| `error`.                                                                                                                                                                                                          |

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** — a Render blueprint (`render.yaml`) and a `Dockerfile` are included; the only hard requirement is a persistent volume for `UNIVERSO_DATA_DIR`. The universities dataset is derived and rebuilt from seed files at every boot (`store.initFresh`), so deploys always serve current data while accounts and analytics persist on the volume.

## Architecture & the road to production

Logic lives in small modules under `lib/` (`auth`, `admin-auth`, `search`, `store`, `events`, `ssr`, `http`, `validate`, `rate-limit`, `manifest`, `config`, `log`), wired together by `server.js`. The `lib/store.js` repository seam is the key boundary: the app only calls `init/read/write/writeDebounced`, so the file-based JSON store can be swapped for **Postgres/SQLite** without touching route handlers.

Two things are deliberately left as infra choices rather than code:

- **Database.** The store's hot-path writes are now coalesced (a click never rewrites the 12k-record file; "last active" is throttled), and shutdown flushes cleanly — but a host with an **ephemeral filesystem won't persist data across restarts**, and a single process can't scale horizontally. Move to a database before real traffic; the seam makes it localized.
- **Managed services.** Error monitoring routes through one `log.captureError` sink (wire Sentry there), and the in-memory rate limiter swaps for Redis when you run more than one instance.

## License

MIT
