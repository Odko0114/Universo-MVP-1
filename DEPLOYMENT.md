# Deploying Universo

The app is a single Node process with file-based storage — no external database
to provision. The one hard requirement: **runtime data must live on a
persistent volume**, or every deploy/restart wipes student accounts and
analytics.

## The one concept that matters

Two kinds of data, two locations:

| Kind                                                             | Where                     | Persistence                                        |
| ---------------------------------------------------------------- | ------------------------- | -------------------------------------------------- |
| **Seed data** (`data/seed/*` — universities, rankings, manifest) | Ships with the code/image | Read-only input; updated by committing new imports |
| **Runtime data** (accounts, clicks, events, photo/logo caches)   | `UNIVERSO_DATA_DIR`       | Must be a persistent volume in production          |

`UNIVERSO_DATA_DIR` must point **outside the repo tree** (e.g. `/var/data`).
Mounting a volume at the repo's own `data/` would hide the seed files baked
into the image. The universities dataset itself is derived and rebuilt from
seeds at every boot, so it never goes stale on the volume.

## Option A — Render (recommended, ~10 minutes)

1. Push this repository to GitHub.
2. Render dashboard → **New → Blueprint** → select the repo. `render.yaml`
   provisions the service, the 1 GB disk at `/var/data`, a generated
   `UNIVERSO_JWT_SECRET`, and the `frankfurt` region automatically — set that
   before your first deploy, not after: Render has no in-place region change,
   so fixing it later means standing up a second service and cutting over
   (see the comment above the `region:` line in `render.yaml`).
3. Before the first deploy, add two env vars in the dashboard:
   `ADMIN_EMAIL` and `ADMIN_PASSWORD` (10+ chars). The first boot creates your
   admin account from them.
4. Deploy. Verify:
   - `https://<your-app>.onrender.com/healthz` → `{"status":"ok",…}`
   - `/` shows the landing page; `/admin` accepts your admin login.
5. **Remove `ADMIN_EMAIL`/`ADMIN_PASSWORD`** from the env vars (one-time
   bootstrap; they're ignored once an admin exists, but secrets shouldn't
   linger in config).

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
- [ ] Persistent volume mounted at `UNIVERSO_DATA_DIR` (server also refuses to
      boot in production without this var set at all, so a missing volume
      fails loudly at startup instead of silently writing into the image)
- [ ] Region set correctly for your users before the first deploy — see the
      note in `render.yaml`; it can't be changed in place later
- [ ] Admin account created; bootstrap env vars removed
- [ ] `/healthz` wired to the host's health check
- [ ] HTTPS termination at the platform edge (Render/Fly do this automatically)
- [ ] After first deploy: sign up a test account, save a university, restart
      the service, confirm the account survived — this proves the volume works
- [ ] Watch structured logs (`level:"error"`) — `lib/log.js#captureError` is
      the single hook point when you add Sentry or similar

## Custom domain cutover

Do this in order. The ordering is the point: `UNIVERSO_APP_URL` is the switch
that turns the old hostname into a redirect, and turning it on before the
domain actually resolves will send every visitor somewhere that doesn't answer.

**1. Buy the domain.** Any registrar. Nothing else here depends on which.

**2. Point it at Render.** Render dashboard → your service → Settings → Custom
Domains → add both `universo.tld` and `www.universo.tld`. Render shows the DNS
records to create at your registrar (an ALIAS/ANAME or A record for the apex, a
CNAME for `www`). Wait until Render marks the domain **verified** and issues its
TLS certificate — usually minutes, occasionally an hour.

**3. Confirm it serves before switching anything.**

```bash
curl -sI https://universo.tld/healthz | head -1     # expect: HTTP/2 200
```

Only continue once that returns 200. Until step 4 the site answers on both
hostnames, which is fine and expected.

**4. Set `UNIVERSO_APP_URL`** on the Render service to the exact origin, no
trailing slash — e.g. `https://universo.tld`. This is the switch. From the next
deploy onward:

- canonical tags, `og:url`, `sitemap.xml` and `robots.txt` all advertise this
  one origin no matter which hostname served the request
- GET/HEAD requests arriving on `*.onrender.com` 301 to the real domain, so the
  old address stops competing with the new one for the same content
- password-reset and verification links are built from it rather than from the
  request's `Host` header

Pick apex or `www` and be consistent — whichever you set here is the one Google
will index.

**5. Verify the switch took.**

```bash
curl -s https://universo.tld/sitemap.xml | head -3          # <loc> uses the new domain
curl -sI https://universo-XXXX.onrender.com/discover | head -2   # expect: 301 + Location
curl -s https://universo.tld/university/aarhus | grep canonical  # new domain
```

**6. Turn email on.** It has been built and dormant this whole time, waiting on
a verified sending domain.

- Resend → add `universo.tld` as a sending domain → add the DKIM/SPF records it
  gives you at your registrar → wait for **verified**
- Set `RESEND_API_KEY` on the Render service

The server refuses to boot in production with `RESEND_API_KEY` set but
`UNIVERSO_APP_URL` missing — that combination would email people links built
from a spoofable `Host` header, so it fails loudly instead. Setting them in the
order above avoids it.

Then register a real test account and confirm the verification email arrives
and its link works.

**7. Submit to Google.** Not before now — indexing the `.onrender.com` host
first means 301s, re-crawling and split signals later.

- Search Console → add `https://universo.tld` as a property → verify (the DNS
  TXT method reuses the registrar you're already in)
- Sitemaps → submit `sitemap.xml` (302 URLs: 300 verified profiles, `/discover`,
  `/for-universities`)
- Ask for indexing on `/discover` and `/for-universities` directly to prime it

**Rollback.** Unset `UNIVERSO_APP_URL`. The redirect goes dormant, every URL
falls back to the request host, and the site keeps serving on both. Nothing here
is one-way.

## What this setup does NOT handle yet

Single process, file-based storage: fine for validating the product, not for
horizontal scaling. The storage layer is a deliberate seam (`lib/store.js`) —
swap for Postgres/SQLite when real traffic arrives. Rate limits are in-memory
(per instance). Backups = snapshotting the volume; Render's disk has daily
snapshots on paid plans.
