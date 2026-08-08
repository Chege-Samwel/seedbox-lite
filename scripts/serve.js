#!/usr/bin/env node
/**
 * Heiken launcher — backend-only. `npm start` / `npm run serve`.
 *
 * In the split-hosting setup the FRONTEND lives on Netlify (static), so
 * this machine only runs the torrent engine / API. Nothing here builds or
 * serves the client — that's Netlify's job. The laptop stays light.
 *
 * What it does:
 *   1. Starts the server (light profile by default — override via env).
 *   2. Waits for /api/health.
 *   3. Prints the LAN URL and (optionally) starts ngrok — see `npm run ngrok`.
 *
 * Env:
 *   SERVE_UI=1                 also serve the built client from :3000
 *                              (all-in-one mode, no separate host)
 *   AUTO_TUNNEL=0              disable auto-ngrok
 *   NGROK_URL=https://...      your fixed ngrok domain (optional)
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const PORT = process.env.SERVER_PORT || 3000;
const AUTO_TUNNEL = process.env.AUTO_TUNNEL !== '0';
const NGROK_URL = (process.env.NGROK_URL || '').trim();
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

// Start the server — balanced profile by default (explicit env vars win).
// Previous lite defaults disabled transcode, which broke MKV playback on Netlify (NotSupportedError).
// Now: transcode enabled when ffmpeg present, original quality default (client uses 'source').
console.log(`[+${secs()}] 🌱 Starting Heiken server…`);
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' };
if (env.LITE_MODE === undefined) env.LITE_MODE = 'false';
if (env.DISABLE_TRANSCODE === undefined) env.DISABLE_TRANSCODE = 'false';
if (env.MAX_ACTIVE_TORRENTS === undefined) env.MAX_ACTIVE_TORRENTS = '5';
console.log(`[+${secs()}] 🍃 Profile: LITE_MODE=${env.LITE_MODE} DISABLE_TRANSCODE=${env.DISABLE_TRANSCODE} MAX_ACTIVE_TORRENTS=${env.MAX_ACTIVE_TORRENTS}`);
const server = spawn('node', ['index.js'], { cwd: path.join(root, 'server'), env, stdio: 'inherit' });

let stopped = false;
function stopAll(code) {
  if (stopped) return;
  stopped = true;
  try { server.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => process.exit(code || 0), 300);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
server.on('exit', (code) => { if (!stopped) stopAll(code || 0); });

function waitHealth(cb, tries = 45) {
  const probe = () => {
    if (server.exitCode != null) {
      console.error('✖ Server exited before becoming healthy — see log above.');
      stopAll(server.exitCode || 1);
      return;
    }
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      if (res.statusCode === 200) return cb();
      retry();
    });
    req.on('error', retry);
  };
  const retry = () => {
    if (tries-- <= 0) {
      console.error(`✖ Timed out waiting for Heiken API to respond on http://localhost:${PORT}/api/health`);
      console.error('👉 Make sure no other process is blocking port ' + PORT + ', or run: cd server && node index.js directly to inspect logs.');
      stopAll(1);
      return;
    }
    setTimeout(probe, 1000);
  };
  probe();
}

waitHealth(() => {
  console.log(`[+${secs()}] ✅ Heiken API up at http://localhost:${PORT}`);
  // Local network URL (phones/TVs on the same Wi-Fi can use this directly)
  console.log(`[+${secs()}] 📶 LAN URL: http://<this-machine-ip>:${PORT}  (same Wi-Fi devices)`);

  if (!AUTO_TUNNEL) {
    console.log(`[+${secs()}] ℹ️  AUTO_TUNNEL=0 — not starting a tunnel. Run \`npm run ngrok\` in another terminal when ready.`);
    return;
  }
  // Just print the instruction — the tunnel runs in its OWN terminal via
  // `npm run ngrok`, so Ctrl+C here never kills it and you can restart the
  // server without the public URL dropping.
  console.log(`[+${secs()}] 🔗 To expose publicly, open a SECOND terminal and run:  npm run ngrok`);
});

// If ngrok was asked to start inline (not the default), do it after ready.
// (Kept minimal: the split terminal is the recommended flow.)
