/**
 * Feature router — tickets/auth, admin, RSS home catalog + Internet Archive
 * browsing, metadata/picture library, and per-user pipeline/history/show-tracking.
 *
 * Mounted from index.js right after express.json() so that the torrent-auth
 * gate registered here runs BEFORE the legacy /api/torrents routes.
 */
const crypto = require('crypto');
const authStore = require('../lib/authStore');
const { requireSession, requireAdmin, extractToken } = require('../lib/authMiddleware');
const ia = require('../lib/iaService');
const meta = require('../lib/metadataService');
const rss = require('../lib/rssService');
const userStore = require('../lib/userStore');
const tuning = require('../lib/tuning');

const VIDEO_EXTS = ['.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.avi', '.mov'];
const BROWSER_PLAYABLE_EXTS = ['.mp4', '.m4v', '.webm', '.ogv', '.mov'];

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i === -1 ? '' : name.toLowerCase().slice(i);
}

function normalizeHash(input) {
  const raw = String(input || '').trim();
  const magnetMatch = raw.match(/xt=urn:btih:([a-zA-Z0-9]{32,40})/i);
  const hash = magnetMatch ? magnetMatch[1] : (/^[a-fA-F0-9]{40}$/.test(raw) ? raw : null);
  return hash ? hash.toLowerCase() : null;
}

function timeout(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function withFallback(promise, ms, fallback) {
  return Promise.race([promise.catch(() => fallback), timeout(ms, fallback)]);
}

/**
 * Live state for a torrent. `loading` distinguishes a genuinely connecting
 * torrent from a reaped/absent one the user must wake by pressing Play.
 */
function liveState(torrent, preferredFileIndex = null, { loading = false } = {}) {
  if (!torrent || !torrent.ready) {
    return { connected: !!torrent, readyState: loading || torrent ? 'connecting' : 'sleeping' };
  }
  const files = torrent.files || [];
  let file = null;
  if (preferredFileIndex != null && files[preferredFileIndex]) {
    file = files[preferredFileIndex];
  } else {
    const videos = files.filter((f) => VIDEO_EXTS.includes(extOf(f.name)));
    file = (videos.length ? videos : files).sort((a, b) => b.length - a.length)[0] || null;
  }
  if (!file) return { connected: true, readyState: 'stored' };

  // Count contiguous buffered pieces from the start of the primary file.
  let headBytes = 0;
  try {
    const pieceLength = torrent.pieceLength;
    const startPiece = Math.floor(file.offset / pieceLength);
    const endPiece = Math.floor((file.offset + file.length) / pieceLength);
    const maxScan = Math.min(endPiece - startPiece, 512);
    let contiguous = 0;
    for (let i = 0; i <= maxScan; i++) {
      if (torrent.bitfield && torrent.bitfield.get(startPiece + i)) contiguous++;
      else break;
    }
    headBytes = Math.min(contiguous * pieceLength, file.length);
  } catch (_) { /* bitfield may be unavailable mid-init */ }

  const WARM_TARGET = Math.min(16 * 1024 * 1024, file.length); // 16MB or whole file
  const speed = torrent.downloadSpeed || 0;
  let readyState = 'connecting';
  if (file.progress >= 0.999) readyState = 'ready';
  else if (headBytes >= Math.min(WARM_TARGET, 4 * 1024 * 1024)) readyState = 'ready';
  else if (headBytes > 0 || speed > 0) readyState = 'warming';
  else if ((torrent.numPeers || 0) > 0) readyState = 'warming';

  return {
    connected: true,
    readyState, // connecting → warming → ready
    progress: torrent.progress || 0,
    downloadSpeed: speed,
    peers: torrent.numPeers || 0,
    headBytes,
    headTargetBytes: WARM_TARGET,
    fileIndex: files.indexOf(file),
    fileName: file.name,
    fileSize: file.length,
    fileDownloaded: file.downloaded || 0,
    fileProgress: file.progress || 0,
    containerPlayable: BROWSER_PLAYABLE_EXTS.includes(extOf(file.name)),
    totalSize: torrent.length || 0,
    torrentName: torrent.name || null,
  };
}

/** Resolve {fileIdx, bytePos, targetBytes} from seconds-vs-bytes request payloads. */
function resolveWarmPosition(torrent, fileIdx, body) {
  const files = torrent?.files || [];
  const file = fileIdx != null ? files[fileIdx] : null;
  const { positionSecs, durationSecs, bytePos, windowSecs } = body || {};
  let pos = Number(bytePos) || 0;
  let target = Number(body?.targetBytes) || 0;
  if (file && durationSecs > 0) {
    const bytesPerSec = file.length / durationSecs;
    if (positionSecs != null) pos = (Math.max(0, parseFloat(positionSecs) || 0)) * bytesPerSec;
    // "the starting 1 minute": 60s worth of bytes, sensible clamps
    const minW = 60;
    target = Math.max(target, bytesPerSec * Math.max(15, Math.min(parseFloat(windowSecs) || minW, 180)));
  }
  return { bytePos: pos, targetBytes: target };
}

/** Very small SRT → WebVTT converter for the subtitle proxy. */
function srtToVtt(srt) {
  const body = String(srt)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      if (/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(line)) {
        return line.replace(/,/g, '.');
      }
      return line;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

module.exports = function mount(app) {
  const wt = () => app.locals.wt || {};
  authStore.bootstrap();

  // ============ AUTH / TICKETS ============

  app.post('/api/auth/login', async (req, res) => {
    const code = req.body?.ticketCode || req.body?.ticket || req.body?.code;
    if (!code) {
      // Back-compat: fall back to legacy shared-password mode if the client
      // sent a password and no tickets are in use yet.
      if (req.body?.password !== undefined && authStore.listTickets().length === 0) {
        const correct = process.env.ACCESS_PASSWORD || 'seedbox123';
        if (req.body.password === correct) {
          const ticket = authStore.createTicket({ label: 'Owner (legacy)', note: 'Auto-created for legacy password login', daysValid: 365 });
          const result = authStore.login(ticket.code);
          return res.json({ success: true, ...result.session });
        }
        return res.status(401).json({ success: false, error: 'Invalid password' });
      }
      return res.status(400).json({ error: 'Ticket code is required' });
    }
    const result = authStore.login(code);
    if (!result.ok) return res.status(401).json({ error: result.error, reason: result.reason });
    res.json({ success: true, token: result.session.token, expiresAt: result.session.expiresAt, user: result.session.user });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = extractToken(req);
    if (token) authStore.logout(token);
    res.json({ ok: true });
  });

  app.get('/api/auth/validate', requireSession, (req, res) => {
    res.json({ valid: true, user: req.user });
  });

  // ============ ADMIN (ticket management) ============

  app.get('/api/admin/tickets', requireAdmin, (_req, res) => {
    res.json({ tickets: authStore.listTickets() });
  });

  app.post('/api/admin/tickets', requireAdmin, (req, res) => {
    const { label, note, daysValid } = req.body || {};
    const ticket = authStore.createTicket({
      label,
      note,
      daysValid: daysValid === null || daysValid === 0 ? 0 : parseFloat(daysValid || '30') || 30,
    });
    res.json({ ok: true, ticket });
  });

  app.patch('/api/admin/tickets/:id', requireAdmin, (req, res) => {
    const patch = {};
    if (req.body?.revoked !== undefined) patch.revoked = !!req.body.revoked;
    if (req.body?.renewDays !== undefined) patch.renewDays = parseFloat(req.body.renewDays) || 0;
    if (req.body?.label) patch.label = req.body.label;
    if (req.body?.note !== undefined) patch.note = req.body.note;
    const ticket = authStore.patchTicket(req.params.id, patch);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ok: true, ticket });
  });

  app.delete('/api/admin/tickets/:id', requireAdmin, (req, res) => {
    authStore.deleteTicket(req.params.id);
    res.json({ ok: true });
  });

  // ============ Gate the legacy torrent API behind sessions ============
  if (process.env.REQUIRE_AUTH !== 'false') {
    app.use('/api/torrents', requireSession);
  }

  // ============ RSS HOME CATALOG ============

  // The home feed is identical for every user. rssService keeps a short
  // server-side cache and falls back to the fixed catalog when one of the
  // supplied RSS endpoints is unavailable. Keep the legacy /api/browse/home
  // path so existing clients and saved bookmarks continue to work.
  let homeCache = { at: 0, data: null };
  app.get('/api/browse/home', requireSession, async (req, res) => {
    const now = Date.now();
    const freshMs = Math.max(1, tuning.browseCacheMin) * 60 * 1000;
    const force = req.query.refresh === '1';
    if (!force && homeCache.data && now - homeCache.at < freshMs) return res.json(homeCache.data);
    const data = await withFallback(rss.home({ force }), 18000, homeCache.data || { catalog: 'rss', rows: [], offline: true });
    homeCache = { at: now, data };
    res.json(data);
  });

  app.get('/api/rss/item/:infoHash', requireSession, async (req, res) => {
    const item = await withFallback(rss.getItem(req.params.infoHash), 12000, null);
    if (!item) return res.status(404).json({ error: 'RSS item not found' });
    res.json(item);
  });

  // Explicit feed metadata is useful to clients that want to show a source
  // menu without duplicating the URLs in the UI.
  app.get('/api/rss/feeds', requireSession, (_req, res) => {
    res.json({ feeds: rss.FEEDS });
  });

  app.get('/api/browse/search', requireSession, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [], numFound: 0 });
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const data = await withFallback(ia.search(q, { page, rows: 24 }), 15000, { results: [], error: 'Archive unavailable right now' });
    res.json(data);
  });

  app.get('/api/browse/item/:identifier', requireSession, async (req, res) => {
    const data = await withFallback(ia.item(req.params.identifier), 15000, null);
    if (!data) return res.status(502).json({ error: 'Archive item unavailable right now' });
    res.json(data);
  });

  // Subtitle proxy → guarantees CORS + converts SRT to VTT for the <track> tag
  app.get('/api/browse/subtitle', requireSession, async (req, res) => {
    const { item: identifier, file } = req.query;
    if (!identifier || !file) return res.status(400).json({ error: 'item and file are required' });
    const safeFile = String(file);
    if (safeFile.includes('..')) return res.status(400).json({ error: 'Invalid file' });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const upstream = await fetch(
        `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(safeFile)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (!upstream.ok) return res.status(502).json({ error: 'Subtitle fetch failed' });
      const text = await upstream.text();
      const isVtt = safeFile.toLowerCase().endsWith('.vtt') || text.includes('WEBVTT');
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.send(isVtt ? text : srtToVtt(text));
    } catch (err) {
      res.status(504).json({ error: 'Subtitle fetch timeout' });
    }
  });

  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');

  // Video stream proxy for archive.org media — range-aware, closed (only
  // archive.org/download URLs are constructed server-side; auth required).
  // Some IA edge nodes omit CORS headers which hard-kills <video> playback
  // from the browser (field: "blocked by CORS policy … ERR_FAILED"). The
  // player tries the CDN URL directly and falls back here at the same
  // position. This is exempt from the global 30s API timeout (index.js).
  app.get('/api/browse/stream', requireSession, async (req, res) => {
    const { item: identifier, file } = req.query;
    if (!identifier || !file) return res.status(400).json({ error: 'item and file are required' });
    const safeFile = String(file);
    if (safeFile.includes('..') || safeFile.includes('/')) return res.status(400).json({ error: 'Invalid file' });
    if (!VIDEO_EXTS.includes(extOf(safeFile))) return res.status(400).json({ error: 'Not a video file' });

    const controller = new AbortController();
    req.on('close', () => controller.abort()); // viewer left → stop pulling
    try {
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range; // scrubber needs byte ranges
      const upstream = await fetch(
        `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(safeFile)}`,
        { headers, signal: controller.signal, redirect: 'follow' }
      );
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(502).json({ error: `Archive returned HTTP ${upstream.status}` });
      }
      res.status(upstream.status === 206 ? 206 : 200);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) res.set(h, v);
      }
      if (!upstream.headers.get('content-type')) res.set('Content-Type', 'video/mp4');
      const arcOrigin = req.headers.origin || '*';
      res.set('Access-Control-Allow-Origin', arcOrigin);
      res.set('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, ngrok-skip-browser-warning');
      res.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.set('Vary', 'Origin');
      res.set('Cache-Control', 'private, max-age=3600');
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (err) {
      if (!controller.signal.aborted) {
        console.warn(`⚠️ Archive stream proxy failed for ${identifier}/${safeFile}: ${err.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Archive stream failed' });
      }
    }
  });

  // ============ METADATA / PICTURE LIBRARY ============

  app.get('/api/metadata/search', requireSession, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const type = ['movie', 'show', 'any'].includes(req.query.type) ? req.query.type : 'any';
    if (!q) return res.json({ found: false });
    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    const data = await withFallback(meta.lookup(q, { type, year }), 12000, { found: false, error: 'Metadata providers unavailable' });
    res.json(data);
  });

  app.get('/api/metadata/show', requireSession, async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const season = req.query.season ? parseInt(req.query.season, 10) : null;
    const data = await withFallback(meta.getShow(name, season), 15000, { found: false, error: 'Show data unavailable' });
    res.json(data);
  });

  // ============ PLAYER ↔ GOVERNOR HEARTBEAT ============
  // The player reports the real playhead (seconds) + media duration so the
  // window governor can size the -5m/+5m buffers precisely.
  app.post('/api/streams/heartbeat', requireSession, (req, res) => {
    const { infoHash, fileIdx = 0, position, duration } = req.body || {};
    const governor = req.app.locals.governor;
    if (!governor || !infoHash) return res.json({ ok: false });
    governor.heartbeatByFile(String(infoHash).toLowerCase(), parseInt(fileIdx, 10) || 0, {
      positionSecs: parseFloat(position) || 0,
      durationSecs: parseFloat(duration) || 0,
    });
    res.json({ ok: true });
  });

  // ============ WARMUP — starts on Play click, re-centers on seek ============
  // POST kicks loading (magnet accepted) + selects the "1 minute" window at
  // the play position; GET polls status. Every call touches the governor so
  // a warming torrent is never reaped as idle.

  function warmupPayload(req) {
    const b = req.body || req.query || {};
    return b;
  }

  function findTorrentLocal(infoHash) {
    const { client } = wt();
    if (!client || !infoHash) return null;
    return client.torrents.find((t) => t.infoHash && t.infoHash.toLowerCase() === infoHash.toLowerCase()) || null;
  }

  app.post('/api/torrents/:identifier/warmup', requireSession, (req, res) => {
    const orchestrator = req.app.locals.warmup;
    const governor = req.app.locals.governor;
    if (!orchestrator) return res.status(503).json({ error: 'Warmup engine not ready' });
    const hash = normalizeHash(req.params.identifier) || String(req.params.identifier || '').toLowerCase();
    if (!hash) return res.status(400).json({ error: 'Invalid info hash' });
    const { magnet, fileIdx } = warmupPayload(req);

    const governorTouch = () => governor && governor.touchHash(hash);
    governorTouch();

    let torrent = findTorrentLocal(hash);
    if (!torrent) {
      // Not in the engine (fresh, reaped, or post-restart): start loading
      // from the magnet the client remembered, respond "loading" instantly.
      const { load, isLoading, canLoad } = wt();
      // Capacity gate (MAX_ACTIVE_TORRENTS / LITE_MODE): refuse honestly
      // instead of queueing a load the little host cannot survive.
      const gate = canLoad ? canLoad(hash) : { ok: true };
      if (!gate.ok) {
        res.set('Retry-After', '30');
        return res.status(429).json({
          error: `Server is at capacity (${gate.cap} active torrent${gate.cap === 1 ? '' : 's'})`,
          code: 'SERVER_BUSY',
          retryable: true,
          retryAfterSecs: 30,
        });
      }
      const magnetUri = typeof magnet === 'string' && magnet.startsWith('magnet:')
        ? magnet
        : `magnet:?xt=urn:btih:${hash}`;
      if (load && !isLoading?.(hash)) {
        load(magnetUri).catch((err) => {
          console.warn(`⚠️ Warmup load failed for ${hash}: ${err.message}`);
        });
      }
      return res.json({ state: 'loading', connected: false, bufferedFromPos: 0, targetBytes: 0 });
    }

    if (!torrent.ready) {
      governorTouch();
      return res.json({ state: 'loading', connected: true, bufferedFromPos: 0, targetBytes: 0 });
    }

    const idx = fileIdx != null ? parseInt(fileIdx, 10) : orchestrator.primaryVideoIndex(torrent);
    const { bytePos, targetBytes } = resolveWarmPosition(torrent, idx, warmupPayload(req));
    const state = orchestrator.start({ infoHash: hash, fileIdx: idx, bytePos, targetBytes });
    const guard = req.app.locals.swarmGuard?.state(hash);
    if (guard?.poisoned) state.poisoned = true;
    res.json(state);
  });

  app.get('/api/torrents/:identifier/warmup', requireSession, (req, res) => {
    const orchestrator = req.app.locals.warmup;
    const governor = req.app.locals.governor;
    if (!orchestrator) return res.status(503).json({ error: 'Warmup engine not ready' });
    const hash = normalizeHash(req.params.identifier) || String(req.params.identifier || '').toLowerCase();
    if (!hash) return res.status(400).json({ error: 'Invalid info hash' });
    if (governor) governor.touchHash(hash);
    const torrent = findTorrentLocal(hash);
    const idx = req.query.fileIdx != null ? parseInt(req.query.fileIdx, 10) : (torrent && torrent.ready ? orchestrator.primaryVideoIndex(torrent) : null);
    const { bytePos, targetBytes } = torrent ? resolveWarmPosition(torrent, idx, req.query) : { bytePos: 0, targetBytes: 0 };
    const state = orchestrator.status({ infoHash: hash, fileIdx: idx, bytePos, targetBytes });
    const guard = req.app.locals.swarmGuard?.state(hash);
    if (guard?.poisoned) state.poisoned = true;
    res.json(state);
  });

  // ============ TORRENT-EMBEDDED SUBTITLES ============
  // Streams .srt/.vtt files that live inside a torrent, converting SRT→VTT
  // so the browser <track> element can render them.
  app.get('/api/torrents/:identifier/files/:fileIdx/subtitle', requireSession, async (req, res) => {
    const { resolve } = wt();
    try {
      const torrent = await resolve(req.params.identifier);
      if (!torrent) return res.status(404).json({ error: 'Torrent not found' });
      const file = torrent.files[parseInt(req.params.fileIdx, 10)];
      if (!file) return res.status(404).json({ error: 'File not found' });
      const ext = extOf(file.name);
      if (!['.srt', '.vtt'].includes(ext)) {
        return res.status(400).json({ error: 'Not a subtitle file' });
      }
      if (file.length > 5 * 1024 * 1024) {
        return res.status(413).json({ error: 'Subtitle file too large' });
      }
      file.select();
      const chunks = [];
      const stream = file.createReadStream();
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.send(ext === '.vtt' || text.includes('WEBVTT') ? text : srtToVtt(text));
      });
      stream.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      req.on('close', () => { try { stream.destroy(); } catch (_) {} });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ============ TRANSCODE — quality variants from one big source ============
  const transcoder = require('../lib/transcoder');

  app.get('/api/transcode/status', requireSession, (_req, res) => {
    const finish = (info) => res.json({
      // "available" combines: allowed by config AND ffmpeg present. A lite /
      // budget host reports disabled so the player hides the quality menu
      // instead of offering renditions the CPU cannot produce.
      enabled: tuning.transcodeEnabled,
      available: tuning.transcodeEnabled && !!info,
      ffmpeg: tuning.transcodeEnabled ? (info || null) : null,
      lite: tuning.lite,
      defaultQuality: transcoder.DEFAULT_QUALITY,
      presets: tuning.transcodeEnabled ? transcoder.presetsForStatus() : [],
      stats: transcoder.stats(),
    });
    if (!tuning.transcodeEnabled) return finish(null);
    transcoder.probe(finish);
  });

  /**
   * GET /api/torrents/:hash/files/:idx/transcode?quality=720p&t=SECONDS
   * Fragmented-MP4 (instant-start) H.264/AAC rendition streamed from ffmpeg.
   * The player restarts this URL with a new `t` for seeks ("go to time") and
   * quality switches. Source comes through our own range streamer, so the
   * governor's ~5min window applies underneath automatically.
   */
  app.get('/api/torrents/:identifier/files/:fileIdx/transcode', requireSession, (req, res) => {
    const hash = normalizeHash(req.params.identifier) || String(req.params.identifier || '').toLowerCase();
    const governor = req.app.locals.governor;
    if (governor) governor.touchHash(hash);

    const sendUnavailable = () => {
      res.status(501).json({
        error: 'Transcoding unavailable — ffmpeg is not installed on the server',
        howTo: 'Ubuntu/Debian: sudo apt install ffmpeg && restart the server (or npm i ffmpeg-static in server/)',
      });
    };

    if (!tuning.transcodeEnabled) {
      return res.status(501).json({
        error: 'Transcoding disabled on this server (LITE_MODE or DISABLE_TRANSCODE)',
        disabled: true,
      });
    }

    transcoder.probe((info) => {
      if (!info) return sendUnavailable();
      const quality = transcoder.PRESETS[req.query.quality] ? req.query.quality : transcoder.DEFAULT_QUALITY;
      const t = Math.max(0, parseFloat(req.query.t) || 0);
      const token = extractToken(req) || '';
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers.host || '127.0.0.1:3000';
      const fileIdx = encodeURIComponent(req.params.fileIdx);
      const srcUrl = `${proto}://${host}/api/torrents/${hash}/files/${fileIdx}/stream?token=${encodeURIComponent(token)}`;
      const result = transcoder.transcodeInto({
        srcUrl,
        quality,
        startSecs: t,
        token,
        res,
        label: `${String(hash).slice(0, 8)}/${fileIdx}`,
      });
      if (!result.ok && !res.headersSent) res.status(500).json({ error: result.error });
    });
  });

  // ============ PER-USER: PIPELINE (magnet library) ============

  function findTorrent(infoHash) {
    const { client } = wt();
    if (!client || !infoHash) return null;
    return client.torrents.find((t) => t.infoHash && t.infoHash.toLowerCase() === infoHash.toLowerCase()) || null;
  }

  const rehydrating = new Set(); // stores lowercased infoHashes
  const normHash = (h) => String(h || '').toLowerCase();

  app.get('/api/me/profile', requireSession, (req, res) => {
    res.json({ user: req.user });
  });

  app.get('/api/me/library', requireSession, (req, res) => {
    const data = userStore.getUser(req.user.id);
    const { load, client, isLoading } = wt();
    const items = data.library.map((item) => {
      const torrent = findTorrent(item.infoHash);
      // Rehydrate METADATA ONLY: a server restart empties the engine, so we
      // lazily re-load remembered magnets in the background to learn file
      // names/sizes. No warmup — buffering starts on Play click, so many
      // pipeline items never download anything.
      const itemHashNorm = normHash(item.infoHash);
      if (!torrent && load && client && !rehydrating.has(itemHashNorm)) {
        rehydrating.add(itemHashNorm);
        load(item.magnet)
          .then((t) => {
            if (!t) return;
            const live = liveState(t);
            const patch = {
              fileIndex: item.fileIndex ?? live.fileIndex ?? undefined,
              fileName: item.fileName ?? live.fileName ?? undefined,
            };
            // Auto-title from real file names when the user never named it
            if (item.titleAuto) {
              const derived = meta.deriveFromFiles(t.files || []);
              if (derived.title) {
                patch.title = derived.title;
                if (derived.isSeries && !item.showName) patch.showName = derived.title;
              }
            }
            userStore.updateLibraryItem(req.user.id, item.id, patch);
          })
          .catch((err) => {
            if (!/duplicate/i.test(err.message || '')) {
              console.warn(`⚠️ Rehydrate failed for ${item.infoHash}: ${err.message}`);
            }
          })
          .finally(() => setTimeout(() => rehydrating.delete(itemHashNorm), 5000));
      }
      const loading = !torrent && (rehydrating.has(itemHashNorm) || isLoading?.(item.infoHash));
      return { ...item, live: liveState(torrent, item.fileIndex ?? null, { loading }) };
    });
    res.json({ items });
  });

  app.post('/api/me/library', requireSession, async (req, res) => {
    const { title, kind = 'other', showName, season, episode } = req.body || {};
    const raw = String(req.body?.magnet || '').trim();
    const infoHash = normalizeHash(raw);
    if (!infoHash) {
      return res.status(400).json({ error: 'Provide a valid magnet link or 40-character info hash' });
    }
    const { load } = wt();
    if (!load) return res.status(500).json({ error: 'Torrent engine not ready' });

    // Magnet `dn` (display-name) hint — a much better fallback than the hash
    const dnMatch = raw.match(/[?&]dn=([^&]+)/i);
    const dnTitle = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')).trim() : null;

    // Deduplicate per user (case-insensitive)
    const data = userStore.getUser(req.user.id);
    const existing = data.library.find((i) => normHash(i.infoHash) === normHash(infoHash));
    if (existing) {
      // Pressing "add" again on an existing item is a nudge to (re)load it —
      // covers "quit & re-open" reliability without a separate wake route.
      const existingTorrent = findTorrent(infoHash);
      const existingNorm = normHash(infoHash);
      if (!existingTorrent && load && !rehydrating.has(existingNorm)) {
        rehydrating.add(existingNorm);
        load(existing.magnet)
          .catch(() => {})
          .finally(() => setTimeout(() => rehydrating.delete(existingNorm), 5000));
      }
      const loading = !existingTorrent && (rehydrating.has(existingNorm) || wt().isLoading?.(infoHash));
      return res.json({ ok: true, item: existing, duplicate: true, live: liveState(existingTorrent, existing.fileIndex ?? null, { loading }) });
    }

    try {
      const readyTorrent = findTorrent(infoHash);
      const knownTorrent = readyTorrent || wt().client.torrents.find(
        (t) => t.infoHash && t.infoHash.toLowerCase() === infoHash.toLowerCase()
      );

      // Derive keywords for the picture library
      const cleaned = meta.cleanTitle(title || showName || knownTorrent?.name || dnTitle || infoHash);
      const episodeInfo = meta.parseEpisode(knownTorrent?.name || title || '');
      const finalKind = kind !== 'other' ? kind : (showName || episodeInfo.season ? 'episode' : 'other');

      const item = {
        id: crypto.randomBytes(6).toString('hex'),
        magnet: raw.startsWith('magnet:') ? raw : `magnet:?xt=urn:btih:${infoHash}`,
        infoHash,
        title: (title || '').trim() || cleaned.title || knownTorrent?.name || dnTitle || infoHash,
        titleAuto: !(title || '').trim(), // auto-derived → safe to overwrite from file names
        kind: finalKind,
        showName: showName || (finalKind === 'episode' ? cleaned.title : null) || null,
        season: season ?? episodeInfo.season,
        episode: episode ?? episodeInfo.episode,
        poster: null,
        backdrop: null,
        overview: '',
        metaId: null,
        fileIndex: null,
        fileName: null,
        addedAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (knownTorrent && knownTorrent.ready) {
        const live = liveState(knownTorrent);
        if (live.fileIndex != null) {
          item.fileIndex = live.fileIndex;
          item.fileName = live.fileName;
        }
        // Title from the real file names (series → shared part across files)
        if (item.titleAuto) {
          const derived = meta.deriveFromFiles(knownTorrent.files || []);
          if (derived.title) {
            item.title = derived.title;
            if (derived.isSeries && !item.showName) item.showName = derived.title;
          }
        }
      }

      userStore.addLibraryItem(req.user.id, item);

      // Load METADATA in the background so the pipeline responds instantly;
      // buffering does NOT start here (warmup fires on Play click only).
      if (!readyTorrent) {
        const magnet = raw.startsWith('magnet:') ? raw : `magnet:?xt=urn:btih:${infoHash}`;
        load(magnet)
          .then((torrent) => {
            if (!torrent) return;
            const live = liveState(torrent);
            const patch = {
              fileIndex: live.fileIndex ?? undefined,
              fileName: live.fileName ?? undefined,
            };
            if (item.titleAuto) {
              const derived = meta.deriveFromFiles(torrent.files || []);
              if (derived.title) {
                patch.title = derived.title;
                if (derived.isSeries && !item.showName) patch.showName = derived.title;
              }
            }
            userStore.updateLibraryItem(req.user.id, item.id, patch);
          })
          .catch((err) => {
            if (!/duplicate/i.test(err.message || '')) {
              console.warn(`⚠️ Background magnet load for ${infoHash}: ${err.message}`);
            }
          });
      }

      // Async best-effort artwork enrichment (picture library by keywords)
      const lookupType = finalKind === 'episode' || showName ? 'show' : 'any';
      const query = finalKind === 'episode' ? (showName || cleaned.title) : (title || cleaned.title);
      if (query) {
        meta.lookup(query, { type: lookupType, year: cleaned.year })
          .then((m) => {
            if (m?.found && m.best) {
              userStore.updateLibraryItem(req.user.id, item.id, {
                poster: m.best.poster,
                backdrop: m.best.backdrop,
                overview: m.best.overview,
                metaId: m.best.id,
                // Only auto-rename movies, and only if the user gave no title
                title: (!title && finalKind !== 'episode') ? (m.best.title || undefined) : undefined,
              });
            }
          })
          .catch(() => {});
      }

      res.json({ ok: true, item, live: liveState(knownTorrent, item.fileIndex ?? null) });
    } catch (err) {
      console.error(`❌ Library add failed: ${err.message}`);
      res.status(500).json({ error: `Failed to add magnet: ${err.message}` });
    }
  });

  app.patch('/api/me/library/:id', requireSession, (req, res) => {
    const item = userStore.updateLibraryItem(req.user.id, req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true, item, live: liveState(findTorrent(item.infoHash), item.fileIndex ?? null) });
  });

  // Re-run the keyword artwork lookup for an item
  app.post('/api/me/library/:id/artwork', requireSession, async (req, res) => {
    const data = userStore.getUser(req.user.id);
    const item = data.library.find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const query = String(req.body?.query || (item.kind === 'episode' ? item.showName : item.title) || '').trim();
    if (!query) return res.status(400).json({ error: 'No keywords to search with' });
    const type = item.kind === 'episode' ? 'show' : (req.body?.type || 'any');
    const m = await withFallback(meta.lookup(query, { type }), 12000, { found: false });
    if (!m?.found) return res.json({ ok: false, error: 'No artwork found — providers may be unreachable' });
    const chosen = m.results && req.body?.pick ? m.results[Math.min(parseInt(req.body.pick, 10), m.results.length - 1)] : m.best;
    const updated = userStore.updateLibraryItem(req.user.id, item.id, {
      poster: chosen.poster,
      backdrop: chosen.backdrop,
      overview: chosen.overview,
      metaId: chosen.id,
      title: item.kind === 'episode' ? undefined : (req.body?.keepTitle ? undefined : chosen.title),
    });
    res.json({ ok: true, item: updated, alternatives: (m.results || []).slice(0, 6) });
  });

  app.delete('/api/me/library/:id', requireSession, async (req, res) => {
    const removed = userStore.removeLibraryItem(req.user.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Item not found' });
    if (req.query.keepData !== '1') {
      const torrent = findTorrent(removed.infoHash);
      if (torrent) {
        try {
          const { client } = wt();
          await new Promise((resolve) => client.remove(torrent, resolve));
          console.log(`🗑️ Removed torrent from pipeline: ${removed.infoHash}`);
        } catch (err) {
          console.warn(`⚠️ Could not remove torrent: ${err.message}`);
        }
      }
    }
    res.json({ ok: true });
  });

  // ============ PER-USER: WATCH HISTORY ============

  app.get('/api/me/history', requireSession, (req, res) => {
    const data = userStore.getUser(req.user.id);
    res.json({ history: data.history });
  });

  app.get('/api/me/history/:key', requireSession, (req, res) => {
    const data = userStore.getUser(req.user.id);
    const entry = data.history.find((h) => h.key === req.params.key);
    res.json({ entry: entry || null });
  });

  app.post('/api/me/history', requireSession, (req, res) => {
    const { key, title, poster, backdrop, kind, source, position, duration, extra } = req.body || {};
    if (!key || !source?.type) return res.status(400).json({ error: 'key and source.type are required' });
    const entry = userStore.upsertHistory(req.user.id, {
      key: String(key).slice(0, 200),
      title: String(title || 'Untitled').slice(0, 200),
      poster: poster || null,
      backdrop: backdrop || null,
      kind: kind || 'movie',
      source: {
        type: source.type,
        identifier: source.identifier || null,
        fileUrl: source.fileUrl || null,
        infoHash: source.infoHash || null,
        fileIndex: source.fileIndex ?? null,
        fileName: source.fileName || null,
        subtitles: Array.isArray(source.subtitles) ? source.subtitles.slice(0, 10) : undefined,
      },
      position: Math.max(0, parseFloat(position) || 0),
      duration: Math.max(0, parseFloat(duration) || 0),
      extra: extra || undefined,
    });
    res.json({ ok: true, entry });
  });

  app.delete('/api/me/history/:key', requireSession, (req, res) => {
    userStore.removeHistory(req.user.id, req.params.key);
    res.json({ ok: true });
  });

  app.delete('/api/me/history', requireSession, (req, res) => {
    userStore.clearHistory(req.user.id, req.query.keepInProgress === '1');
    res.json({ ok: true });
  });

  // ============ PER-USER: FAVORITES ============

  app.get('/api/me/favorites', requireSession, (req, res) => {
    res.json({ favorites: userStore.getFavorites(req.user.id) });
  });

  app.post('/api/me/favorites', requireSession, (req, res) => {
    const { key, title, poster, backdrop, kind, ref } = req.body || {};
    if (!key || !title) return res.status(400).json({ error: 'key and title are required' });
    const favorites = userStore.addFavorite(req.user.id, { key, title, poster, backdrop, kind, ref });
    res.json({ ok: true, favorites });
  });

  app.delete('/api/me/favorites/:key', requireSession, (req, res) => {
    const favorites = userStore.removeFavorite(req.user.id, decodeURIComponent(req.params.key));
    res.json({ ok: true, favorites });
  });

  // ============ PER-USER: SHOW TRACKING ============

  app.get('/api/me/shows', requireSession, (req, res) => {
    const data = userStore.getUser(req.user.id);
    const list = Object.values(data.shows).sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ shows: list });
  });

  app.get('/api/me/shows/:showKey', requireSession, (req, res) => {
    const data = userStore.getUser(req.user.id);
    res.json({ show: data.shows[req.params.showKey] || null });
  });

  app.post('/api/me/shows/watched', requireSession, (req, res) => {
    const { showKey, showTitle, poster, season, episode, watched = true } = req.body || {};
    if (!showKey || season == null || episode == null) {
      return res.status(400).json({ error: 'showKey, season and episode are required' });
    }
    const show = userStore.setEpisodeWatched(req.user.id, {
      showKey: String(showKey).slice(0, 200),
      showTitle,
      poster,
      season: parseInt(season, 10),
      episode: parseInt(episode, 10),
      watched: !!watched,
    });
    res.json({ ok: true, show });
  });

  console.log('✅ Feature routes mounted (tickets, RSS home, archive, metadata, pipeline, history, shows)');
  if (process.env.REQUIRE_AUTH !== 'false') {
    if (process.env.ADMIN_PASSWORD) console.log('🔐 Admin endpoints protected by ADMIN_PASSWORD');
    else console.log('⚠️ ADMIN_PASSWORD not set — admin key defaults to "admin123". Change it in production!');
  }
};
