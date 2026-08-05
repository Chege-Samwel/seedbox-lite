# Heiken — Android APK (phones + Android TV, no Play Store)

A side-loadable **Heiken APK** for Android phones **and** Android smart TVs.
It's a fullscreen app that loads the Heiken UI — no store, no domain needed.

---

## What the APK points at (read this — it saves you rebuilds)

The APK bakes in one URL. Use the **static Netlify URL**
(`https://<your-site>.netlify.app`) because it never changes.

The **engine** runs on your laptop behind a Cloudflare **quick** tunnel,
whose URL changes every run. That's fine: the login screen has a
**"Server address"** box. Each device types the current tunnel URL there
**once** (it's remembered on that device). So:

- The APK is built **once** and works forever.
- When the tunnel URL changes, you just update the server-address box —
  no new APK, no Netlify redeploy.

---

## Option 1 — Cloud builder, zero toolchain (easiest)

1. Push the latest code and let Netlify rebuild (the service worker makes
   the site installable / packageable).
2. Go to **https://www.pwabuilder.com**
3. Enter `https://<your-site>.netlify.app` → **Start**
4. **Package for stores** → **Android**
5. Download the **APK** (and/or AAB). It builds a Trusted Web Activity —
   fullscreen, own icon, like a native app.
6. Side-load it (below).

## Option 2 — Build on your laptop (one command)

```bash
# once: install Java
sudo apt install openjdk-17-jdk-headless        # Ubuntu/Debian

# build (first run downloads Android tooling automatically)
./scripts/build-apk.sh                          # → dist-apk/heiken.apk
```

That wraps the Netlify UI in a WebView app named **Heiken**
(`com.heiken.app`), with the new icon.

> No domain? Doesn't matter — see "No domain in Cloudflare" below.

---

## Side-loading

### Android phones
1. Copy `heiken.apk` to the phone (USB, or upload to Drive and open on the phone).
2. Tap it → allow **"Install unknown apps"** for your file manager/browser.
3. Open **Heiken** → login screen → **Server address** → paste the current
   tunnel URL → **Use this server** → enter your ticket.

### Android smart TVs
1. Copy the APK to a USB stick, plug into the TV.
2. Use a file manager app (e.g. **Downloader**, or **X-plore**) → open the
   APK → allow unknown sources when asked.
   *Alternative:* with ADB from your laptop:
   `adb connect <tv-ip>` then `adb install heiken.apk`.
3. The app is remote-friendly (D-pad + Enter work everywhere; the player
   maps `←`/`→` seek, `Space` play/pause, `F` fullscreen, `M` mute).

---

## No domain in Cloudflare — your options

You do **not** need a domain for any of this:

| Approach | URL | Notes |
|---|---|---|
| **Cloudflare quick tunnel** (what you have) | changes every run | handled by the login "Server address" box — APK never rebuilds |
| **Tailscale Funnel** | `https://<machine>.ts.net` — **fixed** | free, no domain; install Tailscale on the laptop, enable Funnel → point at :3000 |
| **ngrok** (free account) | `https://heiken.ngrok-free.app` — **fixed** | free static domain; `ngrok http 3000 --url=https://heiken.ngrok-free.app` |
| **Buy a cheap domain** | `https://heiken.example.com` | ~$1–2/yr; then finish your named tunnel (route + DNS) |

If you ever get a **fixed** URL (any of the last three), bake it into the
build instead of the Netlify URL: set `VITE_API_BASE_URL` to it in Netlify,
redeploy, rebuild the APK pointing at the Netlify URL — and then nobody ever
touches the server-address box again.

---

## Rebuilding after a code change

Just push → Netlify redeploys the UI → the existing APK picks up the new
UI automatically (it's a webview). Rebuild the APK **only** if you change
the icon, app name, or the baked URL.

## Notes
- The APK is signed with a debug key (fine for side-loading; keep the same
  keystore if you ever reinstall over it).
- The service worker (`client/public/sw.js`) never intercepts `/api` or
  video streams, so streaming works exactly as in the browser.
