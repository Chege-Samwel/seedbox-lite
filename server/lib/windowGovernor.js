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

// Rolling disk store: some of the window bytes live on disk (capped) instead
// of RAM — this is the "download a minute extra, delete the trailing minute"
// machinery.
let findRolling = null;
let storeStats = null;
try {
  const rs = require('./rollingStore');
  findRolling = rs.findRolling;
  storeStats = rs.stats;
} catch (_) { /* store is optional */ }

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
  // Liveness NOT tied to HTTP streams: loading, warmup, status polling and
  // heartbeats all call touch(hash). Without this the janitor treated any
  // torrent without an active stream as "idle since epoch" and reaped it
  // seconds after warmup started (the load → warm → reap loop of doom).
  const activity = new Map(); // hash → ms timestamp
  let shedNoticeShown = false;

  function touchActivity(hash) {
    if (!hash) return;
    activity.set(String(hash).toLowerCase(), Date.now());
  }

  /** Combined last-seen for a torrent: streams, explicit touches, add time. */
  function lastActivity(hash) {
    const h = String(hash).toLowerCase();
    let t = activity.get(h) || 0;
    for (const s of streams.values()) {
      if (s.hash === h && s.lastSeen > t) t = s.lastSeen;
    }
    if (!t) {
      const torrent = client.torrents.find((x) => x.infoHash === h);
      // NB: only trust NUMERIC timestamps — the legacy code set an ISO string
      // here, which made Math.max() produce NaN and reaping misbehave.
      if (torrent && typeof torrent.addedTime === 'number') t = torrent.addedTime;
    }
    return t;
  }

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

  // webtorrent 1.9.7 deselect() removes only an EXACT {from,to,priority}
  // match — so ranges are tracked verbatim with a stable priority and are
  // deselected exactly as they were selected. Partial-subtract deselects are
  // no-ops in this webtorrent version (that bug made windows stretch forever).
  const SELECT_PRIORITY = 1;

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

    // Expire old retained regions; drop their selections verbatim
    const kept = [];
    for (const r of prev) {
      if (r.expiresAt == null || r.expiresAt > now) {
        kept.push(r);
      } else {
        try { torrent.deselect(r.s, r.e, SELECT_PRIORITY); } catch (_) {}
      }
    }

    // The active window SLIDES with the playhead (never union-merge).
    const activeIdx = kept.findIndex((r) => r.expiresAt == null);
    const others = kept.filter((_, i) => i !== activeIdx); // retained leftovers
    const active = { s: startPiece, e: endPiece, expiresAt: null };
    const nextRanges = [active, ...others];

    if (activeIdx >= 0) {
      const oldActive = kept[activeIdx];
      const identical = oldActive.s === startPiece && oldActive.e === endPiece;
      const disconnected = oldActive.e < startPiece - 2 || oldActive.s > endPiece + 2;
      if (disconnected) {
        // A real seek: keep the OLD region selectable for LAST_REGION_KEEP_MIN
        // (smooth back-seek), as an expiring retained copy. It stays selected
        // as-is — no select/deselect calls needed.
        nextRanges.push({ ...oldActive, expiresAt: now + KEEP_MIN * 60 * 1000 });
      } else if (!identical) {
        // Slid but still overlapping/adjacent: the old window is superseded —
        // drop its selection verbatim.
        try { torrent.deselect(oldActive.s, oldActive.e, SELECT_PRIORITY); } catch (_) {}
      }
    }

    // Select ranges that aren't already selected verbatim
    for (const r of nextRanges) {
      const already = prev.some((p) => p.s === r.s && p.e === r.e);
      if (already) continue;
      try { torrent.select(r.s, r.e, SELECT_PRIORITY); } catch (_) {}
    }
    selected.set(key, nextRanges);

    // Tell the rolling disk store which pieces are protected and its byte
    // budget (≈ the window ± margins), so it auto-evicts trailing chunks.
    if (findRolling) {
      const rs = findRolling(torrent);
      if (rs) rs.setProtectedWindow(startPiece, endPiece, Math.round((back + ahead) * 1.3));
    }
  }

  function janitor() {
    const now = Date.now();

    // 1) Refresh windows for live streams; expire retained regions
    const liveByTorrent = new Map();
    const liveKeys = new Set();
    for (const [id, s] of streams) {
      const stale = s.endedAt != null && now - s.endedAt > KEEP_MIN * 60 * 1000;
      const dead = now - s.lastSeen > Math.max(10 * 60 * 1000, KEEP_MIN * 60 * 1000);
      if (stale || dead) { streams.delete(id); continue; }
      liveKeys.add(`${s.hash}:${s.fileIdx}`);
      if (s.endedAt == null) {
        applyWindow(s); // keep the window glued to the playhead
        liveByTorrent.set(s.hash, (liveByTorrent.get(s.hash) || 0) + 1);
      }
    }

    // 1b) Deselect windows whose streams are gone (kept alive above during
    // the KEEP retention window; once the record is stale, drop everything —
    // verbatim, per webtorrent's exact-match deselect).
    for (const [key, ranges] of [...selected]) {
      if (liveKeys.has(key)) continue;
      const torrent = client.torrents.find((t) => t.infoHash === key.split(':')[0]);
      if (torrent) {
        for (const r of ranges) {
          try { torrent.deselect(r.s, r.e, SELECT_PRIORITY); } catch (_) {}
        }
      }
      selected.delete(key);
    }

    // 2) Reap idle torrents (no live streams and no warmup/loading activity
    // for the full TTL)
    for (const torrent of [...client.torrents]) {
      const infoHash = torrent.infoHash;
      if (!infoHash) continue;
      if ((liveByTorrent.get(infoHash) || 0) > 0) continue;
      const last = lastActivity(infoHash);
      if (!last) {
        // First time the janitor sees this torrent — grant a full TTL of
        // grace instead of instantly condemning it (epoch math bug).
        activity.set(infoHash.toLowerCase(), now);
        continue;
      }
      if (now - last > IDLE_TTL_MS) {
        console.log(`🧹 Governor: reaping idle torrent ${torrent.name || infoHash}`);
        releaseWindows(infoHash);
        activity.delete(infoHash.toLowerCase());
        destroyTorrent(infoHash);
      }
    }

    // 3) Hard guards — never let the kernel do it for us
    const rssMB = process.memoryUsage().rss / 1048576;
    const disk = storeStats ? storeStats() : null;
    if (disk && disk.rootBytes > disk.diskCapBytes) {
      console.warn(`🚨 Governor: disk store ${(disk.rootBytes / 1048576).toFixed(0)}MB exceeded cap ${(disk.diskCapBytes / 1048576).toFixed(0)}MB`);
      const candidates = [...client.torrents]
        .filter((t) => (liveByTorrent.get(t.infoHash) || 0) === 0)
        .sort((a, b) => lastActivity(a.infoHash) - lastActivity(b.infoHash));
      const victim = candidates[0];
      if (victim) {
        console.warn(`🚨 Governor: shedding "${victim.name || victim.infoHash}" to reclaim disk`);
        releaseWindows(victim.infoHash);
        activity.delete(String(victim.infoHash).toLowerCase());
        destroyTorrent(victim.infoHash);
      }
    }
    if (rssMB > MAX_RSS_MB) {
      // Shed the least-recently-touched torrent that has no live streams
      const candidates = [...client.torrents]
        .filter((t) => (liveByTorrent.get(t.infoHash) || 0) === 0)
        .sort((a, b) => lastActivity(a.infoHash) - lastActivity(b.infoHash));
      const victim = candidates[0];
      if (victim) {
        console.warn(`🚨 Governor: RSS ${Math.round(rssMB)}MB > ${MAX_RSS_MB}MB — shedding "${victim.name || victim.infoHash}"`);
        releaseWindows(victim.infoHash);
        activity.delete(String(victim.infoHash).toLowerCase());
        destroyTorrent(victim.infoHash);
      } else if (!shedNoticeShown) {
        shedNoticeShown = true;
        console.warn(`⚠️ Governor: RSS ${Math.round(rssMB)}MB is high but every torrent has live streams; windows are already minimal`);
      }
    } else {
      shedNoticeShown = false;
    }
  }

  function releaseWindows(hash) {
    for (const key of selected.keys()) if (key.startsWith(`${hash}:`)) selected.delete(key);
  }

  const timer = setInterval(janitor, JANITOR_EVERY_MS);
  if (timer.unref) timer.unref();

  console.log(`🪟 Memory governor active — window: -${BACK_MIN}m / +${AHEAD_MIN}m · retain last region ${KEEP_MIN}m · idle reap ${Math.round(IDLE_TTL_MS / 60000)}m · RSS cap ${MAX_RSS_MB}MB`);

  return { registerStream, notePosition, heartbeat, heartbeatByFile, endStream, touch: (id) => {
    // streamId touch (kept for backward compatibility)
    const s = streams.get(id);
    if (s) s.lastSeen = Date.now();
  }, touchHash: touchActivity, lastActivity, windowBytes };
}

module.exports = { create };
