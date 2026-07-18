# Deploying Universo

The app is a single Node process with file-based storage — no external database
to provision. The one hard requirement: **runtime data must live on a
persistent volume**, or every deploy/restart wipes student accounts and
analytics.

## The one concept that matters

Two kinds of data, two locations:

| Kind | Where | Persistence |
|---|---|---|
| **Seed data** (`data/seed/*` — universities, rankings, manifest) | Ships with the code/image | Read-only input; updated by committing new imports |
| **Runtime data** (accounts, clicks, events, photo/logo caches) | `UNIVERSO_DATA_DIR` | Must be a persistent volume in production |

`UNIVERSO_DATA_DIR` must point **outside the repo tree** (e.g. `/var/data`).
Mounting a volume at the repo's own `data/` would hide the seed files baked
into the image. The universities dataset itself is derived and rebuilt from
seeds at every boot, so it never goes stale on the volume.

## Option A — Render (recommended, ~10 minutes)

1. Push this repository to GitHub.
2. Render dashboard → **New → Blueprint** → select the repo. `render.yaml`
   provisions the service, the 1 GB disk at `/var/data`, and a generated
   `UNIVERSO_JWT_SECRET` automatically.
3. Before the first deploy, add two env vars in the dashboard:
   `ADMIN_EMAIL` and `ADMIN_PASSWORD` (10+ chars). The first boot creates your
   admin account from them.
4. Deploy. Verify:
   - `https://<your-app>.onrender.com/healthz` → `{"status":"ok",…}`
   - `/` shows the landing page; `/admin` accepts your admin login.
5. **Remove `ADMIN_EMAIL`/`ADMIN_PASSWORD`** from the env vars (one-time
   bootstrap; they're ignored once an admin exists, but secrets shouldn't
   linger in config).

## The /join page

`/join` (the two-sided student-waitlist / university-pilot page) is a
separate React + Tailwind build under `join-app/`, not part of the main
vanilla-JS app. It has to be built before the server can serve it:

```bash
npm --prefix join-app ci
npm run build:join     # outputs to public/join, which server.js serves at /join
```

`render.yaml`'s `buildCommand` and the `Dockerfile` both already do this — if
you're deploying some other way, don't forget this step, or `/join` will
return a 503 telling you it hasn't been built.

## Option B — Docker (Fly.io, Railway, a VPS…)

```bash
docker build -t universo .
docker run -d -p 3000:3000 \
  -v universo-data:/data \
  -e UNIVERSO_JWT_SECRET="$(openssl rand -hex 32)" \
  -e ADMIN_EMAIL=you@example.com \
  -e ADMIN_PASSWORD='a strong password' \
  universo
```

The image sets `UNIVERSO_DATA_DIR=/data`; mount your volume there.

## Production checklist

- [ ] `UNIVERSO_JWT_SECRET` set to a stable value (server refuses to boot in
      production without it — random-per-boot would log everyone out on restart)
- [ ] Persistent volume mounted at `UNIVERSO_DATA_DIR`
- [ ] Admin account created; bootstrap env vars removed
- [ ] `/healthz` wired to the host's health check
- [ ] HTTPS termination at the platform edge (Render/Fly do this automatically)
- [ ] After first deploy: sign up a test account, save a university, restart
      the service, confirm the account survived — this proves the volume works
- [ ] Watch structured logs (`level:"error"`) — `lib/log.js#captureError` is
      the single hook point when you add Sentry or similar

## What this setup does NOT handle yet

Single process, file-based storage: fine for validating the product, not for
horizontal scaling. The storage layer is a deliberate seam (`lib/store.js`) —
swap for Postgres/SQLite when real traffic arrives. Rate limits are in-memory
(per instance). Backups = snapshotting the volume; Render's disk has daily
snapshots on paid plans.
