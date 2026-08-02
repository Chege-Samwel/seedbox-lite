# Deployment Guide — Small Hosts, Free Tiers & Cooling It Down

This document is deliberately honest about what Seedbox Lite costs to run,
because the architecture has two very different halves with very different
appetites:

| Half | What it does | CPU | RAM | Where it can live |
|---|---|---|---|---|
| **Control plane** | Web UI + API: tickets/auth, Internet Archive browsing, metadata, history, show tracking | ~0 (bursts only) | 80–150 MB | Anywhere, incl. free tiers |
| **Data plane** | WebTorrent engine (swarm I/O + SHA‑1 piece verification), the rolling disk store, warmup windows, and optionally **ffmpeg transcoding** | 0.3–1+ core per active stream; **~1 core per 720p transcode** | 300–700 MB observed with one active 3.6 GB torrent (defaults capped at 1400 MB RSS) | Real machine only |

## Can it run on Render / Railway free tier (512 MB, ~0.1 CPU)?

**The whole app: no. The frontend alone: yes.**

Measured and structural reasons:

1. **CPU.** Every byte a viewer watches is received over the swarm *and*
   SHA‑1 verified. On 0.1 of a shared core that verification alone starves;
   add swarm protocol churn and the rolling store and you are permanently in
   the throttle bin. ffmpeg transcoding (the quality ladder) needs ~1 full
   core per session — **it simply cannot run on 0.1 CPU**, even at 360p.
2. **RAM.** Field logs from a single stream show RSS steady‑climbing past
   700 MB with the normal profile. 512 MB with no swap = OOM‑killed,
   usually mid‑movie. `LITE_MODE` shrinks the budget to ~420 MB, which
   fits — but see CPU above, it still won't play well.
3. **Bandwidth math for 3–5 users.** Streaming is proxied *through* the
   server, so egress ≈ file size per watch (+ ~10% protocol overhead).
   One 3.6 GB watch ≈ 3.6 GB out. Free tiers include on the order of
   100 GB/month → ~25 watches/month for the *whole household*. It's only
   viable with 480‑line files (~700 MB): ~130 watches/month.
4. **Platform friction.** Free web services sleep on idle (cold starts
   break in‑progress streams), disks are ephemeral (downloads vanish on
   redeploy), long‑lived range requests and dozens of P2P connections are
   not what those boxes are shaped for — and many PaaS acceptable‑use
   policies restrict peer‑to‑peer traffic on shared IPs. Check yours.

**Verdict:** don't put the torrent engine on Render/Railway free. Do this:

## Recommended topologies

### A. Split deployment (best free setup) — frontend on the free tier, engine at home

```
[ phones/laptops ] → https://your-app.onrender.com  (static client, free)
                              │  VITE_API_BASE_URL=https://home.example.com
                              ▼
              [ your EliteBook / always‑on box at home ]
              node server (data plane + control plane)
              exposed via Cloudflare Tunnel or Tailscale Funnel
```

1. `cd client && npm run build`
2. Deploy `client/dist` as a **static site** (Render Static, Netlify,
   Vercel, GitHub Pages) with env `VITE_API_BASE_URL=https://<your tunnel hostname>`
   (the client already honors it — see `client/src/services/api.js`).
3. At home: `sudo apt install ffmpeg && npm run install-all && npm start` (builds the client and serves UI+API on one port)
4. Expose port 3000 via [cloudflared tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
   or `tailscale funnel` — no port‑forwarding, TLS included.
5. Set `FRONTEND_URL=https://your-app.onrender.com` so CORS allows it.

Cost: $0. Streams travel home → tunnel → viewer, using *your* upload
bandwidth (home fibre 10–50 Mbps up is plenty for 3–5 users), and the
server IP never touches a swarm from a datacenter.

### B. All‑in‑one on a small VPS ($4–6)

A Hetzner CX11 / Contabo / Oracle Free ARM box (2 GB RAM, 1–2 vCPU) runs
the whole thing comfortably for 3–5 users. Use `LITE_MODE=true` plus
`MAX_ACTIVE_TORRENTS=3`. Transcoding 720p is feasible (1 core per session);
keep `TRANSCODE_MAX_SESSIONS=1` on 1 vCPU.

### C. Just your laptop (what you have today)

Perfectly fine for 3–5 users — see "Cooling it down" to make it quiet.

## LITE_MODE — the small‑host profile

`LITE_MODE=true` flips the whole budget in one flag (every value can be
overridden individually; explicit env vars always win):

| Knob | Normal | LITE_MODE |
|---|---|---|
| `WT_MAX_CONNS` | 150 | 30 |
| `WINDOW_BACK_MIN` / `WINDOW_AHEAD_MIN` | 5 / 5 | 2 / 3 |
| `LAST_REGION_KEEP_MIN` | 4 | 2 |
| `IDLE_TORRENT_TTL_MIN` | 10 | 6 |
| `MAX_RSS_MB` | 1400 | 420 |
| `WARM_DEFAULT_MB` / `WARM_READY_MIN_MB` | 32 / 8 | 16 / 4 |
| `WARM_WINDOW_KEEP_MIN` | 4 | 2 |
| `MAX_ACTIVE_TORRENTS` | 0 (unlimited) | 2 (extras get HTTP 429 + auto‑retry UX) |
| Transcoding | on (if ffmpeg found) | **off** (`DISABLE_TRANSCODE=true` does just this) |
| `STREAM_SETUP_TIMEOUT_MS` | 60000 | 45000 |
| `BROWSE_CACHE_MIN` | 10 | 30 |

Extra honest limiting: even in LITE_MODE, a 512 MB + 0.1 CPU box is only
suitable for serving the **UI + API + direct download of small files**,
not for comfortable in‑browser movie streaming, and never for transcoding.

## "Simple rendering and download" mode

If all you need is *browse → render the UI → download the file* (no
in‑browser playback machinery, no quality ladder):

```bash
LITE_MODE=true DISABLE_TRANSCODE=true MAX_ACTIVE_TORRENTS=2 npm start
```

That configuration is as close to "static site + file fetcher" as this
stack gets, and it's the only mode worth attempting on a free tier —
expect it to work for documents/ISOs/small videos, not 1080p movie night.

## Why your laptop heats up — the compute budget, line by line

| Source | Cost | Mitigation |
|---|---|---|
| **Vite dev server + HMR** (`npm run dev`) | An entire second Node process with file watchers; often the single hottest thing on a laptop | Run production instead: `cd client && npm run build`, then `NODE_ENV=production npm start` — one process, no watchers |
| SHA‑1 piece verification | Every byte watched is hashed (≈ a few % of one core at streaming bitrates — fine, but non‑zero) | None needed; it's unavoidable integrity work |
| **Dead/fake swarms** | A "1080p" magnet with 0 real seeders spins warmup, DHT, and tracker retries forever — this is the field‑log heater | Now handled: warmup reports `stalled` after ~45 s without progress, the player *says so* and polls at ¼ rate; pick another source |
| Rolling disk store | Streams pieces to disk, evicts the trailing edge every few seconds | Lower `WINDOW_AHEAD_MIN` / `WARM_DEFAULT_MB` |
| ffmpeg transcoding | ~100 % of one core per 720p session | `DISABLE_TRANSCODE=true`, or only enable on demand |
| Many parallel torrents | Each active torrent holds buffers + connections | `MAX_ACTIVE_TORRENTS=2` (429 for extras) |

Quick cool‑laptop recipe:

```bash
LITE_MODE=true npm start          # production client build + lite budget
```

## Player resilience (timeout behavior)

The old failure — server setup timeout ⇒ dead video element ⇒ playback
stops — is gone:

- Stream setup timeout now answers **503 + Retry‑After** (it used to hang
  or 504 into the void).
- The player **auto‑reconnects in place at the playhead** with exponential
  backoff (1 s → 15 s, up to 8 attempts), shows a live
  "reconnecting · attempt n" pill, and only falls back to the full warmup
  gate after repeated failures — it never silently gives up and stops.
- A 15‑second mid‑play starve watchdog does the same reattach.
- Dead swarms are reported as **stalled** (45 s without byte progress) so
  you get "this swarm is dead/fake — pick another source" instead of an
  infinite spinner.

---

## Appendix: classic PM2 deployment & CORS checklist

From the original deployment guide (still accurate for a two-domain VPS
setup; ticket auth replaced the old `ACCESS_PASSWORD`):

**Backend (PM2):**

```bash
cd server
mkdir -p logs
pm2 start ecosystem.config.js
# or manually:
NODE_ENV=production SERVER_PORT=3001 SERVER_HOST=0.0.0.0 \
  FRONTEND_URL=https://seedbox.<domain> node index.js
```

**Frontend (rebuild with the production API URL, then serve statically):**

```bash
cd client
VITE_API_BASE_URL=https://seedbox-api.<domain> npm run build
```

**Verify CORS:**

```bash
pm2 logs seedbox-backend --lines 20
curl https://seedbox-api.<domain>/api/health
curl -H "Origin: https://seedbox.<domain>" https://seedbox-api.<domain>/api/health
```

The server reads `FRONTEND_URL` for its CORS allow-list; set both the
frontend and API domains there when they differ.
