#!/usr/bin/env node
/**
 * Heiken launcher — `npm start` entry.
 *
 * Builds the client, starts the server, and THEN auto-starts an ngrok
 * tunnel to the server port so the app is publicly reachable without any
 * extra command. Prints the public URL.
 *
 * Behavior knobs (env):
 *   NGROK_URL=https://heiken.ngrok-free.app   your claimed static ngrok
 *                                             domain (fixed URL). Omit to
 *                                             let ngrok assign a random one.
 *   AUTO_TUNNEL=0                             disable auto-ngrok entirely.
 *
 * If ngrok is not installed, or has no authtoken configured, the server
 * still runs normally (it just prints how to enable the tunnel).
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const PORT = process.env.SERVER_PORT || 3000;
const AUTO_TUNNEL = process.env.AUTO_TUNNEL !== '0';
const NGROK_URL = (process.env.NGROK_URL || '').trim();

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

// 1) Build the client (same as the old `npm start` did)
console.log('🏗️  Building client…');
const build = spawnSync('npm', ['run', 'build'], { cwd: path.join(root, 'client'), stdio: 'inherit' });
if (build.error || build.status !== 0) {
  console.error('✖ Client build failed — see output above.');
  process.exit(build.status || 1);
}

// 2) Start the server
console.log('🌱 Starting Heiken server…');
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' };
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
  console.log(`✅ Heiken API up at http://localhost:${PORT}`);

  if (!AUTO_TUNNEL) {
    console.log('ℹ️  AUTO_TUNNEL=0 — not starting a tunnel. (npm start runs it by default.)');
    return;
  }
  if (!hasNgrok()) {
    console.log('ℹ️  ngrok not found — running without a tunnel. Install it for a public URL:');
    console.log('      https://ngrok.com/download   then:  ngrok config add-authtoken <your-token>');
    console.log('   (or set AUTO_TUNNEL=0 to silence this hint)');
    return;
  }
  if (!ngrokConfigured()) {
    console.log('ℹ️  ngrok is installed but not configured. One-time setup:');
    console.log('      ngrok config add-authtoken <your-token>   (from https://dashboard.ngrok.com)');
    console.log('   Server keeps running without a tunnel until then.');
    return;
  }

  const args = ['http', String(PORT)];
  if (NGROK_URL) {
    args.push('--url', NGROK_URL);
    console.log(`🔗 Starting ngrok → static domain ${NGROK_URL}`);
  } else {
    console.log('🔗 Starting ngrok… (set NGROK_URL=https://heiken.ngrok-free.app for a fixed URL)');
  }
  ngrok = spawn('ngrok', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  ngrok.on('exit', (code) => {
    if (!stopped && code) console.warn('⚠️  ngrok exited — check the message above (wrong static domain? run once with `ngrok http 3000` to claim one).');
  });
  ngrokPublicUrl((url) => {
    if (url) {
      console.log('\n══════════════════════════════════════════════════════════');
      console.log(`  🌐 PUBLIC URL: ${url}`);
      console.log('  Paste it into the login screen "Server address" on each device.');
      console.log('══════════════════════════════════════════════════════════\n');
    } else {
      console.log('⚠️  Could not read the ngrok URL from its local API — check http://127.0.0.1:4040');
    }
  });
});
