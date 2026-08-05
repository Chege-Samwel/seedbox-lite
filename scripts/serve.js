#!/usr/bin/env node
/**
 * Heiken launcher — `npm start` entry.
 *
 * Builds the client ONLY when it's stale, starts the server, then
 * auto-starts an ngrok tunnel. Prints the public URL and per-phase timing
 * so slow steps are visible.
 *
 * Why the conditional build: a full `vite build` runs 3s here / 10-30s on a
 * laptop on EVERY start. Now the client is rebuilt only when a source file
 * is newer than client/dist (or dist is missing). Control it with env:
 *   SKIP_BUILD=1    never build (use existing dist)
 *   FORCE_BUILD=1   always build
 *
 * Tunnel control:
 *   NGROK_URL=https://heiken.ngrok-free.app   your claimed static ngrok
 *                                             domain (fixed URL).
 *   AUTO_TUNNEL=0                             disable auto-ngrok entirely.
 *
 * If ngrok is not installed/configured, the server still runs normally.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const root = path.join(__dirname, '..');
const PORT = process.env.SERVER_PORT || 3000;
const AUTO_TUNNEL = process.env.AUTO_TUNNEL !== '0';
const NGROK_URL = (process.env.NGROK_URL || '').trim();
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

function hasNgrok() {
  try {
    const r = spawnSync('ngrok', ['version'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch { return false; }
}
function ngrokConfigured() {
  try {
    const r = spawnSync('ngrok', ['config', 'check'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch { return false; }
}

/** Is client/dist missing or older than any source file? */
function clientNeedsBuild() {
  if (process.env.FORCE_BUILD === '1') return true;
  if (process.env.SKIP_BUILD === '1') return false;
  const distIndex = path.join(root, 'client', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) return true;
  const distTime = fs.statSync(distIndex).mtimeMs;
  const watchDirs = ['src', 'public', 'vite.config.js', 'package.json', 'index.html'];
  const newest = watchDirs.reduce((max, rel) => {
    const p = path.join(root, 'client', rel);
    if (!fs.existsSync(p)) return max;
    if (fs.statSync(p).isDirectory()) {
      let m = 0;
      for (const f of fs.readdirSync(p)) {
        const fp = path.join(p, f);
        try { m = Math.max(m, fs.statSync(fp).mtimeMs); } catch { /* ignore */ }
      }
      return Math.max(max, m);
    }
    return Math.max(max, fs.statSync(p).mtimeMs);
  }, 0);
  return newest > distTime;
}

// 1) Build the client only when stale
if (clientNeedsBuild()) {
  console.log(`[+${secs()}] 🏗️  Client is stale — building (one-time, ~3s here, longer on a laptop)…`);
  const build = spawnSync('npm', ['run', 'build'], { cwd: path.join(root, 'client'), stdio: 'inherit' });
  if (build.error || build.status !== 0) {
    console.error('✖ Client build failed — see output above.');
    process.exit(build.status || 1);
  }
} else {
  console.log(`[+${secs()}] ✓ Client up to date — skipping build (use FORCE_BUILD=1 or SKIP_BUILD=1 to control).`);
}

// 2) Start the server — light profile by default (explicit env vars win).
console.log(`[+${secs()}] 🌱 Starting Heiken server…`);
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' };
if (env.LITE_MODE === undefined) env.LITE_MODE = 'true';
if (env.DISABLE_TRANSCODE === undefined) env.DISABLE_TRANSCODE = 'true';
if (env.MAX_ACTIVE_TORRENTS === undefined) env.MAX_ACTIVE_TORRENTS = '5';
console.log(`[+${secs()}] 🍃 Profile: LITE_MODE=${env.LITE_MODE} DISABLE_TRANSCODE=${env.DISABLE_TRANSCODE} MAX_ACTIVE_TORRENTS=${env.MAX_ACTIVE_TORRENTS}`);
const server = spawn('node', ['index.js'], { cwd: path.join(root, 'server'), env, stdio: 'inherit' });

let ngrok = null;
let stopped = false;

function stopAll(code) {
  if (stopped) return;
  stopped = true;
  if (ngrok) { try { ngrok.kill('SIGTERM'); } catch { /* ignore */ } }
  try { server.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => process.exit(code || 0), 300);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
server.on('exit', (code) => { if (!stopped) stopAll(code || 0); });

// 3) Wait for the API, then start ngrok
function waitHealth(cb, tries = 90) {
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
  const retry = () => { if (tries-- <= 0) return cb(); setTimeout(probe, 1000); };
  probe();
}

function ngrokPublicUrl(cb) {
  const check = (n) => {
    const req = http.get({ host: '127.0.0.1', port: 4040, path: '/api/tunnels', timeout: 1500 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try {
          const tunnels = JSON.parse(d).tunnels || [];
          const t = tunnels.find((x) => x.public_url && x.public_url.startsWith('https://'));
          if (t) return cb(t.public_url);
        } catch { /* not ready yet */ }
        if (n <= 0) return cb(null);
        setTimeout(() => check(n - 1), 1000);
      });
    });
    req.on('error', () => { if (n <= 0) cb(null); else setTimeout(() => check(n - 1), 1000); });
  };
  check(20);
}

waitHealth(() => {
  console.log(`[+${secs()}] ✅ Heiken API up at http://localhost:${PORT}`);

  if (!AUTO_TUNNEL) {
    console.log(`[+${secs()}] ℹ️  AUTO_TUNNEL=0 — not starting a tunnel.`);
    return;
  }
  if (!hasNgrok()) {
    console.log(`[+${secs()}] ℹ️  ngrok not found — running without a tunnel. Install it for a public URL:`);
    console.log('      https://ngrok.com/download   then:  ngrok config add-authtoken <your-token>');
    return;
  }
  if (!ngrokConfigured()) {
    console.log(`[+${secs()}] ℹ️  ngrok installed but not configured. One-time setup:`);
    console.log('      ngrok config add-authtoken <your-token>   (from https://dashboard.ngrok.com)');
    return;
  }

  const args = ['http', String(PORT)];
  if (NGROK_URL) {
    args.push('--url', NGROK_URL);
    console.log(`[+${secs()}] 🔗 Starting ngrok → static domain ${NGROK_URL}`);
  } else {
    console.log(`[+${secs()}] 🔗 Starting ngrok… (set NGROK_URL=https://heiken.ngrok-free.app for a fixed URL)`);
  }
  ngrok = spawn('ngrok', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  ngrok.on('exit', (code) => {
    if (!stopped && code) console.warn('⚠️  ngrok exited — check the message above.');
  });
  ngrokPublicUrl((url) => {
    if (url) {
      console.log(`[+${secs()}]`);
      console.log('══════════════════════════════════════════════════════════');
      console.log(`  🌐 PUBLIC URL: ${url}`);
      console.log('  Paste it into the login screen "Server address" on each device.');
      console.log('══════════════════════════════════════════════════════════');
    } else {
      console.log(`[+${secs()}] ⚠️  Could not read the ngrok URL from its local API — check http://127.0.0.1:4040`);
    }
  });
});
