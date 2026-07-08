#!/usr/bin/env bash
# Self-contained e2e test runner.
#
# 1. Pick a free port (3100-3199)
# 2. Wipe data dir
# 3. Start the server in the background
# 4. Create two teams + one football + one cricket match (admin/changeme)
# 5. Run e2e-verify.mjs
# 6. Tear down the server
#
# Exits non-zero on any failure.

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-3100}"
COOKIE_JAR=$(mktemp -t sb-e2e-cookies.XXXXXX)
DATA_DIR_OLD=""
SERVER_PID=""

cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$COOKIE_JAR"
  # restore original data dir if we moved it
  if [ -n "$DATA_DIR_OLD" ] && [ -d "$DATA_DIR_OLD" ]; then
    rm -rf data
    mv "$DATA_DIR_OLD" data
  fi
  exit $code
}
trap cleanup EXIT INT TERM

# Move existing data dir aside (if any) so we start from a clean slate
if [ -d data ]; then
  DATA_DIR_OLD=$(mktemp -d -t sb-e2e-data.XXXXXX)
  mv data "$DATA_DIR_OLD"
fi

# Start the server
PORT="$PORT" NODE_ENV=test node server/index.js > /tmp/sb-e2e-server.log 2>&1 &
SERVER_PID=$!
echo "[e2e] server pid $SERVER_PID on port $PORT"

# Wait for /admin/ to respond (max 10s)
for i in $(seq 1 50); do
  if curl -sS -o /dev/null -w "%{http_code}" "http://localhost:$PORT/admin/" 2>/dev/null | grep -q '^200$\|^302$'; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[e2e] server died before responding. Log:" >&2
    cat /tmp/sb-e2e-server.log >&2
    exit 1
  fi
  sleep 0.2
done

# Bootstrap data: login + teams + matches
BASE="http://localhost:$PORT"
curl -sS -c "$COOKIE_JAR" -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' -d '{"password":"changeme"}' >/dev/null

INDIA=$(curl -sS -b "$COOKIE_JAR" -X POST "$BASE/api/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"India FC","short_name":"IND","color":"#FF9933"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')

AUS=$(curl -sS -b "$COOKIE_JAR" -X POST "$BASE/api/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Australia FC","short_name":"AUS","color":"#FFCC00"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')

MUM=$(curl -sS -b "$COOKIE_JAR" -X POST "$BASE/api/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mumbai Indians","short_name":"MI","color":"#004BA0"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')

CSK=$(curl -sS -b "$COOKIE_JAR" -X POST "$BASE/api/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Chennai Super Kings","short_name":"CSK","color":"#F9CD05"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')

curl -sS -b "$COOKIE_JAR" -X PUT "$BASE/api/teams/$MUM" \
  -H 'Content-Type: application/json' \
  -d '{"players":["Rohit","Ishan","Surya","Hardik","Pollard","Krunal","Bumrah","Chahar","Chahar2","Boult","Richardson"]}' >/dev/null

curl -sS -b "$COOKIE_JAR" -X PUT "$BASE/api/teams/$CSK" \
  -H 'Content-Type: application/json' \
  -d '{"players":["Dhoni","Gaikwad","Conway","Jadeja","Moeen","Rayudu","Deepak","Tushar","Mukesh","Pathirana","Theekshana"]}' >/dev/null

FB=$(curl -sS -b "$COOKIE_JAR" -X POST "$BASE/api/matches" \
  -H 'Content-Type: application/json' \
  -d "{\"sport\":\"football\",\"title\":\"India vs Australia\",\"home_team_id\":$INDIA,\"away_team_id\":$AUS,\"options\":{\"halfMinutes\":45}}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')

CR=$(curl -sS -b "$COOKIE_JAR" -X POST "$BASE/api/matches" \
  -H 'Content-Type: application/json' \
  -d "{\"sport\":\"cricket\",\"title\":\"MI vs CSK — 5 overs\",\"home_team_id\":$MUM,\"away_team_id\":$CSK,\"options\":{\"oversPerInnings\":5,\"playersPerSide\":11,\"tossWinner\":\"home\",\"tossDecision\":\"bat\"}}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')

echo "[e2e] football match=$FB  cricket match=$CR"

# Symlink the cookie jar where the test expects it
ln -sf "$COOKIE_JAR" /tmp/sb-cookies.txt

# Run the e2e test
BASE="$BASE" FB_MATCH="$FB" CR_MATCH="$CR" node e2e-verify.mjs
