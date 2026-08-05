#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# tunnel.sh — host Seedbox Lite (UI + API + torrent engine) on THIS
# machine and expose it publicly with a free Cloudflare quick tunnel.
#
#   ./scripts/tunnel.sh
#
# What it does:
#   1. Starts the app: LITE_MODE=true DISABLE_TRANSCODE=true
#      MAX_ACTIVE_TORRENTS=2 npm start   (UI+API+engine on :3000)
#   2. Opens a Cloudflare quick tunnel → prints a public https:// URL
#      (Ctrl+C stops both).
#
# The URL is DIFFERENT each run (trycloudflare.com). For a stable URL
# you'll visit every time, set up a NAMED tunnel instead (see below).
#
# Note: the app serves the UI and the API from the same origin, so the
# tunnel URL just works — no VITE_API_BASE_URL needed.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "✖ cloudflared is not installed."
  echo "  Ubuntu/Debian:"
  echo "    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb"
  echo "    sudo dpkg -i /tmp/cloudflared.deb"
  echo "  macOS:  brew install cloudflared"
  echo "  Other:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

# ── 1. Start the app (cool profile) ────────────────────────────────
echo "🌱 Starting Seedbox Lite (LITE_MODE, transcode off, max 2 torrents)…"
LITE_MODE=true DISABLE_TRANSCODE=true MAX_ACTIVE_TORRENTS=2 npm start &
APP_PID=$!
cleanup() {
  echo
  echo "🛑 Stopping…"
  kill "$APP_PID" 2>/dev/null || true
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# Wait for the API (the first run also builds the client, so be patient)
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

# ── 2. Open the tunnel ─────────────────────────────────────────────
echo
echo "══════════════════════════════════════════════════════════════"
echo "  🌐 PUBLIC URL — open this in your browser (or share it):"
echo
cloudflared tunnel --url "http://localhost:$PORT"
