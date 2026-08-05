# Heiken — Step-by-Step Setup Guide

Heiken = **static UI on Netlify** + **engine on your laptop** + **any device
(phone / Android TV) reaching the laptop through a Cloudflare tunnel**.

```
[ Phone / Android TV ] ──https──▶ your-app.netlify.app   (static UI)
                                         │  API + streams via
                                         ▼  your Cloudflare tunnel URL
                              [ your HP EliteBook at home ]
                              node server: UI(optional) + API + torrent engine
                              LITE_MODE=true · ~5 viewers supported
```

Everything below is copy-paste friendly. Fill the blanks marked `<...>`.

---

## Part 0 — Two files you'll use everywhere

| File | What it configures | Where to put it |
|---|---|---|
| `client/.env.production` | The **static UI** (Netlify) | Netlify dashboard → Environment variables (or edit the file before `npm run build`) |
| `.env.production` / `server/.env.production` | The **engine** (laptop) | Copy to `.env` next to the server, or export the vars in your shell/PM2 |

Both are clean templates already — fill in the values below.

---

## Part 1 — Netlify: the static UI (you've started this — verify these 4 things)

1. **Build settings** — Netlify dashboard → Site configuration →
   **Build & deploy → Build settings**:
   - **Base directory:** `client`
   - **Build command:** `npm ci && npm run build`
   - **Publish directory:** `dist`
   - ⚠️ **Clear** any leftover "Build command" / "Publish directory" from the
     old UI config (Netlify UI values override `netlify.toml` — blank them so
     the file wins). The repo ships a `netlify.toml` that sets all three.
2. **Environment variables** (Site configuration → Environment variables):
   ```bash
   VITE_API_BASE_URL=          # leave EMPTY — you'll set the server URL per-device
   VITE_APP_NAME=Heiken
   VITE_ENABLE_PWA=true
   ```
3. **Deploy** → "Trigger deploy" → "Deploy site". The first build takes ~1 min.
4. **Test:** open `https://<your-site>.netlify.app` — you should see the
   **Heiken login screen** with an "API @ … — unreachable ✗" chip. That's
   expected until Part 2 is up.

---

## Part 2 — The engine on your laptop + Cloudflare tunnel

### 2a. Get the code & install cloudflared (once)

```bash
cd ~
git clone https://github.com/Chege-Samwel/seedbox-lite.git   # or use your download
cd seedbox-lite

# cloudflared (Ubuntu/Debian) — free, gives you a public https URL:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb
```

### 2b. Set the engine env (one-time)

```bash
cp .env.example .env
nano .env        # fill in:
#   ADMIN_PASSWORD=<your strong admin key>   ← change this
#   LITE_MODE=true
#   DISABLE_TRANSCODE=true
#   MAX_ACTIVE_TORRENTS=5                    ← ≈5 viewers
#   FRONTEND_URL=https://<your-site>.netlify.app
```

### 2c. Go live (every time you want it on)

```bash
./scripts/tunnel.sh
```

- It starts the engine (`npm start`) **and** opens the tunnel.
- It prints `https://<random>.trycloudflare.com` — **that's your server URL**.
- The owner ticket prints in the server log on **first boot only** — copy it
  (`SB-XXXX-XXXX`). Lost it? `npm run tickets`.
- Ctrl+C stops both.

> **Quick tunnel URL changes every run.** On each device, when the URL
> changes, just update the **"Server address" box on the Heiken login
> screen** (no Netlify rebuild). For a permanent URL, set up a named tunnel
> once (see `DEPLOYMENT.md` §C2) and put it in `VITE_API_BASE_URL` instead.

### 2d. Permanent URL (you already created a named tunnel — finish it)

You created the tunnel **"Heiken"** in the Cloudflare dashboard — it's
**healthy** but has **0 routes**, which is why it serves nothing yet. To make
the link **fixed** (e.g. `https://heiken.yourdomain.com`):

1. **Add a route** (Cloudflare dashboard → your tunnel "Heiken" → **Routes →
   Add route**):
   - **Hostname:** `heiken.<your-domain.com>` (a subdomain of a domain on
     your Cloudflare account)
   - **Service:** `http://localhost:3000` (the engine on your laptop)
2. **Run the tunnel on the laptop** (needs the tunnel token/credentials — the
   dashboard "Install and run" gives you the command, or if you installed
   cloudflared locally):
   ```bash
   cloudflared tunnel run heiken
   ```
3. The tunnel now serves the **whole Heiken app** (UI + API) at the fixed URL.
4. Since the URL never changes, you can **bake it into the UI** instead of
   typing it per-device: set `VITE_API_BASE_URL=https://heiken.your-domain.com`
   in Netlify's env vars, redeploy. **Then the "Server address" box is never
   needed** on any device.

> The dashboard shows **1 active replica** (your EliteBook, IP
> `102.206.97.58`, healthy) — that's the tunnel process already running.
> Adding the route + DNS is all that's missing for a permanent link.

---

## Part 3 — Phones & Android TV

**Heiken is a PWA + HTML5 app** — no app store needed.

### Android phones
1. Open `https://<your-site>.netlify.app` in Chrome.
2. First visit: tap the **"Server address"** section on the login screen,
   paste the current tunnel URL, tap **Use this server** → the chip turns
   green "reachable ✓".
3. Enter your ticket → you're in.
4. **Install like an app:** Chrome menu → **"Add to Home screen"** → "Heiken"
   opens fullscreen, standalone.

### Android smart TVs
1. Open a browser on the TV — **TV Bro** (free, remote-friendly) or any
   Chromium-based TV browser. (Google TV / Android TV Chrome works too.)
2. Go to the Netlify URL, set the server address, log in.
3. Everything is **remote (D-pad) friendly**: cards, buttons, tabs and the
   player respond to arrow keys + Enter (the player already maps
   `←`/`→` = ±10s seek, `Space` = play/pause, `F` = fullscreen, `M` = mute).
4. Add to home screen if your TV browser supports it (TV Bro does).

> 💾 Want a real installable **APK** (side-load, no Play Store) instead of the
> PWA? See **[ANDROID-APK.md](ANDROID-APK.md)** — phones and Android TV,
> no domain required.

### "Do I need a real Android app (APK) for phones/TVs?"

**No — Heiken is a PWA, and that's the right call here.** A Play Store APK
would just be a thin wrapper around this same website, needs a $25 Play
developer account, must be side-loaded or distributed per device, and gives
you nothing extra. The PWA:

- **Installs like an app**: Chrome menu → **"Add to Home screen"** →
  gets its own icon, opens fullscreen standalone, lives in the app drawer.
  Heiken shows an **install hint** on first visits (it listens for the
  browser's install prompt and falls back to a "how to" note on devices
  that don't fire one, like some TV browsers).
- **Works on both** Android phones and Android TV with the same URL — no
  APK to build/sign/maintain, no app-store approval.
- **One codebase = one deploy** (your Netlify build). Update once,
  every device gets it on next load.

### Notes that make it work well on TV/phone
- Video plays **inline** (no pop-out player) and the custom player handles
  fullscreen — including `x5`/`webkit-playsinline` for Android WebViews.
- Poster images lazy-load; the UI is responsive down to phone sizes.

---

## Part 4 — "It supports about 5 connections, right?"

Yes, comfortably, with these settings:

| Resource | ~5 viewers | Why |
|---|---|---|
| **Upload bandwidth** | 5 × 3–8 Mbps ≈ 15–40 Mbps up | Home fibre up (10–50 Mbps) is enough; 480p files need less |
| **Concurrent torrents** | `MAX_ACTIVE_TORRENTS=5` | 5 different movies at once; beyond → friendly 429 |
| **Live streams** | `MAX_STREAM_RESPONSES=12` (lite default) | headroom over 5 |
| **RAM / CPU** | ~420 MB RSS cap, transcode off | LITE_MODE profile keeps the laptop cool |
| **Peers per torrent** | 30 (lite) | plenty for a household |

If a 6th device joins mid-stream it still works (streams aren't hard-capped),
but a 6th *different* movie may get a "server at capacity — try again shortly"
message until an old one is reaped (idle torrents drop after ~6 min).

---

## Part 5 — Env reference (quick copy-paste)

### Netlify UI — environment variables
```bash
VITE_API_BASE_URL=                    # empty = per-device server address on login
VITE_APP_NAME=Heiken
VITE_APP_VERSION=1.0.0
VITE_ENABLE_PWA=true
VITE_ENABLE_ANALYTICS=false
```

### Laptop engine — `.env`
```bash
SERVER_PORT=3000
SERVER_HOST=0.0.0.0
ADMIN_PASSWORD=<change-me>
REQUIRE_AUTH=true
SESSION_TTL_DAYS=7
DEFAULT_TICKET_DAYS=30
FRONTEND_URL=https://<your-site>.netlify.app
LITE_MODE=true
DISABLE_TRANSCODE=true
MAX_ACTIVE_TORRENTS=5
NODE_ENV=production
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Login chip says **"unreachable ✗"** | Tunnel not running → run `./scripts/tunnel.sh`. Or the server-address box has a stale URL → paste the current one. |
| UI loads but **login bounces** from another device | That device's saved server address is stale → update it on its login screen. |
| **429 / "at capacity"** when adding a movie | Too many different movies at once — wait ~6 min (idle reaper) or raise `MAX_ACTIVE_TORRENTS`. |
| **Plays but stutters on TV** | Try 480p in the quality menu (lighter on your upload) or a smaller file. |
| Tunnel URL **changed** | Update the server-address box on each device — no rebuild needed. |
| Netlify build fails | Verify Part 1 build settings (base `client`, command `npm ci && npm run build`, publish `dist`) and that UI fields are blank so `netlify.toml` applies. |
