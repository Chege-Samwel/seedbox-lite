/**
 * Central runtime tuning — one module that resolves env vars into the
 * resource budget every other module obeys.
 *
 * LITE_MODE=true packs a known-good profile for tiny hosts (a laptop that
 * should stay cool, a 512MB container, a shared-CPU free tier). Every
 * individual value can still be overridden explicitly — explicit env vars
 * always win over the lite preset.
 *
 * Why a budget, honestly stated:
 *  - WebTorrent + piece hashing + the rolling store hold a working set of
 *    hundreds of MB while streaming; a 512MB host OOMs with the defaults.
 *  - Transcoding (ffmpeg) needs roughly a whole modern core per 720p
 *    session; on a 0.1-CPU free tier it simply cannot run — so LITE_MODE
 *    turns it off and the player streams the source file directly.
 */
const num = (name, dflt) => {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
};
const bool = (name, dflt = false) => {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const LITE = bool('LITE_MODE', false);

const tuning = {
  lite: LITE,

  // --- WebTorrent client ---
  maxConns: num('WT_MAX_CONNS', LITE ? 30 : 150),
  maxWebConns: num('WT_MAX_WEB_CONNS', LITE ? 8 : 20),

  // --- Governor (sliding time-window buffer) ---
  windowBackMin: num('WINDOW_BACK_MIN', LITE ? 2 : 5),
  windowAheadMin: num('WINDOW_AHEAD_MIN', LITE ? 3 : 5),
  lastRegionKeepMin: num('LAST_REGION_KEEP_MIN', LITE ? 2 : 4),
  idleTorrentTtlMin: num('IDLE_TORRENT_TTL_MIN', LITE ? 6 : 10),
  maxRssMb: num('MAX_RSS_MB', LITE ? 420 : 1400),

  // --- Warmup gate ("buffer the first minute before play") ---
  warmTargetMb: num('WARM_DEFAULT_MB', LITE ? 16 : 32),
  warmMaxMb: num('WARM_MAX_MB', 128),
  warmReadyMinMb: num('WARM_READY_MIN_MB', LITE ? 4 : 8),
  warmWindowKeepMin: num('WARM_WINDOW_KEEP_MIN', LITE ? 2 : 4),
  // No byte progress for this long ⇒ report the swarm as stalled so the
  // player can say so (and poll gently) instead of spinning forever.
  warmStallMs: num('WARM_STALL_MS', 45000),

  // --- Engine caps ---
  // Hard ceiling on simultaneously-loaded torrents (0 = unlimited). On
  // tiny hosts one extra 3GB torrent is the difference between "works"
  // and OOM-kill — refuse early with a clear error instead.
  maxActiveTorrents: num('MAX_ACTIVE_TORRENTS', LITE ? 2 : 0),
  // Transcoding is the single hottest thing this server can do (~1 core
  // per 720p session). LITE_MODE disables it; explicit opt-out works too.
  transcodeEnabled: !LITE && !bool('DISABLE_TRANSCODE', false),
  // How long a stream request may wait for its first byte before the
  // server answers 503 + Retry-After (the player auto-reconnects).
  streamSetupTimeoutMs: num('STREAM_SETUP_TIMEOUT_MS', LITE ? 45000 : 60000),

  // --- Browse cache (home feed is identical for every user; serve stale) ---
  browseCacheMin: num('BROWSE_CACHE_MIN', LITE ? 30 : 10),
};

/** One-line boot summary of the budget that actually applies. */
tuning.describe = () =>
  `window: -${tuning.windowBackMin}m / +${tuning.windowAheadMin}m · retain last region ${tuning.lastRegionKeepMin}m · ` +
  `idle reap ${tuning.idleTorrentTtlMin}m · RSS cap ${tuning.maxRssMb}MB · conns ${tuning.maxConns}` +
  (tuning.maxActiveTorrents ? ` · max ${tuning.maxActiveTorrents} torrents` : '') +
  (tuning.transcodeEnabled ? '' : ' · transcode OFF');

module.exports = tuning;
