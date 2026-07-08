#!/usr/bin/env bash
# scoreboard-live — VPS one-shot install.
#
# Idempotent: safe to re-run. Designed for the Hostinger KVM VPS that already
# hosts dealermitra.dctraders.co.in / dctraders.co.in — it does NOT touch
# any other project, vhost, docker container, or firewall rule.
#
# Prereqs on the VPS:
#   - Docker Engine + Compose plugin installed
#   - nginx + certbot + python3-certbot-nginx installed
#   - DNS A record for scoreboard.dctraders.co.in → this VPS's public IP
#     (must already be propagated — we don't wait on it; certbot will fail
#      visibly if the DNS isn't right)
#
# Usage (from your laptop):
#   ssh root@187.127.153.248
#   # clone or rsync the repo first:
#   git clone <repo-url> /var/www/scoreboard-live
#   cd /var/www/scoreboard-live
#   cp .env.example .env
#   nano .env          # set ADMIN_PASSWORD to something strong
#   bash deploy/install-vps.sh
#
# What this script does, in order:
#   1. Pre-creates /var/www/scoreboard-live/data owned by uid 1000 (the
#      `node` user the image runs as) so the bind-mount doesn't end up
#      root-owned and unwritable.
#   2. Drops the nginx vhost into sites-available + symlinks + reloads.
#      Skip the nginx block with `--no-nginx` if you manage nginx yourself.
#   3. Runs `docker compose build && up -d`.
#   4. Issues the Let's Encrypt cert and rewrites the vhost to use it.
#   5. Health-checks the app and prints the final URLs.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/var/www/scoreboard-live}"
DOMAIN="${DOMAIN:-scoreboard.dctraders.co.in}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"
DO_NGINX=true

for arg in "$@"; do
  case "$arg" in
    --no-nginx) DO_NGINX=false ;;
    --app-dir=*) APP_DIR="${arg#*=}" ;;
    --domain=*)  DOMAIN="${arg#*=}"  ;;
    --email=*)   EMAIL="${arg#*=}"   ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31m[%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

cd "$REPO_DIR"
[[ -f .env ]] || die ".env not found in $REPO_DIR — copy .env.example and set ADMIN_PASSWORD first."
grep -q '^ADMIN_PASSWORD=[A-Za-z0-9_-]\{6,\}' .env || die "ADMIN_PASSWORD in .env is unset or too short."
grep -q '^ADMIN_PASSWORD=changeme$' .env && die "ADMIN_PASSWORD is still 'changeme' — change it first."

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
  if [[ $i -eq 30 ]]; then die "container never became healthy (last status: $STATUS). Try: docker compose logs app"; fi
done

if $DO_NGINX; then
  log "Installing nginx vhost for $DOMAIN..."
  VHOST="/etc/nginx/sites-available/scoreboard-live.conf"
  sed "s|scoreboard.dctraders.co.in|$DOMAIN|g" deploy/nginx.conf.example > "$VHOST"
  ln -sf "$VHOST" /etc/nginx/sites-enabled/scoreboard-live.conf
  nginx -t
  systemctl reload nginx

  log "Issuing Let's Encrypt cert (certbot --nginx)..."
  certbot --nginx --non-interactive --agree-tos -m "$EMAIL" \
    -d "$DOMAIN" --redirect || die "certbot failed — check DNS A record and nginx config"

  log "Final nginx reload..."
  systemctl reload nginx
else
  log "Skipping nginx (--no-nginx). Configure your reverse proxy to forward $DOMAIN → 127.0.0.1:3100."
fi

cat <<EOF

  ╔══════════════════════════════════════════════════════════════╗
  ║  scoreboard-live is live on:                                 ║
  ║      https://$DOMAIN
  ║                                                              ║
  ║  Admin login is the password from .env                       ║
  ║                                                              ║
  ║  Useful commands:                                            ║
  ║      docker compose -f $REPO_DIR/docker-compose.yml logs -f  ║
  ║      docker compose -f $REPO_DIR/docker-compose.yml restart  ║
  ║      docker compose -f $REPO_DIR/docker-compose.yml down     ║
  ║                                                              ║
  ║  Backups:  $APP_DIR/data/scoreboard.db  (SQLite, WAL mode)   ║
  ╚══════════════════════════════════════════════════════════════╝
EOF
