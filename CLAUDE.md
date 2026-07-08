# CLAUDE.md — Scoreboard Live

> Architecture, deploy knowledge, and operational notes for the
> `scoreboard-live` project. The next agent (Claude/Cursor/Aider/etc.)
> should read this fully before touching code or running anything on
> the VPS. **Live at https://scoreboard.dctraders.co.in** since 2026-07-09.

---

## 1. What this is

Self-hosted **football** and **cricket** scoreboard overlays for
**OBS Studio**. One operator scores from a phone/tablet; OBS shows a
transparent browser-source overlay that updates in real time over
WebSocket. Sticky **per-match secret control links** (no multi-user SaaS).

Tiny stack: Node 20+, Express, Socket.IO, better-sqlite3, vanilla JS
front-end, no build step.

---

## 2. Architecture

### 2.1 Single-container layout (production)

```
┌────────────────────────── VPS 187.127.153.248 ──────────────────────────┐
│                                                                       │
│  nginx (host)          scoreboard.dctraders.co.in                      │
│    │  (port 80 + 443, TLS via LE)                                     │
│    │                                                                  │
│    ▼                                                                  │
│  docker proxy  ─►  scoreboard-live container                          │
│                       127.0.0.1:3102 → 3102                           │
│                       (image: scoreboard-live:latest)                 │
│                       (user:  uid 1000 = node)                        │
│                       (data:  /data bind-mount → host ./data)         │
│                                                                       │
│  cron (root)         20 2 * * * /usr/local/bin/backup-scoreboard.sh    │
│    │                     → /var/backups/scoreboard-FOO.db (14d rot.)  │
│    │                                                                  │
│  certbot.timer       auto-renews LE cert ≤60d before expiry           │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component files (repo root)

| File | Role |
|---|---|
| `server/index.js` | Express bootstrap + Socket.IO server + REST routes. **Read this first.** |
| `server/db.js` | SQLite schema + queries (WAL mode). Tables: `teams`, `players`, `matches`, `events`. `tournaments`, `tournamentTeams`, `tournamentMatches`, `sponsors`. |
| `server/sockets.js` | Socket.IO handshake (auth via `matchId`+`token?`), action dispatch, state broadcast. |
| `server/auth.js` | `ADMIN_PASSWORD` env check + HMAC-signed session cookie. |
| `server/sports/football.js` | Pure reducer — clock, periods, goals, cards, shootout. |
| `server/sports/cricket.js` | Pure reducer — ball-by-ball, extras, wickets, strike rotation, FOW, target/RRR. |
| `server/tournament.js` | Standings computation over a tournament's matches. |
| `public/` | Vanilla-JS front-end. `admin/` (login + matches + tournaments), `control/` (operator per sport), `overlay/` (OBS per sport). |
| `data/` (gitignored) | SQLite db + uploaded team crests + sponsor images + session secret file. Bind-mount in production. |
| `Dockerfile` | `node:20-bookworm-slim`, prod deps only, `uid 1000 (node)`, HEALTHCHECK via `/api/me`. |
| `docker-compose.yml` | Binds `./data:/data`, exposes `${PORT:-3100}:${PORT:-3100}` on `127.0.0.1`. |
| `deploy/install-vps.sh` | One-shot idempotent VPS installer — see §5. |
| `deploy/backup-scoreboard.sh` | Daily SQLite `.backup` + 14d retention; env-overridable paths. |
| `deploy/nginx.conf.example` | Two-block template (HTTP→HTTPS + HTTPS→proxy), cert paths templated to `$DOMAIN` and `${PORT}`. |
| `deploy/DEPLOY.md` | Long-form deploy guide; Docker path is primary, bare-Node archived. |

### 2.3 Event sourcing model

Every scoring action is a row in `events(match_id, seq, type, payload, at)`.
**Current state = `replay(config, events)`**. Undo = `delete last event + replay`.
Reducers must be **pure and deterministic** — they read `event.at`, never
`Date.now()`.

Per-sport reducer lives in `server/sports/<sport>.js`. Don't change one
without re-running `npm test` (35 reducer tests).

### 2.4 Persistence + concurrency

Single SQLite DB with **WAL mode**, bind-mounted from
`/var/www/scoreboard-live/data/scoreboard.db` on the host. Multiple
operators / OBS browser sources concurrently: SQLite serialises writes
but readers don't block — Socket.IO broadcasts the new state the moment
the event is committed.

### 2.5 Auth model

| Surface | Gate |
|---|---|
| `/api/*` admin routes | signed cookie `sb_admin`, HMAC over `data/secret` |
| Overlay (`/overlay/:id`) | public read |
| Control (`/control/:id`) | `?token=` query param checked at Socket.IO handshake |

No multi-user / RBAC by design.

---

## 3. Local dev (off the VPS)

```bash
git clone https://github.com/atanukgt/ScoreBoard.git
cd scoreboard-live        # ⚠️ space in dir name on Mac: "Score board Live"
npm install
npm test                  # 35 reducer tests, ~1s
npm start                 # http://localhost:3100
# or:
cp .env.example .env && docker compose up -d --build
docker compose logs -f
docker compose down       # data/ on host is preserved
```

`/admin/` → log in → create 2 teams → create match → copy control URL
to phone → score → overlay URL into OBS Browser Source (1920×1080,
transparent).

---

## 4. Configuration

All via env (`EnvironmentFile=` style; docker compose via `.env`):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3100` | container + host-loopback port. **Don't use 3100 on the VPS** — see §5.2. |
| `ADMIN_PASSWORD` | `changeme` | **must change in prod.** Server logs a warning on every start if default. |
| `DATA_DIR` | `/data` | SQLite + crests + secret live here. Container path stays `/data`; host path is `/var/www/scoreboard-live/data`. |
| `CORS_ORIGINS` | (any) | optional whitelist for Socket.IO. Use the public domain + `"null"` for OBS local-file embed. |
| `NODE_ENV` | `production` | silences dev warnings. |

`/etc/letsencrypt/live/scoreboard.dctraders.co.in/fullchain.pem` and
`privkey.pem` are referenced directly from the nginx vhost (managed by
certbot).

---

## 5. Production deploy

### 5.1 One-shot (current)

Run on the VPS as root:

```bash
ssh root@187.127.153.248
cd /var/www
[[ -d scoreboard-live ]] || git clone https://github.com/atanukgt/ScoreBoard.git scoreboard-live
cd scoreboard-live
git pull --ff-only origin main             # keep up to date
cp .env.example .env
$EDITOR .env                                # set ADMIN_PASSWORD
bash deploy/install-vps.sh                  # does everything else:
                                            #   - bumps PORT 3100 → 3102 if collision
                                            #   - docker compose build + up
                                            #   - waits HEALTHCHECK
                                            #   - drops real nginx vhost, kills ACME temp
                                            #   - installs backup script + cron
                                            #   - skips certbot if cert already exists
                                            #   - reloads nginx
```

Flags:

```
--domain=foo.bar     override the domain (default scoreboard.dctraders.co.in)
--app-dir=/srv/sb    override the install path (default /var/www/scoreboard-live)
--email=ops@x.com    Let's Encrypt registration email
--port=3105          override detected port (skip the collision bump)
--no-nginx           install Docker app only, skip nginx/certbot
```

### 5.2 Port-collision rules on this VPS — read first

The Hostinger KVM at `187.127.153.248` already runs 12 docker containers.
**Always verify the port you're picking is free:**

```bash
ssh root@187.127.153.248 'ss -ltn "( sport = :NEWPORT )" 2>/dev/null | grep :NEWPORT'
```

Known occupied loopback ports (audit 2026-07-08):

| Port | Owner |
|---|---|
| 3000 | dc-website |
| 3002 | dc-traders |
| 3100 | **interviewpro-web-1** ← leave alone |
| 3101 | **interviewpro-api-1** ← leave alone |
| 5432 | interviewpro-postgres-1, dealermitra-saas-db-1 (internal) |
| 6379 | interviewpro-redis-1 (internal) |
| 8080 | dealermitra-saas-web-1 (public) |
| 8090 | dc-events |
| 8092 | papertrading-dashboard |
| 9119 | hermes (public) |

The installer auto-bumps `PORT=3100` → `3102` (the next free slot in
3102–3199) to dodge 3100/3101. Test the bump limit: max retries in
the loop is `3199`, beyond which it dies and asks for `--port=`.

### 5.3 The cert dance when the app isn't up yet

If you ever issue a cert **before** the container is up (e.g.
scoreboard.dctraders.co.in needs DNS but the deploy needs the cert), you
need a temporary ACME-only nginx vhost because the real vhost's
`proxy_pass http://127.0.0.1:3102;` would fail nginx -t with "host not
found in upstream".

```nginx
# /etc/nginx/sites-available/scoreboard-live-acme.conf
server {
    listen 80;
    listen [::]:80;
    server_name scoreboard.dctraders.co.in;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$host$request_uri; }
}
```

`certbot --nginx --non-interactive --agree-tos -m $EMAIL \
  -d scoreboard.dctraders.co.in --redirect` will issue the cert and
leave the cert paths in the rewritten vhost.

Then `install-vps.sh` does **two things** to clean up:

1. `rm /etc/nginx/sites-enabled/scoreboard-live-acme.conf` — without
   this the alphabetical-first match (acme before live) keeps
   capturing HTTPS, the real vhost's `proxy_pass` never runs.
2. Skip re-running certbot if
   `/etc/letsencrypt/live/$DOMAIN/fullchain.pem` already exists — LE
   allows only 5 duplicate certs/wk per domain; issuing a 2nd time
   burns a rate-limit slot for nothing.

### 5.4 Updating after a code change

```bash
ssh root@187.127.153.248
cd /var/www/scoreboard-live
git pull                                  # or rsync
docker compose build                       # rebuild image
docker compose up -d                       # re-create container
docker compose logs -f app                 # tail
```

Bind-mount means the SQLite DB on the host survives. The event log is
replayed on every restart, so in-progress matches are recovered
exactly.

---

## 6. Operations

### 6.1 Common commands

| Want | Run |
|---|---|
| Tail app logs | `cd /var/www/scoreboard-live && docker compose logs -f` |
| Restart | `cd /var/www/scoreboard-live && docker compose restart` |
| Update code | see §5.4 |
| Tail backup log | `tail -f /var/log/scoreboard-backup.log` |
| List backups | `ls -la /var/backups/scoreboard-*.db` |
| Restore (off-hours) | `cp /var/backups/scoreboard-YYYY-MM-DD.db /var/www/scoreboard-live/data/scoreboard.db && docker compose restart` |
| Renew cert dry-run | `certbot renew --dry-run` |
| Force re-issue cert | `certbot certonly --force-renewal -d scoreboard.dctraders.co.in` then reload nginx |
| Check cert expiry | `openssl x509 -enddate -noout -in /etc/letsencrypt/live/scoreboard.dctraders.co.in/fullchain.pem` |

### 6.2 Disaster notes

- **The VPS has no PM2** anymore — `pm2 stop all` is from a prior era
  when `dc-website` was PM2; it's a docker container now. Don't run
  PM2 commands.
- **`docker compose` is per project dir.** Never run `docker compose`
  in the wrong project dir — `down` against the wrong `-f` (or
  `docker rm -f <name>` with a typo) can take out the wrong container.
- **`/var/www/dealermitra-saas` and the others stay untouched.** Read
  `/usr/local/bin/backup-scoreboard.sh` if you're poking the cron.

### 6.3 Backup details

| Item | Value |
|---|---|
| Source | `/var/www/scoreboard-live/data/scoreboard.db` (bind-mounted from container) |
| Script | `/usr/local/bin/backup-scoreboard.sh` (0755, root:root) |
| Cron | `20 2 * * *` (24:50 UTC) — staggered between dealermitra PG (02:00) and dc-traders rclone (01:00) |
| Log | `/var/log/scoreboard-backup.log` |
| Dest dir | `/var/backups/scoreboard-YYYY-MM-DD.db` |
| Retention | 14 days (`RETENTION_DAYS` env to override) |
| Mechanism | SQLite `.backup` (online API, safe vs concurrent writers) |

When the source DB doesn't exist yet (fresh deploy, no traffic yet),
the script logs `skip: source DB … does not exist yet` and exits 0 — no
cron spam.

---

## 7. Gotchas / lessons learned (today's deploy)

| # | Symptom | Root cause | Fix (also in the script) |
|---|---|---|---|
| 1 | Container fails with `Bind for 127.0.0.1:3100 failed: port already allocated` even after `.env` says `PORT=3102` | `docker-compose.yml` had `"127.0.0.1:3100:${PORT:-3100}"` — only the **container side** was templated, host side hardcoded to 3100. | template both sides: `"127.0.0.1:${PORT:-3100}:${PORT:-3100}"` |
| 2 | `certbot --nginx` re-issues a cert even though one is already on disk | certbot's `--nginx` re-runs the issuance flow | guard with `if [[ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]]` |
| 3 | After pre-issuing cert, HTTPS still loops on itself | the temporary ACME vhost I dropped has `location / { return 301 https://… }`. certbot's rewrite keeps that `location /` directive inside the **HTTPS server block** too, so HTTPS→301→HTTPS loops | `install-vps.sh` writes a clean two-block vhost (HTTP redirect + HTTPS proxy) and removes the acme-temp one |
| 4 | `certbot: Another instance of Certbot is already running.` when re-running | lock at `/var/log/letsencrypt/.certbot.lock` (NOT `/var/lock/` as I assumed). | if the lock is stale: `pkill -9 -f certbot; rm -f /var/log/letsencrypt/.certbot.lock` |
| 5 | `docker-compose build` succeeds but container can't start because port 3100 (interviewpro-web-1) holds it | section §5.2 above | collision detection in `install-vps.sh` walks 3102..3199 |
| 6 | `npm test` reports `tests 0, suites 0` inside the production image | `.dockerignore` excludes `test/` to slim the image | if you need tests in the container, mount or volume-bind `test/` from the host |

---

## 8. Decisions captured today (2026-07-09)

- **Vanilla JS, no build step** — pre-existing choice; preserves zero
  on-disk cost for the front-end, makes OBS-side browser source
  snappy. Don't reach for React/Vite without an explicit reason.
- **SQLite over Postgres** — single-operator app; SQLite's online
  backup is enough; no DB-as-a-service round-trip latency for a
  WebSocket-broadcast state machine.
- **One process, one container** — Node app serves both HTTP and
  Socket.IO on the same port; no nginx in the container; let the
  host's nginx terminate TLS (host already has LE wired). Keeps the
  image small (~360 MB) and the security opt tight.
- **Port 3102 = scoreboard-live's slot** on this VPS. Don't change
  without first checking interviewpro hasn't been retired.
- **ADMIN_PASSWORD** env is the only thing gating `/admin/` — no
  rate-limiting, no 2FA. Acceptable for single-operator, internal VPS
  use only.

---

## 9. Open items / future work

- No mobile app — operator uses phone browser. Add-to-home-screen
  is the only documented gesture.
- Cricket extras are limited to `wd/nb/b/lb`. No super-over / DLS.
  Operators end innings manually with `endInnings`.
- Football shootout is a manual log; UI auto-rotates home/away.
- Backup is on-host; no off-host copy. Consider adding rclone to
  the same R2 bucket dc-traders uses once the next session has time.
- No structured auth audit log — only the event log.

---

## 10. Cross-references

- **Session-specific narrative:** `HANDOFF.md` (gitignored). Read
  that for the day-by-day of the most recent deploy session.
- **Long-form deploy guide:** `deploy/DEPLOY.md` (Docker-first).
- **VPS-wide project inventory + port rules:** see
  `~/.mavis/memory/user.md` for the cross-project inventory and
  pitfalls.
- **Per-project ops notes for next agent sessions:**
  `~/.mavis/agents/mavis/memory/scoreboard-live.md`.
