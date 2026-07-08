#!/usr/bin/env bash
# scoreboard-live — daily backup + retention sweep.
# Installed to /usr/local/bin/backup-scoreboard.sh by deploy/install-vps.sh.
# Run by root from a daily cron (default schedule 02:20 IST).
#
# Source DB: /var/www/scoreboard-live/data/scoreboard.db
#            bind-mounted from the running scoreboard-live container. SQLite's
#            online backup API is safe against concurrent writes from the live
#            app, so we never need to stop the container.
#
# Dest:      /var/backups/scoreboard-YYYY-MM-DD.db  (mode 0644, root-owned)
# Retention: 14 days (override with RETENTION_DAYS=N before the call)
# Log:       /var/log/scoreboard-backup.log (cron redirect appends)
#
# Idempotent: if a backup for today already exists, the new one is suffixed
# with HHMMSS so a manual rerun or a duplicate cron tick doesn't clobber.

set -euo pipefail

SRC="${SCOREBOARD_DB:-/var/www/scoreboard-live/data/scoreboard.db}"
DEST_DIR="${SCOREBOARD_BACKUP_DIR:-/var/backups}"
LOG="${SCOREBOARD_BACKUP_LOG:-/var/log/scoreboard-backup.log}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >&2; }

# Don't pollute cron noise before the deploy has actually created the DB.
if [[ ! -f "$SRC" ]]; then
  log "skip: source DB $SRC does not exist yet — install-vps.sh hasn't created it."
  exit 0
fi

mkdir -p "$DEST_DIR"
touch "$LOG"

DEST="$DEST_DIR/scoreboard-$(date +%F).db"
if [[ -e "$DEST" ]]; then
  DEST="$DEST_DIR/scoreboard-$(date +%FT%H%M%S).db"
fi

log "backup $SRC → $DEST"

# Wipe a partial / empty dest if anything below fails.
trap '[[ $? -ne 0 ]] && rm -f "$DEST"' EXIT

if ! sqlite3 "$SRC" ".backup '$DEST'"; then
  log "FAIL: sqlite3 .backup returned non-zero"
  exit 1
fi

SIZE=$(stat -c '%s' "$DEST")
if (( SIZE < 4096 )); then
  log "FAIL: $DEST is suspiciously small ($SIZE bytes) — bailing"
  exit 1
fi
log "ok: $SIZE bytes"

# Retention sweep (silent unless we actually prune something).
if DELETED=$(find "$DEST_DIR" -maxdepth 1 -name 'scoreboard-*.db' -mtime +"$RETENTION_DAYS" -print -delete | wc -l); then
  if (( DELETED > 0 )); then
    log "retention: pruned $DELETED file(s) older than ${RETENTION_DAYS}d"
  fi
fi
