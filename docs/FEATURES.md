# Scoreboard Live — FEATURES

Evidence-grounded inventory of the current self-hosted football + cricket scoreboard. Citations are `file:line`. Three tasks have landed recently: **card animations** (cardLog + lastCard + overlay banner), **tournament leaderboard** (CRUD + standings + overlay), **sponsor/ad overlays** (CRUD + 6-position rotating banner). Audit date 2026-07-08.

## What's already built

### Auth (`server/auth.js`, `server/index.js:27-40`)
- HMAC-signed session cookie `sb_admin` persisted in `data/secret` (`server/auth.js:7-23`), survives restart.
- Constant-time password compare (`server/index.js:30`).
- `HttpOnly + SameSite=Lax`, 180-day (`server/index.js:33`). Default-password warning on boot (`server/auth.js:14-16`).
- Per-match control token (16-byte hex), checked in Socket.IO handshake (`server/db.js:81`, `server/sockets.js:47`).

### Persistence (`server/db.js`, 208 lines)
- SQLite + WAL (`server/db.js:10-11`). Append-only event log → state = replay (`server/db.js:38-46`).
- Schema: `teams`, `players`, `matches`, `events`, `tournaments`, `tournament_teams`, `tournament_matches`, `sponsors` (lines 13-76).
- DAO helpers for all 8 tables (lines 78-206). Match config snapshots team names/colors/crests/players at creation (`server/index.js:88-98`).
- Crest upload as base64 dataURL, png/jpeg/svg/webp ≤2 MB (`server/index.js:72-85`).

### Football reducer (`server/sports/football.js`, 152 lines)
- Pure/deterministic (`event.at`, never `Date.now()`). Periods: `PRE, 1H, HT, 2H, FT, ET1, ETB, ET2, AET, PENS` (lines 6-17).
- Events: `goal, adjustScore, card, setPeriod, startClock, pauseClock, setClock, stoppage, shootoutKick, clearLastGoal, clearLastCard, reset` (lines 46-141).
- **Card-animations land:** `cardLog[]` + `lastCard` fields (lines 25, 33); pushed on positive-delta card event (lines 79-89); `clearLastCard` event (lines 133-135).

### Cricket reducer (`server/sports/cricket.js`, 305 lines)
- Pure reducer with toss-derived batting order (`battingTeamForInnings`, line 19). Extras `wd/nb/b/lb` with correct legal-ball/strike/maiden bookkeeping (lines 116-214).
- Wicket kinds: `bowled, caught, lbw, runout, stumped, hitwicket` (line 17). Bowler credited on 5/6 (line 16).
- Strike rotation: odd runs swap; end of over swaps; run-out `who` = pre-rotation end (lines 167-191).
- Pending gates (`pendingBatsman`, `pendingBowler`, lines 113-115). Flash for `4/6/W/50/100` (lines 160-164, 186).
- Phase machine `setup → live → inningsBreak → live → finished` (lines 26-37). Result by wickets/runs/tied (lines 283-294).

### Tournament engine (`server/tournament.js`, 173 lines) + HTTP + UI + overlay
- Pure standings: replays each match through the sport reducer, aggregates `played/wins/draws/losses/gf/ga/gd/points`. Sort key points → GD → GF → name (`server/tournament.js:117-123`).
- HTTP: `GET/POST/DELETE/PUT /api/tournaments`, `POST /api/tournaments/:id/teams`, `POST /api/tournaments/:id/matches`, `GET /api/tournaments/:id/standings` (public), `GET /api/tournaments/:id/info` (public) (`server/index.js:163-221, 293-305`).
- Admin UI: Tournaments + Matches-in-tournament + Standings modal (`public/admin/index.html:148-161, 356-471`).
- Overlay `/overlay/tournament/:id`: 5s auto-refresh leaderboard with medal styling for top 3 (`public/overlay/tournament.html:84-90, 143-201`).
- Sport filter: tournament sport gates which matches count (`server/tournament.js:72`).

### Sponsor / ad overlay (HTTP + UI + overlay)
- HTTP: `GET/POST/PUT/DELETE /api/sponsors` (admin); public `GET /api/sponsors/public?active=1` (`server/index.js:228-289, 308-311`).
- Allowed positions: `top-left, top-right, bottom-left, bottom-right, center-banner, top-banner` (`server/index.js:224-226`).
- Image upload: png/jpeg/svg/webp/gif ≤2 MB (`server/index.js:237-241`).
- Admin UI: add/edit/toggle-active/delete (`public/admin/index.html:163-185, 473-525`).
- Overlay `/overlay/sponsor[/:id]`: 6 slots, rotates within each position by `interval_seconds`, 600ms fade (`public/overlay/sponsor.html:34-46, 81-113, 115-132`).

### Real-time pipeline (`server/sockets.js`, 91 lines)
- Socket.IO handshake `auth:{matchId, token?}` (line 41). In-memory cache per match (line 8).
- `action` → reducer validate → append log → broadcast state (lines 51-66). `undo` → delete last event + replay (lines 68-79).
- Server sends `now` in every state for client clock sync (line 88).

### Control UX
- **Football** (`public/control/football.html`, 375 lines): goal modal with scorer, **card modal with player name** (lines 308-334), clock start/pause/manual-set, stoppage, period buttons, shootout, undo, reset, **most recent 3 cards per team in the cardLog** (lines 216-230).
- **Cricket** (`public/control/cricket.html`, 380 lines): setup form (openers + bowler), extras toggle, wicket modal (run-out: who/runs/fielder; caught/stumped: fielder picker), auto modals for new batsman (strike choice) + new bowler (consecutive-over guard), innings-break/finished screens, undo everywhere.

### Overlays
- **Football** (`public/overlay/football.html`, 208 lines): transparent 1920×1080, scorebug, GOAL bar (8s), **#cardbar (yellow 5s / red 7s with shake)** (lines 49-80, 150-181), penalty shootout strip.
- **Cricket** (`public/overlay/cricket.html`, 222 lines): `?layout=bug` (compact) or `?layout=full` (default lower-third with score bar, this-over balls, batsmen, bowler, extras, CRR, chase cell), FOUR/SIX/WICKET flash, innings-break/result banners.

### Admin (`public/admin/index.html`, 529 lines)
- Login + session check. Teams CRUD with crest. Match create with sport-specific options. Matches list with copy-to-clipboard. **Tournaments** CRUD + add teams + attach matches + view standings (lines 356-471). **Sponsors** CRUD + toggle active (lines 473-525).

### Deploy (`deploy/`)
- `nginx.conf.example` — HTTP→HTTPS redirect, WebSocket upgrade headers, `proxy_read_timeout 3600s`, `client_max_body_size 3m`, sane security headers.
- `scoreboard.service` — hardened systemd unit (`ProtectSystem=strict`, `MemoryDenyWriteExecute`, `Restart=always`).
- `DEPLOY.md` — full step-by-step: nvm, env file mode 0600, certbot, ufw/firewalld, suggested `sqlite3 .backup` cron (recipe only, no shipped script).

### Tests
- `test/football.test.js` (9 tests, 81 lines) + `test/cricket.test.js` (14 tests, 294 lines) — reducer units, all green via `npm test`.
- `test/tournament.test.js` (8 tests, 248 lines) — standings math, sort key (points/GD/GF/name), sport filter, team filter, replay.
- `test/sponsor.test.js` (4 tests, 111 lines) — sponsor CRUD/rotation.
- `e2e-verify.mjs` (438 lines, 38 assertions) — full HTTP+Socket.IO control flow for both sports.
- **Total: 35 unit tests + 38 e2e assertions.**

---

## What's rough or missing

| # | Gap | Where to look |
|---|---|---|
| 1 | **No CSRF on `/api/login` or any admin endpoint.** Cookie is `SameSite=Lax` so it WILL be sent on cross-site form POSTs. | `server/index.js:27-40` (no csrfToken), `grep -rn "csrf" server/ public/` returns nothing |
| 2 | **No rate limit on login.** Unlimited parallel password attempts in `POST /api/login`. | `server/index.js:27-35`; `grep "rateLimit\|express-rate" server/` returns nothing |
| 3 | **No helmet / CSP / security headers from the app layer.** Only nginx adds a few. No `Strict-Transport-Security`. | `grep "helmet" server/ public/` returns nothing |
| 4 | **Socket.IO CORS is wide-open** (`cors: { origin: true }`). Any site can open a WS to the match namespace. | `server/index.js:19` |
| 5 | **Default `changeme` password only logs a warning** — doesn't refuse to start in `NODE_ENV=production`. | `server/auth.js:14-16` |
| 6 | **No audit log.** No record of admin logins, team/match/tournament/sponsor CRUD. | `grep "audit" server/ public/` returns nothing |
| 7 | **No SQLite backup script shipped.** `deploy/DEPLOY.md:223-230` gives a manual cron recipe but `scripts/` contains only `e2e.sh`; nothing runs on its own. | `ls scripts/` → `e2e.sh` only |
| 8 | **No healthcheck endpoint** (`/healthz`, `/api/health`). Nginx can't tell if Node is alive beyond TCP. | `grep "healthz\|/api/health" server/` returns nothing |
| 9 | **No replay / event-log view.** Events table is durable but operators can't inspect it. No `GET /api/matches/:id/events` route. | `grep "events.*forMatch\|api/matches/.*events" server/index.js` → no admin-facing endpoint |
| 10 | **No `PUT /api/matches/:id`** — can't rename a match, change title, or fix a mis-set sport after creation. Only GET/POST/DELETE. | `server/index.js:100, 111, 136` (no `app.put` for matches) |
| 11 | **Tournament: no admin "view standings" page** (only modal). `POST /api/tournaments/:id/teams` is set-replace, not diff. | `public/admin/index.html:444` shows in modal only |
| 12 | **No per-sport customization templates.** Each match sets overs/players at create-time with no tournament-level defaults. | `server/index.js:111-134` |
| 13 | **Single-operator model** — README/HANDOFF acknowledge; no second-operator handoff, no co-operator table. | n/a (architecture) |
| 14 | **No soft-delete** — `DELETE /api/matches/:id` cascades to `events` and is unrecoverable. | `server/index.js:136-140` |
| 15 | **Cricket extras limited**: no penalty runs (free hit), no super-over, no DLS. `endInnings` is the manual close. | `server/sports/cricket.js:251-255` |
| 16 | **Player list is team-global, not per-match.** `replaceForTeam` deletes-and-reinserts; ordinals lost on edit. Snapshot in `matches.config` diverges on team edit. | `server/db.js:97-101` |

## Competitive comparison

| Capability | obscoreboard.com | This app |
|---|---|---|
| Football + cricket in one app | No | **Yes** |
| Per-match phone control | Yes | Yes |
| Tournament leaderboard | Built-in | **Built-in** (overlays + admin) |
| Sponsor/ad overlay | Built-in | **Built-in** (6 rotating slots) |
| Multi-user / RBAC | Yes | **No** (single operator) |
| 2FA / audit log | Pro | No |
| Self-host | No (cloud) | **Yes** (Node + SQLite, single binary) |
| Price | $10–40/mo | Free |

**Key gaps vs commercial:** no multi-user/RBAC, no 2FA, no hosted cloud option, no auto-DLS. **Key advantage:** truly self-hosted, one binary, free, two sports, tournament + sponsors + leaderboard now included.

## Conclusion

Scoreboard Live is now a **production-shape** self-hosted scoreboard: two sports, tournament leaderboard with standings math, sponsor overlay, full event-sourced state, and reconnect-safe overlays. The audit surfaced 16 specific gaps — the urgent ones are the **security cluster** (CSRF, rate limit, default-password refusal) and the **operational cluster** (backup script, healthcheck, audit log, replay view, match-edit endpoint). None are research problems; they're all scoped engineering.