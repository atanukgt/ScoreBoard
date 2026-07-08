# Scoreboard Live — Deploy Guide

Self-hosted live **football** and **cricket** scoreboard overlays for OBS
Studio. One operator scores from a phone/tablet, OBS shows a transparent
browser-source overlay that updates in real time over WebSocket.

This guide covers deploying the app behind Nginx on a single Linux VPS (the
common case — works the same on any Debian/Ubuntu, RHEL, or Arch host).

---

## What you need

- A Linux VPS (Debian 12 / Ubuntu 24.04 / RHEL 9 — anything systemd-based)
- Node.js 20+ installed
- Nginx (`apt install nginx` / `dnf install nginx`)
- A DNS A/AAAA record pointing a subdomain (e.g. `scoreboard.example.com`)
  to the VPS IP
- Ports 80 and 443 open in the firewall
- ~150 MB of disk for the app + Node modules

---

## 1. Create an unprivileged user for the app

The app is small but it touches the network, so it should NOT run as `root`.

```bash
sudo useradd --system --create-home --shell /bin/bash scoreboard
sudo mkdir -p /var/www/scoreboard-live
sudo chown -R scoreboard:scoreboard /var/www/scoreboard-live
```

If you use a different path, update `WorkingDirectory` in the systemd unit
accordingly.

---

## 2. Install Node 20+

Using nvm (as the `scoreboard` user):

```bash
sudo -iu scoreboard
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install --lts   # picks the latest 20.x or newer
node --version      # must be v20.0.0 or newer
```

Copy the resolved binary path — you'll need it for the systemd unit:

```bash
readlink -f $(which node)
# e.g. /home/scoreboard/.nvm/versions/node/v20.18.0/bin/node
```

If you prefer the distro package:

```bash
# Debian / Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
# binary will be at /usr/bin/node
```

---

## 3. Get the app onto the server

From your local machine:

```bash
rsync -avz --exclude=node_modules --exclude=data ./ \
    scoreboard@your-vps:/var/www/scoreboard-live/
```

…or `git clone` if the project lives in a repo.

Then on the server (as `scoreboard`):

```bash
cd /var/www/scoreboard-live
npm ci --omit=dev   # production deps only — installs better-sqlite3 native build
```

> **Important:** `better-sqlite3` is a native module compiled for the host
> architecture. Always run `npm ci` on the VPS itself — do not copy
> `node_modules` from your local machine.

Sanity check:

```bash
npm test
# 18 tests should pass
```

---

## 4. Set the admin password

The app refuses to use the default `changeme` password silently — it logs a
warning on every start. For production, set a strong one in an env file:

```bash
sudo tee /etc/scoreboard.env > /dev/null <<'EOF'
ADMIN_PASSWORD=replace-this-with-something-strong
EOF
sudo chmod 0600 /etc/scoreboard.env
sudo chown scoreboard:scoreboard /etc/scoreboard.env
```

---

## 5. Install the systemd unit

```bash
sudo cp deploy/scoreboard.service /etc/systemd/system/scoreboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now scoreboard
sudo systemctl status scoreboard
```

If the path to `node` in the unit doesn't match, edit
`/etc/systemd/system/scoreboard.service` (the `ExecStart=` line) and re-run
`daemon-reload && restart`.

View logs:

```bash
sudo journalctl -u scoreboard -f
```

The service writes its DB to `/var/www/scoreboard-live/data/scoreboard.db`
by default. To relocate it (e.g. to `/var/lib/scoreboard-live`) set
`DATA_DIR=/var/lib/scoreboard-live` in `/etc/scoreboard.env` and make sure
that directory is owned by the `scoreboard` user.

---

## 6. Nginx reverse proxy + Let's Encrypt

Copy and adapt the example config:

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/scoreboard.conf
sudoedit /etc/nginx/sites-available/scoreboard.conf
# Replace `scoreboard.example.com` with your real subdomain
# Replace the cert paths after step 7 below
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/scoreboard.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Get a Let's Encrypt cert (this also rewrites the conf to add the actual cert
paths):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d scoreboard.example.com
# Follow the prompts. Certbot edits /etc/nginx/sites-available/scoreboard.conf
# in place and reloads Nginx.
```

Certbot installs a systemd timer that auto-renews the cert. Verify with:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## 7. Firewall

If you use `ufw`:

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (for certbot + redirect to HTTPS)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

If you use `firewalld`:

```bash
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

---

## 8. Smoke test

Open `https://scoreboard.example.com/` in a browser. You should see the
admin login. Sign in with the password from `/etc/scoreboard.env`.

Create a team, create a match, copy the control link, open it in another
tab/window, and add a goal/ball. You should see the state update in real
time on the control tab.

For the OBS side, see the OBS setup section in the top-level
[`README.md`](../README.md).

---

## 9. Backups

The app's entire state lives in:

- `data/scoreboard.db` — match + event log (SQLite, WAL mode)
- `data/uploads/` — team crests
- `data/secret` — session signing key (regenerating this logs everyone out)

Backups can be done live with SQLite's online backup API (no downtime) or
with a simple `sqlite3 .backup` cron. Example cron entry (root crontab):

```cron
# Daily 02:00 — backup scoreboard db
0 2 * * * sqlite3 /var/www/scoreboard-live/data/scoreboard.db \
    ".backup /var/backups/scoreboard-$(date +\%F).db"
```

…plus a retention step (delete `.db` files older than 14 days) to keep the
backup dir from growing forever.

---

## 10. Updating the app

```bash
sudo -iu scoreboard
cd /var/www/scoreboard-live
git pull                      # or rsync
npm ci --omit=dev
sudo systemctl restart scoreboard
sudo journalctl -u scoreboard -f
```

The event log is replayed on every restart, so matches in progress survive
updates as long as the DB file isn't touched.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `EADDRINUSE :::3100` on start | Another process owns the port | `sudo lsof -iTCP:3100 -sTCP:LISTEN` and stop it |
| `Error: Cannot find module 'better-sqlite3'` | Installed deps on wrong arch | Delete `node_modules`, re-run `npm ci` on the VPS |
| Overlay connects then immediately disconnects | Nginx missing WebSocket headers | Verify `Upgrade`/`Connection "upgrade"` are in the proxy block; `proxy_read_timeout` ≥ 60s |
| Admin login returns 401 forever | `ADMIN_PASSWORD` not set | Set it in `/etc/scoreboard.env` and restart |
| Crests don't load | `/uploads/` 404 | Confirm Nginx proxies `/uploads/*` to the app (it falls through the catch-all `location /`) |
| Control link says "match not found" | Token rotated or DB wiped | Don't manually edit the DB; rotate via creating a new match |
