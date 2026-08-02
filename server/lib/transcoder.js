/**
 * On-demand H.264/AAC transcoder — "various qualities from one big source".
 *
 * Spawns ffmpeg reading the torrent THROUGH OUR OWN range-capable stream
 * endpoint (ffmpeg seeks with HTTP Range + `-ss`), and pipes fragmented MP4
 * (empty_moov → starts instantly, no moov-atom wait) back to the player.
 *
 *  - One ffmpeg process per (hash, file, quality, position) request; kill on
 *    client disconnect; idle/global caps protect small laptops.
 *  - Absolute media timestamps (`-output_ts_offset`) so the player's clock,
 *    scrubber and subtitle cues line up with the original film time.
 *  - Backpressure pacing: Node's pipe throttles ffmpeg to consumption speed,
 *    so CPU bursts are limited to filling the player's buffer.
 */
const { spawn, execFile } = require('child_process');
const os = require('os');

const PRESET = process.env.TRANSCODE_PRESET || 'veryfast'; // veryfast ≈ realtime+ on a 2-core U-series at 720p
const MAX_SESSIONS = parseInt(process.env.TRANSCODE_MAX_SESSIONS || '2', 10);
const IDLE_KILL_MS = parseInt(process.env.TRANSCODE_IDLE_MS || '300000', 10); // 5 min

/** Quality ladder. `w` = max width, never upscales. Rates keep laptop CPU sane. */
const PRESETS = {
  '1080p': { w: 1920, crf: 25, maxrate: '4500k', ab: '128k', cpu: 'heavy' },
  '720p': { w: 1280, crf: 26, maxrate: '2600k', ab: '128k', cpu: 'recommended' },
  '480p': { w: 854, crf: 27, maxrate: '1400k', ab: '96k', cpu: 'light' },
  '360p': { w: 640, crf: 28, maxrate: '800k', ab: '80k', cpu: 'lightest' },
};
const DEFAULT_QUALITY = process.env.TRANSCODE_DEFAULT || '720p';

let ffmpegPath = null;
let probing = false;

function candidates() {
  const list = ['ffmpeg']; // system first (properly packaged for the distro)
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath) list.push(staticPath); // zero-setup bundled fallback
  } catch (_) { /* optional dep absent — fine */ }
  return list;
}

/** Async availability probe (safe to call repeatedly). */
function probe(cb) {
  if (ffmpegPath) return cb(ffmpegPath ? info(ffmpegPath) : null);
  if (probing) return cb(null);
  probing = true;
  const list = candidates();
  const tryNext = (i) => {
    if (i >= list.length) {
      probing = false;
      ffmpegPath = null;
      return cb(null);
    }
    execFile(list[i], ['-version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return tryNext(i + 1);
      probing = false;
      ffmpegPath = list[i];
      const m = String(stdout || '').match(/ffmpeg version (\S+)/);
      ffmpegVersion = m ? m[1] : 'unknown';
      cb(info());
    });
  };
  tryNext(0);
}

let ffmpegVersion = null;
let detectError = 'ffmpeg not found — install it (Ubuntu: sudo apt install ffmpeg) or add the ffmpeg-static package';
function info() { return { path: ffmpegPath, version: ffmpegVersion }; }

function available() { return !!ffmpegPath; }

function presetsForStatus() {
  return Object.entries(PRESETS).map(([q, p]) => ({
    quality: q, maxWidth: p.w, crf: p.crf, maxRate: p.maxrate, audio: p.ab, note: p.cpu,
  }));
}

const sessions = new Map(); // key → { proc, startedAt, key }

function kill(key, why) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  try { s.proc.kill('SIGKILL'); } catch (_) { /* fine */ }
  if (why) console.log(`🎞️ Transcode[${key}] stopped — ${why}`);
}

function killIdle() {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.startedAt > IDLE_KILL_MS) kill(key, 'idle');
  }
}
setInterval(killIdle, 30000).unref?.();

/**
 * Start (or restart) a transcode stream into an HTTP response.
 *
 * @param {object} o
 * @param {string} o.srcUrl     absolute URL of OUR range-capable torrent stream
 * @param {string} o.quality    one of PRESETS keys
 * @param {number} o.startSecs  absolute film time to begin from (seek)
 * @param {string} o.token      session token (kept out of logs)
 * @param {import('http').ServerResponse} o.res
 * @param {string} o.label      for logs
 */
function transcodeInto({ srcUrl, quality, startSecs = 0, token, res, label }) {
  if (!ffmpegPath) return { ok: false, error: detectError || 'ffmpeg unavailable' };
  const q = PRESETS[quality] ? quality : DEFAULT_QUALITY;
  const p = PRESETS[q];
  const t = Math.max(0, Number(startSecs) || 0);
  const key = `${label}:${q}:${Math.round(t / 600)}`; // one per 10-min block per quality

  // Same key (quality + 10-min block, e.g. a seek inside it): kill the stale
  // process first, or seeks silently leak ffmpeg sessions.
  if (sessions.has(key)) kill(key, 'restarted');

  // Capacity guard: evict the oldest session rather than runaway CPU
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest) kill(oldest[0], 'capacity');
  }

  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', t.toFixed(3),
    '-seekable', '1',
    '-i', srcUrl,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', `scale='min(${p.w},iw)':-2`,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', String(p.crf),
    '-maxrate', p.maxrate, '-bufsize', `${parseInt(p.maxrate, 10) * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', p.ab, '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-output_ts_offset', t.toFixed(3), // absolute film timestamps → scrubber/subs align
    '-f', 'mp4', 'pipe:1',
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  sessions.set(key, { proc, startedAt: Date.now() });

  let stderrTail = '';
  proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
  proc.on('error', (err) => {
    kill(key);
    if (!res.headersSent) res.status(500).json({ error: `ffmpeg failed to start: ${err.message}` });
  });
  proc.on('exit', (code) => {
    sessions.delete(key);
    if (code && code !== 255 && !res.writableEnded) {
      console.warn(`🎞️ Transcode[${key}] exited ${code}: ${stderrTail.slice(-300)}`);
      if (!res.headersSent) res.status(500).json({ error: 'Transcode failed' });
      else res.end();
    }
  });

  res.on('close', () => kill(key, 'client disconnected'));

  const startedAt = Date.now();
  proc.stdout.once('data', () => {
    console.log(`🎞️ Transcode[${key}] streaming ${q} from ${(t / 60).toFixed(1)}min — first bytes in ${Date.now() - startedAt}ms`);
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache, no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Transcode-Quality': q,
  });
  // Backpressure pacing: pipe() applies flow control, ffmpeg blocks on its
  // stdout buffer and naturally throttles to the player's consumption.
  // An unhandled stdout 'error' would be an uncaught exception → whole
  // process down; swallow it and let the session cleanup path finish.
  proc.stdout.on('error', () => { try { if (!res.writableEnded) res.end(); } catch (_) { /* fine */ } });
  res.on('error', () => { try { proc.kill('SIGKILL'); } catch (_) { /* fine */ } });
  proc.stdout.pipe(res);
  return { ok: true, quality: q, key };
}

function stats() {
  return { available: available(), sessions: sessions.size, maxSessions: MAX_SESSIONS, cpus: os.cpus()?.length };
}

module.exports = { transcodeInto, probe, available, presetsForStatus, stats, PRESETS, DEFAULT_QUALITY };
