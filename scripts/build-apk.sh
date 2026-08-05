#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# build-apk.sh — build a side-loadable Heiken APK for Android phones
# and Android TV (NOT for the Play Store).
#
#   ./scripts/build-apk.sh                       # reads VITE_API_BASE_URL
#   ./scripts/build-apk.sh https://heikenapp.netlify.app
#
# Uses Google's Bubblewrap (@bubblewrap/cli) to wrap the Heiken PWA in a
# fullscreen Android app. First run downloads Bubblewrap, the Android SDK
# and Gradle deps (several minutes, ~1–2 GB disk). Java (JDK 8+) is the
# only manual prerequisite.
#
# IMPORTANT — what URL goes in the APK:
#   Use the STATIC Netlify URL (https://<your-site>.netlify.app) — it never
#   changes. The engine's tunnel URL changes every run, but the login
#   screen's "Server address" box handles that per-device. So the APK is
#   built once and never needs rebuilding.
#   (A path like /login is stripped automatically.)
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${1:-}"
if [ -z "$URL" ]; then
  URL="$(grep -E '^VITE_API_BASE_URL=' client/.env.production 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || true)"
  if [ -z "$URL" ]; then
    read -r -p "Netlify UI URL (e.g. https://heikenapp.netlify.app): " URL
  fi
fi

# Keep only the origin — manifest/icon URLs must point at the site root.
ORIGIN="$(printf '%s' "$URL" | sed -E 's|(https?://[^/]+).*|\1|')"
if [[ ! "$ORIGIN" =~ ^https:// ]]; then
  echo "✖ URL must be https (Netlify + tunnel are both https). Got: $URL"
  exit 1
fi
HOST="$(printf '%s' "$ORIGIN" | sed -E 's|https?://||')"
echo "➜ Building Heiken APK for: $ORIGIN"
echo "  (engine URL is set per-device via the login screen 'Server address' box)"

if ! command -v java >/dev/null 2>&1; then
  echo "✖ Java is required. Install it first:"
  echo "  Ubuntu/Debian: sudo apt install openjdk-17-jdk-headless"
  echo "  Windows:       https://adoptium.net"
  echo "  macOS:         brew install openjdk@17"
  exit 1
fi

mkdir -p dist-apk/twa

# ── Write the TWA manifest directly (no interactive init) ─────────
cat > dist-apk/twa/twa-manifest.json <<JSON
{
  "packageId": "com.heiken.app",
  "host": "$HOST",
  "name": "Heiken",
  "launcherName": "Heiken",
  "display": "standalone",
  "themeColor": "#0b0d12",
  "themeColorDark": "#0b0d12",
  "navigationColor": "#0b0d12",
  "navigationColorDark": "#0b0d12",
  "navigationDividerColor": "#0b0d12",
  "navigationDividerColorDark": "#0b0d12",
  "backgroundColor": "#0b0d12",
  "enableNotifications": false,
  "startUrl": "/",
  "iconUrl": "$ORIGIN/icon-512.png",
  "maskableIconUrl": "$ORIGIN/icon-512.png",
  "splashScreenFadeOutDuration": 300,
  "appVersionName": "1.0.0",
  "appVersionCode": 1,
  "shortcuts": [],
  "webManifestUrl": "$ORIGIN/manifest.webmanifest",
  "fallbackType": "customtabs",
  "features": {},
  "enableSiteSettingsShortcut": true,
  "isChromeOSOnly": false,
  "isOfflineFallbackEnabled": false
}
JSON

# ── Bubblewrap lives in a local tool dir (visible install, cached) ──
TOOLDIR="dist-apk/tool"
BW="$TOOLDIR/node_modules/.bin/bubblewrap"
mkdir -p "$TOOLDIR"
if [ ! -x "$BW" ]; then
  echo
  echo "⏳ Downloading Bubblewrap (@bubblewrap/cli)…"
  echo "    First run downloads it + its deps. This can take a few minutes on a"
  echo "    slow connection — watch for the npm progress bar (it is NOT stuck)."
  ( cd "$TOOLDIR" && npm install --no-audit --no-fund @bubblewrap/cli ) || {
    echo "✖ Could not install @bubblewrap/cli — check npm/network."
    exit 1
  }
fi
echo "✓ Bubblewrap ready: $($BW --version 2>/dev/null || echo 'version?')"

echo
echo "⏳ Checking Android SDK (bubblewrap doctor)…"
if ! "$BW" doctor >/dev/null 2>&1; then
  echo "   Android SDK not ready — installing it now (one-time, ~1–2 GB)."
  echo "   No output for a few minutes is normal while it downloads."
  echo
  yes | "$BW" sdk install || {
    echo "✖ SDK install failed. Try manually:  $BW sdk install"
    exit 1
  }
fi

echo
echo "⏳ Building APK — first Gradle run downloads dependencies, several minutes…"
( cd dist-apk/twa && "$OLDPWD/$BW" build )

APK="$(find dist-apk/twa/app/build/outputs -name '*.apk' 2>/dev/null | head -1)"
if [ -z "$APK" ]; then
  echo "✖ Build finished but no APK found under dist-apk/twa/app/build/outputs"
  exit 1
fi
cp "$APK" dist-apk/heiken.apk

echo
echo "✅ Done: dist-apk/heiken.apk"
echo "   Side-load it: copy to a phone/TV and open it (allow 'install unknown apps'),"
echo "   or on Android TV use: adb install dist-apk/heiken.apk"
echo
echo "   NO JAVA / NO TOOLCHAIN? Use the cloud builder instead:"
echo "     https://www.pwabuilder.com  → enter $ORIGIN → 'Package for stores' → Android → download APK"
