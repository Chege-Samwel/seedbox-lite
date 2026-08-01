/**
 * Feature router — tickets/auth, admin, Internet Archive browsing,
 * metadata/picture library, and per-user pipeline/history/show-tracking.
 *
 * Mounted from index.js right after express.json() so that the torrent-auth
 * gate registered here runs BEFORE the legacy /api/torrents routes.
 */
const crypto = require('crypto');
const authStore = require('../lib/authStore');
const { requireSession, requireAdmin, extractToken } = require('../lib/authMiddleware');
const ia = require('../lib/iaService');
const meta = require('../lib/metadataService');
const userStore = require('../lib/userStore');

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
 * Live state for a torrent, incl. warmup (head-of-file buffering) status.
 */
function liveState(torrent, preferredFileIndex = null) {
  if (!torrent || !torrent.ready) {
    return { connected: false, readyState: 'connecting' };
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

/** Begin buffering the head of the primary video file for fast playback start. */
function startWarmup(torrent, preferredFileIndex = null) {
  try {
    if (!torrent || !torrent.files || !torrent.files.length) return;
    const files = torrent.files;
    let file = null;
    if (preferredFileIndex != null && files[preferredFileIndex]) file = files[preferredFileIndex];
    else {
      const videos = files.filter((f) => VIDEO_EXTS.includes(extOf(f.name)));
      file = (videos.length ? videos : files).sort((a, b) => b.length - a.length)[0];
    }
    if (!file) return;
    const pieceLength = torrent.pieceLength;
    const startPiece = Math.floor(file.offset / pieceLength);
    const warmPieces = Math.ceil(Math.min(24 * 1024 * 1024, file.length) / pieceLength);
    torrent.select(startPiece, Math.min(startPiece + warmPieces, torrent.pieces.length - 1), 1);
    console.log(`🔥 Warmup started: ${torrent.name} (${warmPieces} head pieces of "${file.name}")`);
  } catch (err) {
    console.warn(`⚠️ Warmup select failed: ${err.message}`);
  }
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

  // ============ INTERNET ARCHIVE (legal catalog) ============

  app.get('/api/browse/home', requireSession, async (_req, res) => {
    const data = await withFallback(ia.home(), 20000, { rows: [], offline: true });
    res.json(data);
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

  // ============ PER-USER: PIPELINE (magnet library) ============

  function findTorrent(infoHash) {
    const { client } = wt();
    if (!client || !infoHash) return null;
    return client.torrents.find((t) => t.infoHash && t.infoHash.toLowerCase() === infoHash.toLowerCase()) || null;
  }

  app.get('/api/me/profile', requireSession, (req, res) => {
    res.json({ user: req.user });
  });

  app.get('/api/me/library', requireSession, (req, res) => {
    const data = userStore.getUser(req.user.id);
    const items = data.library.map((item) => ({
      ...item,
      live: liveState(findTorrent(item.infoHash), item.fileIndex ?? null),
    }));
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

    // Deduplicate per user
    const data = userStore.getUser(req.user.id);
    const existing = data.library.find((i) => i.infoHash === infoHash);
    if (existing) {
      return res.json({ ok: true, item: existing, duplicate: true, live: liveState(findTorrent(infoHash), existing.fileIndex ?? null) });
    }

    try {
      const readyTorrent = findTorrent(infoHash);
      const knownTorrent = readyTorrent || wt().client.torrents.find(
        (t) => t.infoHash && t.infoHash.toLowerCase() === infoHash.toLowerCase()
      );

      // Derive keywords for the picture library
      const cleaned = meta.cleanTitle(title || showName || knownTorrent?.name || infoHash);
      const episodeInfo = meta.parseEpisode(knownTorrent?.name || title || '');
      const finalKind = kind !== 'other' ? kind : (showName || episodeInfo.season ? 'episode' : 'other');

      const item = {
        id: crypto.randomBytes(6).toString('hex'),
        magnet: raw.startsWith('magnet:') ? raw : `magnet:?xt=urn:btih:${infoHash}`,
        infoHash,
        title: (title || '').trim() || cleaned.title || knownTorrent?.name || infoHash,
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
        startWarmup(knownTorrent, item.fileIndex);
      }

      userStore.addLibraryItem(req.user.id, item);

      // Load in the background so the pipeline responds instantly; once
      // metadata resolves, pick the primary file and begin the warmup.
      if (!readyTorrent) {
        const magnet = raw.startsWith('magnet:') ? raw : `magnet:?xt=urn:btih:${infoHash}`;
        load(magnet)
          .then((torrent) => {
            if (!torrent) return;
            const live = liveState(torrent);
            userStore.updateLibraryItem(req.user.id, item.id, {
              fileIndex: live.fileIndex ?? undefined,
              fileName: live.fileName ?? undefined,
            });
            startWarmup(torrent, live.fileIndex ?? null);
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

  console.log('✅ Feature routes mounted (tickets, archive, metadata, pipeline, history, shows)');
  if (process.env.REQUIRE_AUTH !== 'false') {
    if (process.env.ADMIN_PASSWORD) console.log('🔐 Admin endpoints protected by ADMIN_PASSWORD');
    else console.log('⚠️ ADMIN_PASSWORD not set — admin key defaults to "admin123". Change it in production!');
  }
};
