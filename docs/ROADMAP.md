# Scoreboard Live — ROADMAP

Tie-back column references gap numbers in `docs/FEATURES.md` § "What's rough or missing".
Effort is in engineer-days for a single coder.

## P0 — do this month (security + ops foundation)

| # | Item | Gap | Why | Effort |
|---|---|---|---|---|
| P0-1 | **CSRF tokens on every state-changing admin endpoint.** Issue a per-session token, require it as `X-CSRF-Token` header (cookie can't be read cross-site). | #1 | `SameSite=Lax` already mitigates most cases, but real CSRF defense is still required before this leaves the home network. | 1d |
| P0-2 | **Rate-limit `/api/login`** — 5 attempts / 15 min / IP, then 1h lockout with exponential back-off. | #2 | `changeme` is the default; without rate-limit it's a one-script brute-force. | 0.5d |
| P0-3 | **Ship `scripts/backup-sqlite.sh`** + wire it as the systemd `ExecStartPre` smoke + a daily cron entry. Use `sqlite3 .backup` (online, no downtime). | #7 | All match history lives in one SQLite file. One disk event = total loss. `DEPLOY.md` has the recipe but no script. | 0.5d |
| P0-4 | **`/api/health` endpoint** — returns `{up, db, uptime, last_event_at}`. Wire into systemd `Type=notify` or nginx `health_check`. | #8 | Today the only signal is TCP-open, which lies when the event loop is wedged. | 0.5d |
| P0-5 | **Refuse to boot with default password in `NODE_ENV=production`.** Today's warning is easy to miss. | #5 | One-shot fix; closes the foot-gun. | 0.25d |

**P0 total:** ~2.75d. Closes the security/ops cluster.

## P1 — next quarter

| # | Item | Gap | Effort |
|---|---|---|---|
| P1-1 | **Audit log** — append-only `audit_events(actor, action, target, payload, at)` table; admin UI to filter/search. | #6 | 1.5d |
| P1-2 | **Replay / event-log viewer** — `GET /api/matches/:id/events` (admin), HTML page to scrub through the log and replay. | #9 | 1d |
| P1-3 | **`PUT /api/matches/:id`** — rename title, change status, swap home/away (with audit). | #10 | 0.5d |
| P1-4 | **Tournament bracket / round-robin auto-scheduler** — given N teams, generate all pairings and create the matches in one click. | #11 | 1d |
| P1-5 | **Helmet + security headers** at app layer (CSP, HSTS, X-Content-Type-Options). Stops relying solely on nginx. | #3 | 0.5d |
| P1-6 | **CORS allowlist** for Socket.IO (`cors: { origin: true }` → `origin: [admin-host, overlay-host]`). | #4 | 0.25d |
| P1-7 | **Soft-delete for matches + sponsors** — `deleted_at INTEGER NULL`; admin can restore from UI. | #14 | 1d |

## P2 — later

| # | Item | Gap | Effort |
|---|---|---|---|
| P2-1 | Cricket extras: free-hit + super-over. | #15 | 1d |
| P2-2 | Cricket: DLS par-score target. | #15 | 2d |
| P2-3 | Multi-operator with role-based control tokens (operator / scorekeeper / observer). | #13 | 3d |
| P2-4 | Player list per match (snapshots at match-create, not team-edit). | #16 | 1d |
| P2-5 | Per-tournament sport templates (default overs/players/half-minutes). | #12 | 0.5d |

## Out of scope

- Multi-tenant SaaS / hosted cloud offering — explicitly home-network / VPS only.
- Replay-graphical timeline (frame-by-frame) — covered by event-log viewer (P1-2).
- Native mobile app — phone browser is good enough.
- Video ingest / live streaming — OBS does that.

## Notes

- Every P0 item closes one or more gaps in `FEATURES.md`. P0-5 and P0-4 are the cheapest wins; P0-3 is the cheapest insurance.
- P1 items mostly fill the "no operator-visible admin surfaces" gap cluster (#6, #9, #10, #11, #14).
- P2 / OOS lines mirror known feature requests in the HANDOFF.md "REMAINING" list plus the audit's gap findings.