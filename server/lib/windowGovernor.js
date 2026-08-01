/**
 * Memory governor + sliding time-window buffer policy.
 *
 * Problems solved:
 *  1. WebTorrent in Node defaults to an in-memory chunk store, and the legacy
 *     stream handler called file.select() on the WHOLE file — so a fast swarm
 *     could (and did, in the field) pull multiple GB into RAM until the kernel
 *     OOM-killed the server.
 *  2. No retention policy: seeks left stale downloaded regions around forever.
 *
 * Policy implemented (all tunable via env):
 *  - Keep ~WINDOW_BACK_MIN (5m) behind the playhead and ~WINDOW_AHEAD_MIN (5m)
 *    ahead. Forward/back byte sizes use the real file bitrate once the player
 *    reports the media duration; until then, sane byte fallbacks are used.
 *  - When the user seeks, the previous region is retained for
 *    LAST_REGION_KEEP_MIN (4m), then deselected so the swarm stops fetching it.
 *  - Idle torrents (nothing streamed for IDLE_TORRENT_TTL_MIN) are destroyed.
 *  - Hard RSS guard: past MAX_RSS_MB, governor sheds unstreamed torrents.
 */
const BACK_MIN = parseFloat(process.env.WINDOW_BACK_MIN || '5');
const AHEAD_MIN = parseFloat(process.env.WINDOW_AHEAD_MIN || '5');
const KEEP_MIN = parseFloat(process.env.LAST_REGION_KEEP_MIN || '4');
const IDLE_TTL_MS = (parseFloat(process.env.IDLE_TORRENT_TTL_MIN || '10') * 60 * 1000);
const MAX_RSS_MB = parseFloat(process.env.MAX_RSS_MB || '1400');
const JANITOR_EVERY_MS = 10000;

// Byte fallbacks until duration is known (≈5 min at ~2.2 MB/s cap)
const FALLBACK_BACK_BYTES = 16 * 1024 * 1024;
const FALLBACK_AHEAD_BYTES = 64 * 1024 * 1024;
const MIN_AHEAD_BYTES = 8 * 1024 * 1024; // never starve an active stream

function create(client, destroyTorrent) {
  const streams = new Map(); // streamId → { hash, fileIdx, bytePos, endedAt, lastSeen, duration, fileLen }
  // Per-file piece ranges currently selected: [{ s, e, expiresAt|null }].
  // The latest entry is the active window; older ones are retained seek
  // regions that expire LAST_REGION_KEEP_MIN after the seek happened.
  const selected = new Map(); // `${hash}:${fileIdx}` → ranges[]
  let shedNoticeShown = false;

  function registerStream(hash, fileIdx, fileLen) {
    // One live stream per (hash, fileIdx): browsers fire many range requests
    // per viewing session; treat them as one stream and re-focus its window.
    for (const [id, s] of streams) {
      if (s.hash === hash && s.fileIdx === fileIdx && s.endedAt == null) {
        if (fileLen && !s.fileLen) s.fileLen = fileLen;
        s.lastSeen = Date.now();
        return id;
      }
    }
    const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    streams.set(id, { hash, fileIdx, bytePos: 0, endedAt: null, lastSeen: Date.now(), duration: null, fileLen: fileLen || 0 });
    return id;
  }

  /**
   * Player-driven heartbeat: position in SECONDS; converted to bytes using
   * the file's average bitrate once duration is known.
   */
  function heartbeatByFile(hash, fileIdx, { positionSecs, durationSecs }) {
    const torrent = client.torrents.find((t) => t.infoHash === hash);
    const fileLen = torrent?.ready ? torrent.files?.[fileIdx]?.length || 0 : 0;
    const id = registerStream(hash, fileIdx, fileLen);
    const s = streams.get(id);
    if (durationSecs > 0) s.duration = durationSecs;
    if (!s.fileLen && fileLen) s.fileLen = fileLen;
    // Only map seconds→bytes when both are known; otherwise range requests
    // already track the exact byte position via notePosition().
    if (s.duration && s.fileLen) s.bytePos = (positionSecs / s.duration) * s.fileLen;
    touch(id);
    applyWindow(s);
    return true;
  }

  function touch(id) {
    const s = streams.get(id);
    if (s) s.lastSeen = Date.now();
  }

  function notePosition(id, bytePos) {
    const s = streams.get(id);
    if (s) {
      s.bytePos = bytePos;
      s.lastSeen = Date.now();
      applyWindow(s); // react to seeks instantly, not on the janitor tick
    }
  }

  function heartbeat(id, { positionSecs, durationSecs }) {
    const s = streams.get(id);
    if (!s) return false;
    touch(id);
    if (durationSecs > 0 && s.fileLen > 0) {
      s.duration = durationSecs;
      s.bytePos = (positionSecs / durationSecs) * s.fileLen;
    }
    applyWindow(s);
    return true;
  }

  function endStream(id) {
    const s = streams.get(id);
    if (s && s.endedAt == null) s.endedAt = Date.now(); // start 4-min retention
  }

  function windowBytes(s) {
    if (s.duration > 0 && s.fileLen > 0) {
      const bytesPerSec = s.fileLen / s.duration;
      return {
        back: BACK_MIN * 60 * bytesPerSec,
        ahead: AHEAD_MIN * 60 * bytesPerSec,
      };
    }
    return { back: FALLBACK_BACK_BYTES, ahead: FALLBACK_AHEAD_BYTES };
  }

  /** Subtract covered ranges [s,e] from a range. Returns remaining intervals. */
  function subtractRange(range, covers) {
    let remaining = [range];
    for (const c of covers) {
      const next = [];
      for (const r of remaining) {
        if (c.e < r.s || c.s > r.e) { next.push(r); continue; }
        if (c.s > r.s) next.push({ s: r.s, e: c.s - 1 });
        if (c.e < r.e) next.push({ s: c.e + 1, e: r.e });
      }
      remaining = next;
    }
    return remaining;
  }

  /** Focus the swarm on [bytePos - back, bytePos + ahead] for this stream's file. */
  function applyWindow(s) {
    const torrent = client.torrents.find((t) => t.infoHash === s.hash);
    if (!torrent || !torrent.ready || !torrent.files?.length || !torrent.pieceLength) return;
    const file = torrent.files[s.fileIdx];
    if (!file) return;

    const pieceLength = torrent.pieceLength;
    const { back, ahead } = windowBytes(s);
    const fileStart = file.offset;
    const fileEnd = file.offset + file.length;

    const wantStartByte = Math.max(fileStart, fileStart + Math.max(0, s.bytePos - back));
    const wantEndByte = Math.min(fileEnd, fileStart + Math.min(file.length, s.bytePos + Math.max(ahead, MIN_AHEAD_BYTES)));

    const startPiece = Math.floor(wantStartByte / pieceLength);
    const endPiece = Math.max(startPiece, Math.min(Math.floor(wantEndByte / pieceLength), torrent.pieces.length - 1));

    const key = `${s.hash}:${s.fileIdx}`;
    const now = Date.now();
    const prev = selected.get(key) || [];

    // Expire old retained regions
    const kept = prev.filter((r) => r.expiresAt == null || r.expiresAt > now);

    // If the previous active window is disconnected from the new one (a real
    // seek), retain it for LAST_REGION_KEEP_MIN; if they overlap, merge.
    const activeIdx = kept.findIndex((r) => r.expiresAt == null);
    const active = { s: startPiece, e: endPiece, expiresAt: null };
    let nextRanges = [active];
    if (activeIdx >= 0) {
      const oldActive = kept[activeIdx];
      const overlaps = oldActive.e >= startPiece - 2 && oldActive.s <= endPiece + 2;
      if (overlaps) {
        nextRanges = [{ s: Math.min(oldActive.s, startPiece), e: Math.max(oldActive.e, endPiece), expiresAt: null }];
      } else {
        kept[activeIdx] = { ...oldActive, expiresAt: now + KEEP_MIN * 60 * 1000 };
        nextRanges = [active, ...kept];
      }
    } else {
      nextRanges = [active, ...kept];
    }

    // Deselect pieces that are no longer covered by any active/retained range
    for (const old of prev) {
      for (const r of subtractRange(old, nextRanges)) {
        try { torrent.deselect(r.s, r.e, false); } catch (_) {}
      }
    }
    // Select the union going forward
    for (const r of nextRanges) {
      try { torrent.select(r.s, r.e, 1); } catch (_) {}
    }
    selected.set(key, nextRanges);
  }

  function janitor() {
    const now = Date.now();

    // 1) Refresh windows for live streams; expire retained regions
    const liveByTorrent = new Map();
    for (const [id, s] of streams) {
      const stale = s.endedAt != null && now - s.endedAt > KEEP_MIN * 60 * 1000;
      const dead = now - s.lastSeen > Math.max(10 * 60 * 1000, KEEP_MIN * 60 * 1000);
      if (stale || dead) { streams.delete(id); continue; }
      if (s.endedAt == null) {
        applyWindow(s); // keep the window glued to the playhead
        liveByTorrent.set(s.hash, (liveByTorrent.get(s.hash) || 0) + 1);
      }
    }

    // 2) Reap idle torrents (no live streams for the TTL)
    for (const torrent of [...client.torrents]) {
      const infoHash = torrent.infoHash;
      if ((liveByTorrent.get(infoHash) || 0) > 0) continue;
      // Was anything ever streamed / recently queued?
      let lastTouch = 0;
      for (const s of streams.values()) {
        if (s.hash === infoHash && s.lastSeen > lastTouch) lastTouch = s.lastSeen;
      }
      const lastActivity = Math.max(lastTouch, torrent.addedTime || 0);
      if (now - lastActivity > IDLE_TTL_MS) {
        console.log(`🧹 Governor: reaping idle torrent ${torrent.name || infoHash}`);
        releaseWindows(infoHash);
        destroyTorrent(infoHash);
      }
    }

    // 3) Hard RSS guard — never let the kernel do it for us
    const rssMB = process.memoryUsage().rss / 1048576;
    if (rssMB > MAX_RSS_MB) {
      // Shed the least-recently-touched torrent that has no live streams
      const candidates = [...client.torrents]
        .filter((t) => (liveByTorrent.get(t.infoHash) || 0) === 0)
        .sort((a, b) => {
          const la = latestTouch(a.infoHash); const lb = latestTouch(b.infoHash);
          return la - lb;
        });
      const victim = candidates[0];
      if (victim) {
        console.warn(`🚨 Governor: RSS ${Math.round(rssMB)}MB > ${MAX_RSS_MB}MB — shedding "${victim.name || victim.infoHash}"`);
        releaseWindows(victim.infoHash);
        destroyTorrent(victim.infoHash);
      } else if (!shedNoticeShown) {
        shedNoticeShown = true;
        console.warn(`⚠️ Governor: RSS ${Math.round(rssMB)}MB is high but every torrent has live streams; windows are already minimal`);
      }
    } else {
      shedNoticeShown = false;
    }
  }

  function latestTouch(hash) {
    let t = 0;
    for (const s of streams.values()) if (s.hash === hash && s.lastSeen > t) t = s.lastSeen;
    return t || 0;
  }

  function releaseWindows(hash) {
    for (const key of selected.keys()) if (key.startsWith(`${hash}:`)) selected.delete(key);
  }

  const timer = setInterval(janitor, JANITOR_EVERY_MS);
  if (timer.unref) timer.unref();

  console.log(`🪟 Memory governor active — window: -${BACK_MIN}m / +${AHEAD_MIN}m · retain last region ${KEEP_MIN}m · idle reap ${Math.round(IDLE_TTL_MS / 60000)}m · RSS cap ${MAX_RSS_MB}MB`);

  return { registerStream, notePosition, heartbeat, heartbeatByFile, endStream, touch, windowBytes };
}

module.exports = { create };
