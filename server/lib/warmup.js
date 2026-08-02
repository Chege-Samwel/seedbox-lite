/**
 * Warmup orchestrator — buffers just enough of a file (~1 minute of media
 * from a given position) for the player to start, and no more.
 *
 * Why this exists:
 *  - Previously every added magnet auto-warmed its head (or worse, selected
 *    whole files), so adding several items saturated the machine.
 *  - Warmup is now demand-driven: it starts when the user clicks Play and
 *    re-centers whenever they seek ("go to a time"). Status polls report
 *    contiguous bytes buffered FROM the play position so the client can gate
 *    playback on "one minute ready".
 *  - All activity touches the memory governor so a warming torrent is never
 *    reaped as "idle" mid-warm.
 *
 * Selection windows are bounded and moved (never unioned), and expired
 * shortly after the client stops polling, so stale seeks don't leak
 * bandwidth.
 */
const VIDEO_EXTS = ['.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.avi', '.mov'];
const BROWSER_PLAYABLE_EXTS = ['.mp4', '.m4v', '.webm', '.ogv', '.mov'];

const DEFAULT_TARGET = parseInt(process.env.WARM_DEFAULT_MB || '32', 10) * 1024 * 1024;
const MIN_TARGET = 4 * 1024 * 1024;
const MAX_TARGET = parseInt(process.env.WARM_MAX_MB || '128', 10) * 1024 * 1024;
// Ready when this many contiguous bytes from the position are buffered
// (≈ "the starting 1 minute" for typical bitrates) — or the whole remainder.
const READY_MIN_BYTES = parseInt(process.env.WARM_READY_MIN_MB || '8', 10) * 1024 * 1024;
// If nobody asks about a warm window for this long, deselect it.
const WINDOW_TTL_MS = (parseFloat(process.env.WARM_WINDOW_KEEP_MIN || '4') * 60 * 1000);
const JANITOR_EVERY_MS = 20000;
// Fixed selection priority — deselect() in webtorrent@1.9.7 matches
// {from, to, priority} exactly, so it must be stable identity.
const SELECT_PRIORITY = 1;

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i === -1 ? '' : name.toLowerCase().slice(i);
}

function clampTarget(bytes, fileLen) {
  let b = bytes > 0 ? bytes : DEFAULT_TARGET;
  b = Math.max(MIN_TARGET, Math.min(b, MAX_TARGET));
  return Math.min(b, fileLen);
}

function create({ client, governor, isLoading = () => false }) {
  // `${hash}:${fileIdx}` → { s, e, bytePos, targetBytes, fileLen, updatedAt, logged }
  const windows = new Map();

  function findTorrent(infoHash) {
    const h = String(infoHash || '').toLowerCase();
    return client.torrents.find((t) => t.infoHash && t.infoHash.toLowerCase() === h) || null;
  }

  function primaryVideoIndex(torrent) {
    const files = torrent.files || [];
    let best = -1;
    let bestLen = -1;
    files.forEach((f, i) => {
      if (!VIDEO_EXTS.includes(extOf(f.name))) return;
      if (f.length > bestLen) { bestLen = f.length; best = i; }
    });
    if (best === -1 && files.length) best = 0;
    return best;
  }

  function piecesForRange(torrent, file, bytePos, targetBytes) {
    const pieceLength = torrent.pieceLength;
    const lastPiece = torrent.pieces.length - 1;
    const fileStart = file.offset;
    const fileEnd = file.offset + file.length - 1;
    const wantStart = Math.max(fileStart, fileStart + Math.max(0, bytePos));
    const wantEnd = Math.min(fileEnd, wantStart + Math.max(1, targetBytes) - 1);
    const s = Math.max(0, Math.min(Math.floor(wantStart / pieceLength), lastPiece));
    const e = Math.max(s, Math.min(Math.floor(wantEnd / pieceLength), lastPiece));
    return { s, e };
  }

  /** Contiguous fully-downloaded byte count starting at bytePos within file. */
  function contiguousFrom(torrent, file, bytePos, capBytes) {
    const pieceLength = torrent.pieceLength;
    if (!pieceLength || !torrent.bitfield) return 0;
    const firstPiece = Math.floor((file.offset + bytePos) / pieceLength);
    const lastPiece = Math.min(
      Math.floor((file.offset + file.length - 1) / pieceLength),
      torrent.pieces.length - 1
    );
    const maxPieces = Math.min(lastPiece - firstPiece, Math.ceil(capBytes / pieceLength));
    let pieces = 0;
    for (let i = 0; i <= maxPieces; i++) {
      if (torrent.bitfield.get(firstPiece + i)) pieces++;
      else break;
    }
    // First piece may be partially before bytePos; exactness isn't critical
    return Math.min(pieces * pieceLength, capBytes);
  }

  /**
   * Report warmup status for a file at a position.
   * state: 'missing' | 'loading' | 'connecting' | 'warming' | 'ready'
   */
  function status({ infoHash, fileIdx = null, bytePos = 0, targetBytes = 0 }) {
    const hash = String(infoHash || '').toLowerCase();
    const torrent = findTorrent(hash);
    if (!torrent || !torrent.ready) {
      return {
        state: isLoading(hash) || (torrent && !torrent.ready) ? 'loading' : 'missing',
        connected: !!torrent,
        bufferedFromPos: 0,
        targetBytes: 0,
      };
    }
    governor.touchHash(hash);
    const idx = fileIdx != null ? parseInt(fileIdx, 10) : primaryVideoIndex(torrent);
    const file = torrent.files?.[idx];
    if (!file) return { state: 'connecting', connected: true, bufferedFromPos: 0, targetBytes: 0 };

    const pos = Math.max(0, Math.min(Number(bytePos) || 0, Math.max(0, file.length - 1)));
    const remaining = file.length - pos;
    const target = clampTarget(targetBytes, remaining);
    const readyTarget = Math.min(target, Math.max(READY_MIN_BYTES, Math.min(remaining, 4 * 1024 * 1024)));
    const buffered = contiguousFrom(torrent, file, pos, target);
    const speed = torrent.downloadSpeed || 0;
    const peers = torrent.numPeers || 0;

    // Keep the window alive while the client cares about it
    const win = windows.get(`${hash}:${idx}`);
    if (win) win.updatedAt = Date.now();

    let state = 'connecting';
    if (file.progress >= 0.999 || buffered >= Math.min(readyTarget, remaining * 0.98) || remaining <= buffered + 1) {
      state = 'ready';
    } else if (buffered > 0 || speed > 0 || peers > 0) {
      state = 'warming';
    }
    // ETA in seconds, when knowable
    const etaSecs = speed > 0 ? Math.max(0, (Math.min(readyTarget, remaining) - buffered) / speed) : null;

    return {
      state,
      connected: true,
      fileIndex: idx,
      fileName: file.name,
      fileSize: file.length,
      fileProgress: file.progress || 0,
      containerPlayable: BROWSER_PLAYABLE_EXTS.includes(extOf(file.name)),
      bufferedFromPos: buffered,
      targetBytes: readyTarget,
      speed,
      peers,
      etaSecs,
      torrentProgress: torrent.progress || 0,
      torrentName: torrent.name || null,
    };
  }

  /**
   * Begin (or re-center) a warmup window. Dedupes: repeated calls at the
   * same position are near-no-ops; a move deselects the parts of the old
   * window that the new one doesn't cover, so seek spam can't stretch the
   * selection.
   */
  function start({ infoHash, fileIdx = null, bytePos = 0, targetBytes = 0 }) {
    const hash = String(infoHash || '').toLowerCase();
    governor.touchHash(hash);
    const torrent = findTorrent(hash);
    if (!torrent || !torrent.ready || !torrent.pieceLength) {
      return status({ infoHash, fileIdx, bytePos, targetBytes });
    }
    const idx = fileIdx != null ? parseInt(fileIdx, 10) : primaryVideoIndex(torrent);
    const file = torrent.files?.[idx];
    if (!file) return status({ infoHash, fileIdx, bytePos, targetBytes });

    const pos = Math.max(0, Math.min(Number(bytePos) || 0, Math.max(0, file.length - 1)));
    const target = clampTarget(targetBytes, file.length - pos);
    const { s, e } = piecesForRange(torrent, file, pos, target);
    const key = `${hash}:${idx}`;
    const prev = windows.get(key);

    const overlaps = prev && !(prev.e < s || prev.s > e);
    if (prev && overlaps && Math.abs(prev.bytePos - pos) < prev.targetBytes * 0.5) {
      // Same neighbourhood — refresh, no reselection churn
      prev.updatedAt = Date.now();
      return status({ infoHash, fileIdx: idx, bytePos: pos, targetBytes: target });
    }

    // webtorrent 1.9.7 deselect() removes only an EXACT {from,to,priority}
    // match — track the range we selected and deselect it verbatim, or
    // selections accumulate forever on every seek.
    if (prev && (prev.s !== s || prev.e !== e)) {
      try { torrent.deselect(prev.s, prev.e, SELECT_PRIORITY); } catch (_) { /* fine */ }
    }
    if (!prev || prev.s !== s || prev.e !== e) {
      try { torrent.select(s, e, SELECT_PRIORITY); } catch (_) { /* fine */ }
    }
    // Push the pieces the player needs within the next seconds to the front
    if (typeof torrent.critical === 'function') {
      for (let i = s; i <= Math.min(s + 6, e); i++) {
        try { torrent.critical(i); } catch (_) { /* fine */ }
      }
    }
    windows.set(key, { s, e, bytePos: pos, targetBytes: target, fileLen: file.length, updatedAt: Date.now(), logged: !!prev?.logged });
    const st = status({ infoHash, fileIdx: idx, bytePos: pos, targetBytes: target });
    const winRec = windows.get(key);
    if (!winRec.logged) {
      winRec.logged = true;
      console.log(`🔥 Warmup: ${torrent.name || hash} · "${file.name}" from ${(pos / 1048576).toFixed(0)}MB · ${e - s + 1} pieces (${(target / 1048576).toFixed(0)}MB target)`);
    }
    return st;
  }

  /** Expire windows nobody has polled/started recently. */
  function janitor() {
    const now = Date.now();
    for (const [key, win] of windows) {
      const [hash] = key.split(':');
      const torrent = findTorrent(hash);
      if (!torrent) { windows.delete(key); continue; }
      if (now - win.updatedAt > WINDOW_TTL_MS) {
        try { torrent.deselect(win.s, win.e, SELECT_PRIORITY); } catch (_) { /* fine */ }
        windows.delete(key);
      }
    }
  }
  const timer = setInterval(janitor, JANITOR_EVERY_MS);
  if (timer.unref) timer.unref();

  return { start, status, primaryVideoIndex, DEFAULT_TARGET, READY_MIN_BYTES };
}

module.exports = { create, VIDEO_EXTS, BROWSER_PLAYABLE_EXTS };
