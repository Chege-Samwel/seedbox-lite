#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# build-apk.sh — build a side-loadable Heiken APK for Android phones
# and Android TV (NOT for the Play Store).
#
#   ./scripts/build-apk.sh                 # uses the Netlify UI URL
#   ./scripts/build-apk.sh https://...     # or pass the URL explicitly
#
# IMPORTANT — what URL goes in the APK:
#   Use the STATIC Netlify URL (https://<your-site>.netlify.app). It never
#   changes. The engine's tunnel URL changes every run, but the app's login
#   screen has a "Server address" box where each device enters the current
#   tunnel URL once — so the APK NEVER needs rebuilding.
#
# Requires: Java (JDK 8+) on this machine. First run downloads Android
# build tooling automatically (needs internet to Google's servers).
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${1:-}"
if [ -z "$URL" ]; then
  # Default: read VITE_API_BASE_URL from the client prod env, else prompt.
  URL="$(grep -E '^VITE_API_BASE_URL=' client/.env.production 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || true)"
  if [ -z "$URL" ]; then
    read -r -p "Netlify UI URL (e.g. https://your-site.netlify.app): " URL
  fi
fi
URL="${URL%/}"
if [[ ! "$URL" =~ ^https:// ]]; then
  echo "✖ URL must be https (Netlify + tunnel are both https). Got: $URL"
  exit 1
fi

echo "➜ Building Heiken APK pointing at: $URL"
echo "  (engine URL is set per-device via the login screen 'Server address' box)"

if ! command -v java >/dev/null 2>&1; then
  echo "✖ Java is required. Install it first:"
  echo "  Ubuntu/Debian: sudo apt install openjdk-17-jdk-headless"
  echo "  Windows:       https://adoptium.net"
  echo "  macOS:         brew install openjdk@17"
  exit 1
fi

mkdir -p dist-apk
echo
echo "⏳ Running web2apk (first run downloads Android tooling — can take a few minutes)…"
npx --yes web2apk \
  --url "$URL" \
  --name "Heiken" \
  --app-name "Heiken" \
  --package "com.heiken.app" \
  --version "1.0.0" \
  --icon "client/public/icon-512.png" \
  --output "dist-apk/heiken.apk"

echo
echo "✅ Done: dist-apk/heiken.apk"
echo "   Side-load it: copy to a phone/TV and open it (allow 'install unknown apps'),"
echo "   or on Android TV use: adb install dist-apk/heiken.apk"
echo
echo "   NO TOOLCHAIN? Skip all this — use the cloud builder instead:"
echo "     https://www.pwabuilder.com  → enter $URL → 'Package for stores' → Android → download APK"
