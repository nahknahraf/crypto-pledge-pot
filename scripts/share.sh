#!/usr/bin/env bash
# Share a local CryptoPledgePot run with other people over the internet, via
# your free ngrok static domain. Starts everything, waits until it is healthy,
# opens the tunnel, and stops it all on Ctrl+C.
#
#   1. One-time: ngrok account → `ngrok config add-authtoken <token>`, and claim
#      your free static domain in the ngrok dashboard (Domains).
#   2. cp .env.share.example .env.share   and fill in NGROK_DOMAIN.
#   3. npm run share:internet
#
# Only the built web app and the proxied API/agent are exposed (vite preview),
# never the dev server, data/ or the wallets. See docs/SHARING.md.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.share ] || { echo "Missing .env.share. Run: cp .env.share.example .env.share and fill it in."; exit 1; }
set -a; . ./.env.share; set +a
: "${NGROK_DOMAIN:?set NGROK_DOMAIN in .env.share (e.g. calm-otter-123.ngrok-free.app)}"
SHARE_MODE="${SHARE_MODE:-main}"   # main = real mainnet · demo = offline demo · agent-demo = "AirWatch live" story (both demos: wallets disabled)
WITH_AGENT="${WITH_AGENT:-yes}"
PUBLIC_URL="https://${NGROK_DOMAIN}"

SKIP_TUNNEL="${SKIP_TUNNEL:-no}"   # yes = rehearsal: start everything locally, no ngrok
if [ "$SKIP_TUNNEL" != "yes" ]; then
  command -v ngrok >/dev/null || { echo "ngrok not found. Install it (see docs/SHARING.md)."; exit 1; }
  ngrok config check >/dev/null 2>&1 || { echo "ngrok has no auth token yet. Run: ngrok config add-authtoken <your token>"; exit 1; }
fi
for port in 8787 8790 8791 5175; do
  if ss -ltn "( sport = :$port )" | grep -q ":$port"; then echo "Port $port is already in use. Stop the process using it first."; exit 1; fi
done

mkdir -p data/logs
pids=()
# Each service runs in its own process group (setsid), so stopping the group also
# stops npm's grandchildren (npm → sh → node), not just npm itself.
stopped=no
cleanup () {
  [ "$stopped" = yes ] && return; stopped=yes
  echo; echo "Stopping…"
  for p in "${pids[@]}"; do kill -TERM -- "-$p" 2>/dev/null || true; done
  sleep 2
  for p in "${pids[@]}"; do kill -KILL -- "-$p" 2>/dev/null || true; done
  echo "Stopped."
}
trap cleanup EXIT INT TERM

start () { local name=$1; shift; echo "  starting $name (log: data/logs/$name.log)"; setsid "$@" > "data/logs/$name.log" 2>&1 < /dev/null & pids+=($!); }
wait_for () { local url=$1 name=$2; for _ in $(seq 1 120); do curl -sf "$url" >/dev/null 2>&1 && { echo "  ✓ $name is up"; return 0; }; sleep 1; done; echo "  ✗ $name did not start. See data/logs/$name.log"; exit 1; }

echo "CryptoPledgePot → $PUBLIC_URL   (mode: $SHARE_MODE, agent: $WITH_AGENT)"
export CRYPTOPLEDGEPOT_CORS_ORIGIN="$PUBLIC_URL"
export AGENT_PUBLIC_URL="$PUBLIC_URL/agent"

if [ "$SHARE_MODE" = "demo" ]; then
  start demo npm run demo
  wait_for http://localhost:8787/api/health server
elif [ "$SHARE_MODE" = "agent-demo" ]; then
  start agent-demo npm run demo:agent
  wait_for http://localhost:8787/api/health server
else
  start server npm run server
  wait_for http://localhost:8787/api/health server
  if [ "$WITH_AGENT" = "yes" ]; then
    start data-provider npm run data-provider
    wait_for http://localhost:8790/ data-provider
    start agent npm run agent
    wait_for http://localhost:8791/api/agent agent
  fi
fi

SHARE_HOST="$NGROK_DOMAIN" start web npm run share
wait_for http://localhost:5175/ web

if [ "$SKIP_TUNNEL" = "yes" ]; then
  echo; echo "  Rehearsal (no tunnel): everything is up on http://localhost:5175 (Host: $NGROK_DOMAIN). Ctrl+C stops it."
  wait; exit 0
fi

start ngrok ngrok http --url="$NGROK_DOMAIN" 5175 --log=stdout
for _ in $(seq 1 30); do curl -s -o /dev/null "$PUBLIC_URL/api/health" -H 'ngrok-skip-browser-warning: 1' && break; sleep 1; done
if curl -sf "$PUBLIC_URL/api/health" -H 'ngrok-skip-browser-warning: 1' >/dev/null; then
  echo "  ✓ tunnel is up"
else
  echo "  ✗ the tunnel did not come up. See data/logs/ngrok.log"; exit 1
fi

echo
echo "  Share this link:  $PUBLIC_URL"
echo "  Health:           $(curl -s "$PUBLIC_URL/api/health" -H 'ngrok-skip-browser-warning: 1')"
echo "  Logs:             data/logs/   ·   Ctrl+C stops everything"
wait
