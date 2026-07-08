#!/usr/bin/env bash
# scoreboard-live — VPS one-shot install.
#
# Idempotent: safe to re-run. Designed for the Hostinger KVM VPS that already
# hosts dealermitra.dctraders.co.in / dctraders.co.in / events.dctraders.co.in
# / papertrading.dctraders.co.in / stock.dctraders.co.in — it does NOT touch
# any other project, vhost, docker container, or firewall rule.
#
# Prereqs on the VPS:
#   - Docker Engine + Compose plugin installed
#   - nginx + certbot + python3-certbot-nginx installed
#   - DNS A record for $DOMAIN → this VPS's public IP, propagated
#
# Usage (from your laptop):
#   ssh root@187.127.153.248
#   git clone <repo-url> /var/www/scoreboard-live
#   cd /var/www/scoreboard-live
#   cp .env.example .env
#   nano .env          # set ADMIN_PASSWORD to something strong (mandatory)
#   bash deploy/install-vps.sh
#
# What this script does, in order:
#   1. Pre-creates /var/www/scoreboard-live/data owned by uid 1000 (the
#      `node` user the image runs as) so the bind-mount doesn't end up
#      root-owned and unwritable.
#   2. Resolves the chosen HOST PORT from $PORT (with collision detection
#      against the existing containers) and templates the nginx vhost.
#   3. Drops the nginx vhost into sites-available + symlinks + reloads.
#      Skip the nginx block with `--no-nginx` if you manage nginx yourself.
#   4. Runs `docker compose build && up -d`.
#   5. Pre-flights DNS for $DOMAIN (dig @8.8.8.8) — if it doesn't resolve,
#      dies with a clear message before touching certbot.
#   6. Issues the Let's Encrypt cert and reloads nginx.
#   7. Health-checks the app and prints the final URLs.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/var/www/scoreboard-live}"
DOMAIN="${DOMAIN:-scoreboard.dctraders.co.in}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"
DO_NGINX=true

for arg in "$@"; do
  case "$arg" in
    --no-nginx)   DO_NGINX=false ;;
    --app-dir=*)  APP_DIR="${arg#*=}" ;;
    --domain=*)   DOMAIN="${arg#*=}"  ;;
    --email=*)    EMAIL="${arg#*=}"   ;;
    --port=*)     OVERRIDE_PORT="${arg#*=}" ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[1;33m[%s] WARN: %s\033[0m\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf '\033[1;31m[%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

# ---- Resolve the host-side container port ----
# Priority: --port flag > ADMIN_PASSWORD-style .env var > default 3100.
# Then collision-check against anything already listening on 127.0.0.1.
env_port() {
  local key="$1"
  # shellcheck disable=SC1091
  (set -a; source "$REPO_DIR/.env" >/dev/null 2>&1; set +a; printf '%s' "${!key-}")
}
HOST_PORT="${OVERRIDE_PORT:-$(env_port PORT)}"
HOST_PORT="${HOST_PORT:-3100}"

if ss -ltn "( sport = :$HOST_PORT )" 2>/dev/null | grep -q ":$HOST_PORT\b"; then
  warn "Port $HOST_PORT is already bound on this host (likely interviewpro-web-1 on :3100)."
  if [[ -z "${OVERRIDE_PORT:-}" ]]; then
    NEW_PORT=3102
    while ss -ltn "( sport = :$NEW_PORT )" 2>/dev/null | grep -q ":$NEW_PORT\b"; do
      NEW_PORT=$((NEW_PORT + 1))
      [[ $NEW_PORT -gt 3199 ]] && die "no free port in 3102..3199 — pass --port= explicitly."
    done
    warn "Bumping .env PORT from $HOST_PORT → $NEW_PORT (collision)."
    HOST_PORT="$NEW_PORT"
    # write PORT= line back into .env (replace or append)
    if grep -qE '^[[:space:]]*PORT[[:space:]]*=' "$REPO_DIR/.env"; then
      sed -i.bak -E "s/^[[:space:]]*PORT[[:space:]]*=.*/PORT=$HOST_PORT/" "$REPO_DIR/.env"
    else
      printf '\nPORT=%s\n' "$HOST_PORT" >> "$REPO_DIR/.env"
    fi
  else
    die "--port=$HOST_PORT is in use; pick a free one."
  fi
fi

cd "$REPO_DIR"
[[ -f .env ]] || die ".env not found in $REPO_DIR — copy .env.example and set ADMIN_PASSWORD first."
grep -q '^ADMIN_PASSWORD=[A-Za-z0-9_-]\{6,\}' .env || die "ADMIN_PASSWORD in .env is unset or too short."
grep -q '^ADMIN_PASSWORD=changeme$' .env && die "ADMIN_PASSWORD is still 'changeme' — change it first."

log "Using HOST_PORT=$HOST_PORT (container listens on this; nginx proxies to 127.0.0.1:$HOST_PORT)."

log "Pre-creating data dir owned by uid 1000 (container's node user)..."
mkdir -p "$APP_DIR/data"
chown -R 1000:1000 "$APP_DIR/data"
ls -ldn "$APP_DIR/data"

log "Building image + starting container..."
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d

log "Waiting for app to be healthy..."
for i in $(seq 1 30); do
  STATUS="$(docker inspect --format='{{.State.Health.Status}}' scoreboard-live 2>/dev/null || echo starting)"
  if [[ "$STATUS" == "healthy" ]]; then
    log "Container is healthy."
    break
  fi
  sleep 2
  [[ $i -eq 30 ]] && die "container never became healthy (last status: $STATUS). Try: docker compose logs app"
done

# Quick smoke-test against the bind-mounted port before touching nginx.
log "Smoke-testing http://127.0.0.1:$HOST_PORT/api/me ..."
curl -fsS "http://127.0.0.1:$HOST_PORT/api/me" >/dev/null || die "app responded with non-2xx — check 'docker compose logs app'."

if $DO_NGINX; then
  log "Installing nginx vhost for $DOMAIN → 127.0.0.1:$HOST_PORT..."
  VHOST="/etc/nginx/sites-available/scoreboard-live.conf"
  # Template both the domain and the port from the example.
  sed -e "s|scoreboard.dctraders.co.in|$DOMAIN|g" \
      -e "s|127.0.0.1:3100|127.0.0.1:$HOST_PORT|g" \
      deploy/nginx.conf.example > "$VHOST"
  ln -sf "$VHOST" /etc/nginx/sites-enabled/scoreboard-live.conf
  nginx -t
  systemctl reload nginx

  log "DNS pre-flight (dig +short $DOMAIN @8.8.8.8)..."
  RESOLVED_IP="$(dig +short "$DOMAIN" @8.8.8.8 || true)"
  if [[ -z "$RESOLVED_IP" ]]; then
    die "$DOMAIN does not resolve yet. Add the A record → $(curl -s ifconfig.me 2>/dev/null || echo '<VPS-IP>') at your DNS registrar, wait for propagation, and re-run this script."
  fi
  MY_IP="$(curl -s ifconfig.me 2>/dev/null || true)"
  log "$DOMAIN → $RESOLVED_IP${MY_IP:+  (this VPS: $MY_IP)}."

  log "Issuing Let's Encrypt cert (certbot --nginx)..."
  certbot --nginx --non-interactive --agree-tos -m "$EMAIL" \
    -d "$DOMAIN" --redirect || die "certbot failed — check /var/log/letsencrypt/letsencrypt.log"

  log "Final nginx reload..."
  systemctl reload nginx
else
  log "Skipping nginx (--no-nginx). Configure your reverse proxy to forward $DOMAIN → 127.0.0.1:$HOST_PORT."
fi

cat <<EOF

  ╔══════════════════════════════════════════════════════════════╗
  ║  scoreboard-live is live on:                                 ║
  ║      https://$DOMAIN
  ║                                                              ║
  ║  Host port:  127.0.0.1:$HOST_PORT
  ║  Admin login: the password from .env                         ║
  ║                                                              ║
  ║  Useful commands:                                            ║
  ║      docker compose -f $REPO_DIR/docker-compose.yml logs -f  ║
  ║      docker compose -f $REPO_DIR/docker-compose.yml restart  ║
  ║      docker compose -f $REPO_DIR/docker-compose.yml down     ║
  ║                                                              ║
  ║  Backups:  $APP_DIR/data/scoreboard.db  (SQLite, WAL mode)   ║
  ╚══════════════════════════════════════════════════════════════╝
EOF
