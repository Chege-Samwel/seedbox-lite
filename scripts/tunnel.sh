#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# tunnel.sh — start Heiken (UI + API + engine) and expose it publicly.
#
#   ./scripts/tunnel.sh
#
# Automatically picks the best tunnel available on this machine:
#   1. ngrok            (preferred — `npm start` auto-starts it, see
#                        scripts/serve.js; set NGROK_URL for a FIXED URL)
#   2. cloudflared      (fallback: free quick tunnel, URL changes each run)
#
# Either way it prints the public URL. Ctrl+C stops everything.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

# ── ngrok path (preferred) ─────────────────────────────────────────
if command -v ngrok >/dev/null 2>&1; then
  echo "🕳️  ngrok detected — starting Heiken (ngrok auto-tunnels on npm start)."
  echo "    For a FIXED URL, claim a free static domain once (ngrok dashboard →"
  echo "    Domains → New Domain) and set NGROK_URL=https://<name>.ngrok-free.app"
  exec npm start
fi

# ── cloudflared fallback ───────────────────────────────────────────
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "✖ Neither ngrok nor cloudflared is installed."
  echo "  Install one for a public URL:"
  echo "    ngrok:       https://ngrok.com/download"
  echo "    cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

echo "🌱 Starting Heiken (LITE_MODE, transcode off, max 5 torrents)…"
LITE_MODE=true DISABLE_TRANSCODE=true MAX_ACTIVE_TORRENTS=5 npm start &
APP_PID=$!
cleanup() {
  echo
  echo "🛑 Stopping…"
  kill "$APP_PID" 2>/dev/null || true
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "⏳ Waiting for http://localhost:$PORT/api/health …"
ok=0
for _ in $(seq 1 90); do
  if curl -sf -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "✖ The app exited — see the output above."; exit 1
  fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  echo "✖ Timed out waiting for the app. Check the server log above."; exit 1
fi
echo "✓ App is up."

echo
echo "══════════════════════════════════════════════════════════════"
echo "  🌐 PUBLIC URL — open this in your browser (or share it):"
echo
cloudflared tunnel --url "http://localhost:$PORT"
