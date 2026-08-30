# Storage migration path (file JSON → SQLite / Postgres)

## Where we are

Runtime data lives in `lib/store.js`: one JSON file per collection under
`UNIVERSO_DATA_DIR`, an in-memory cache, and atomic write-temp-then-rename. The
app only ever touches four methods — this is the seam:

- `store.read(name)` → the whole collection (array), served from cache
- `store.write(name, value)` → replace + persist (chained per file)
- `store.writeDebounced(name, value)` → coalesced persist for hot paths
- `store.flushAll()` → persist pending debounced writes on shutdown

Collections: `students` (the only large user collection), plus `clicks`,
`events`, `photos`, `uni_accounts`, `admins`, `pilot_leads`.

**Documented ceilings** (`store.js:20-22`): single process, whole-collection
locking, and an ephemeral filesystem loses data across deploys unless
`UNIVERSO_DATA_DIR` is a persistent volume. Today it runs on one Render instance
with a 1 GB disk — fine. The retention scheduler (`lib/notify.js`, `server.js`)
also assumes a single instance.

## Why we are NOT migrating now

The `store.read/write` API is **synchronous** and used in dozens of request
handlers (`const students = store.read("students"); …mutate…; store.write(...)`).
A real database is asynchronous, so a swap forces `async/await` through every
call site at once — a large, risky change with no current payoff at this scale.
Deferred deliberately. Do it when: a second instance is needed, the students
file grows past comfortable whole-file rewrites (~tens of MB), or SQL/analytics
access is wanted.

## The low-risk path when the time comes: SQLite via better-sqlite3

`better-sqlite3` is **synchronous**, so `store.read/write` keep their exact
signatures — the seam stays; only the body of `lib/store.js` changes. No call
site outside `lib/store.js` needs to change.

1. Add `better-sqlite3`. Create the DB at `UNIVERSO_DATA_DIR/universo.db`.
2. Model each collection as a table `kv(name TEXT PRIMARY KEY, value TEXT)` for a
   drop-in first pass (value = JSON blob) — `read` = `JSON.parse(SELECT value)`,
   `write` = `INSERT OR REPLACE`. This is the smallest change and keeps the
   whole-collection semantics. (Real per-row tables come later, per collection,
   only where query access is actually needed — start with `students`.)
3. Migrate data once: on boot, if the JSON files exist and the DB is empty, load
   each file into its row. Keep the JSON files as a backup for one release.
4. `writeDebounced` maps to a periodic flush or a WAL-mode write; `flushAll`
   becomes a checkpoint/no-op.
5. Drop the single-instance caveat once per-row writes replace whole-file writes.

## Postgres (only if going multi-instance / managed)

Postgres is async — this is the larger change: `store.*` become `async`, and
every call site awaits. Do this only when horizontal scale is real. At that
point also move the retention scheduler (`server.js` in-process timer) to a
single worker or external cron so digests don't fan out per instance.

## Call sites to touch (for either migration)

Only `lib/store.js` for the SQLite drop-in. For Postgres, additionally every
`store.read`/`store.write`/`store.writeDebounced` caller — grep:
`grep -rn "store\.\(read\|write\|writeDebounced\|flushAll\)" server.js lib/`.
