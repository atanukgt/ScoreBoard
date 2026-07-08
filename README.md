# Scoreboard Live

Self-hosted live **football** and **cricket** scoreboard overlays for **OBS
Studio**. One operator scores from a phone/tablet; OBS shows a transparent
browser-source overlay that updates in real time over WebSocket.

```
+------------------+        WebSocket         +-------------------+
|  /control/:id    |  <------------------->   |  Node + SQLite    |
|  (operator)      |     action / state       |  (single app)     |
+------------------+                          +-------------------+
                                                          ^
                                                          | WebSocket
                                                          v
                                                  +-------------------+
                                                  |  /overlay/:id     |
                                                  |  (OBS browser     |
                                                  |   source)         |
                                                  +-------------------+
```

- Single operator — one admin password + per-match secret control links
- **Cricket** is full ball-by-ball: extras (wd/nb/b/lb), wickets (all kinds
  incl. run-out), strike rotation, maiden tracking, fall of wickets, target
  /RRR, innings break, chase, result
- **Football** has server-side clock, periods, stoppage, goals with scorers,
  cards, penalty shootout, undo
- Reconnect-safe — overlay refresh mid-match restores exact state
- Pure event sourcing — every action is a row in an append-only log;
  state = replay of the log
- Tiny stack: Node 20+, Express, Socket.IO, better-sqlite3, vanilla JS — no
  build step, no framework

---

## Quick start (local)

```bash
git clone <this repo>
cd scoreboard-live
npm install
npm test        # 18 reducer tests
npm start       # http://localhost:3100
```

Open the printed URL, log in with the default password `changeme` (change
with `ADMIN_PASSWORD=...` env var), create two teams, create a match, and
open the control link on your phone.

The data directory (DB + uploaded crests) lives at `./data/` by default. Set
`DATA_DIR=/some/other/place` to override. Delete that directory for a clean
slate.

---

## OBS Studio setup

1. In OBS, add a new **Source** → **Browser**.
2. Set the URL to the overlay page, e.g.
   `https://scoreboard.example.com/overlay/<match-id>`.
3. Set **Width** to `1920` and **Height** to `1080`.
4. **Check** "Control audio via OBS" only if you want OBS to handle the
   browser's audio (we don't emit any).
5. Click OK. The overlay is transparent by default — only the score bug,
   goal banners, and flash effects render. Drag/resize the source in the
   scene to position it (e.g. top-left for the score bug, bottom-third for
   goal celebrations).

### Layouts

The cricket overlay supports two layouts via a `?layout=` query string:

- `?layout=bug` (default) — compact top-left scorecard
- `?layout=full` (default if no param) — full lower-third with batsmen,
  bowler figures, this-over balls, extras, CRR, and a chase cell

Football has a single layout.

### Overlay refresh safety

If you delete the browser source in OBS and re-add it (or if the operator's
network blips), the overlay reconnects via Socket.IO and gets the full
current state — the score, clock, period, wickets, everything. No special
"resume" step needed.

---

## Production deploy

See [`deploy/DEPLOY.md`](deploy/DEPLOY.md) for the full step-by-step.
TL;DR:

1. `node ≥ 20` on the VPS, then `npm ci --omit=dev`
2. `sudo cp deploy/scoreboard.service /etc/systemd/system/`
3. `sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/scoreboard.conf`
4. `sudo certbot --nginx -d scoreboard.example.com`
5. `sudo systemctl enable --now scoreboard`

---

## Architecture (one-screen tour)

**Event sourcing.** Every scoring action is a row in the `events(match_id,
seq, type, payload, at)` table. The current state is `replay(config, events)`.
Undo = `delete last event + replay`. Reducers (`server/sports/*.js`) must be
**pure** and **deterministic** — they read `event.at`, never `Date.now()`.

**Clock.** Football clock state is `{running, elapsedMs, startedAt}`. The
display minute is computed client-side as
`elapsedMs + (now + serverOffset - startedAt)`. Every state message includes
`now` so the client can compute `serverOffset`. We never trust client clocks.

**Cricket ball payload.**
```js
{ runs, extra: null|'wd'|'nb'|'b'|'lb', wicket: null|{kind, who, fielder} }
```
- `runs` = physically run (bat runs for `''`/`nb`; extra runs beyond the
  1-run penalty for `wd`; byes for `b`/`lb`).
- `wd`: +1 penalty, not a legal ball, no ball faced.
- `nb`: +1 penalty, ball faced, bat runs to striker.
- `b`/`lb`: legal ball, not charged to bowler (maiden preserved).
- Strike rotation: odd `runs` swaps strike; end of over swaps again.
- Run-out `who` refers to **pre-rotation** end; `newBatsman.onStrike` lets
  the operator put the new bat on strike if needed.
- `pendingBatsman` / `pendingBowler` gates block further balls until the
  next player is named.

**Auth.**
- Admin cookie (`sb_admin`) gates `/api/*` management endpoints.
- Overlays are public-read via `matchId`.
- Control requires `?token=…` (per-match `control_token` from DB), checked
  in the Socket.IO handshake.

**Team snapshot.** Match `config` embeds a copy of team
names/colors/crests/players at creation time. Editing a team later does
**not** change existing matches — intentional.

---

## API surface (cheat sheet)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/login` | none | body: `{password}`. Returns `Set-Cookie: sb_admin=...` |
| POST | `/api/logout` | admin | clears cookie |
| GET | `/api/me` | none | returns `{admin: bool}` |
| GET/POST/PUT/DELETE | `/api/teams[/:id]` | admin | CRUD |
| POST | `/api/teams/:id/crest` | admin | body: `{dataUrl: "data:image/png;base64,…"}` (≤2 MB) |
| GET/POST/DELETE | `/api/matches[/:id]` | admin (write) | match CRUD |
| GET | `/api/matches/:id/info` | none | public match info for control/overlay |
| GET | `/control/:id` | none (token in `?token=…`) | serves the sport-specific control page |
| GET | `/overlay/:id` | none | serves the sport-specific overlay page |
| WS | `/socket.io/` | handshake: `auth: {matchId, token?}` | real-time control + state |
| GET | `/uploads/:file` | none | team crests |

Socket.IO events (control client only — overlays are read-only):
- emit `action` `{type, payload}` → server validates, applies, broadcasts
  `state`, returns `{ok}` or `{ok:false, error}`
- emit `undo` → server deletes last event, replays, broadcasts `state`
- on `state` `{sport, state, seq, now, control}` — re-render the overlay

---

## Configuration

All config is environment variables (or `EnvironmentFile=` in the systemd
unit):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3100` | HTTP listen port |
| `ADMIN_PASSWORD` | `changeme` | **set this in production**; the server logs a warning if you don't |
| `DATA_DIR` | `./data` | DB + uploads + secret signing key live here |
| `NODE_ENV` | unset | set to `production` to silence the dev warnings |

---

## Tests

```bash
npm test
# 19 reducer tests (cricket + football) — pure logic, no DB, no sockets
```

End-to-end (self-bootstrapping — picks a free port, starts a fresh server,
runs the suite, tears down):

```bash
npm run e2e
# 38 assertions exercising the full HTTP + Socket.IO control flow
# against a fresh in-process server. See e2e-verify.mjs and scripts/e2e.sh.
```

The e2e script sets up two teams and two matches, drives a full football
match (period changes, clock, goals, cards, stoppage, shootout, undo) and a
full cricket match (extras, wickets, run-out, maiden, over change, innings
break, chase → result → undo), and verifies overlay state mirrors control
state at every step.

---

## Limitations / known scope

- **Single operator.** No multi-user SaaS, no RBAC, no audit log beyond the
  event log.
- **No data migration tool.** Deleting `data/scoreboard.db` is a full reset.
  Schema changes require wiping and recreating the DB (or hand-editing).
- **No native mobile app.** The control page is a mobile-friendly web page
  — open it in your phone's browser, add to home screen for full-screen.
- **Cricket extras are limited** to `wd/nb/b/lb`. No `penalty` runs (free
  hit is left to the operator's discretion in the UI flow). No
  super-over/rain-rule/DLS — close manually with `endInnings` if needed.
- **Football shootout** is a manual log (`shootoutKick` per attempt); the
  UI tracks alternating home/away automatically.

---

## License

Pick whatever you like — MIT is the safe default.
