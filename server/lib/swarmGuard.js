/**
 * Swarm guard — keeps one bad torrent from killing the whole server.
 *
 * The failure it prevents (field-observed on the HP EliteBook):
 * a poisoned/fake swarm ("HQ Pre" style releases) pushes GARBAGE pieces at
 * high speed. Every piece is SHA-1 verified, fails, discarded, and
 * re-requested — forever. The event loop pegs at 100%, RSS climbs toward
 * the cap, and EVERYTHING stops loading (health checks, login, history,
 * admin) — it looks exactly like the server crashed, because the loop
 * never gets a turn.
 *
 * Detection, per torrent (sampled every TICK_MS, 3 strikes):
 *   bytes RECEIVED (torrent.downloaded, includes garbage) vs bytes
 *   VERIFIED (bitfield progress ✕ pieceLength). A healthy swarm verifies
 *   roughly what it receives; a poisoned one verifies ~nothing at speed.
 * Relief (deliberately gentle — real clients keep working):
 *   1. torrent.pause() → stop accepting new peers for the offender;
 *   2. client.downloadLimit = trickle → squeeze existing wires so the
 *      event loop, and every other request, gets air again.
 *   3. probation: every few ticks, resume for one tick; if pieces start
 *      verifying again, fully restore (healthy swarms recover instantly).
 * The warmup status picks this up (state(hash).poisoned) so the player can
 * say "this swarm is corrupt — pick another source" instead of "loading…".
 */
const { monitorEventLoopDelay } = require('perf_hooks');

const TICK_MS = parseInt(process.env.GUARD_TICK_MS || '15000', 10);
const STRIKES_NEEDED = 3;                    // consecutive garbage windows before acting
const STRIKE_RX_BYTES = 12 * 1024 * 1024;   // ≥12MB received in a tick…
const STRIKE_OK_BYTES = 1 * 1024 * 1024;    // …while <1MB actually verifies ⇒ garbage
const TRICKLE_BPS = parseInt(process.env.GUARD_TRICKLE_KBPS || '96', 10) * 1024;
const PROBATION_EVERY_TICKS = 4;            // probe for recovery every ~60s
const PROBE_VERIFY_BYTES = 1 * 1024 * 1024; // recovery if ≥1MB verifies during probe tick

function start({ client, logger = console }) {
  const state = new Map(); // hash → { rx, ok, strikes, poisoned, ticks, probeMode, lastLog }
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let lagMeanMs = 0;
  let lagP95Ms = 0;
  let throttleActive = false;

  function verifiedBytes(torrent) {
    // bitfield-verified fraction × total size — garbage fails verification
    // and never lands in progress, exactly the signal we need.
    return Math.round((torrent.progress || 0) * (torrent.length || 0));
  }

  function applyThrottle() {
    if (throttleActive) return;
    throttleActive = true;
    try { client.downloadLimit = TRICKLE_BPS; } catch (_) { /* fine */ }
  }

  function releaseThrottle() {
    // Only release when NOTHING is poisoned anymore
    for (const s of state.values()) if (s.poisoned) return;
    if (!throttleActive) return;
    throttleActive = false;
    try { client.downloadLimit = -1; } catch (_) { /* fine */ }
    logger.log('🛡️ Guard: swarm healthy again — throughput restored');
  }

  function tick() {
    lagMeanMs = lag.mean / 1e6;
    lagP95Ms = lag.percentile(95) / 1e6;
    lag.reset();

    // Housekeep torrents that left the client
    const live = new Set(client.torrents.map((t) => t.infoHash));
    for (const h of state.keys()) if (!live.has(h)) state.delete(h);

    let anyPoisoned = false;
    for (const torrent of client.torrents) {
      if (!torrent.ready || !torrent.pieceLength) continue;
      const h = torrent.infoHash;
      let s = state.get(h);
      if (!s) {
        s = { rx: torrent.downloaded || 0, ok: verifiedBytes(torrent), strikes: 0, poisoned: false, ticks: 0, probe: false, lastLog: 0 };
        state.set(h, s);
        continue;
      }

      const rxNow = torrent.downloaded || 0;
      const okNow = verifiedBytes(torrent);
      const dRx = Math.max(0, rxNow - s.rx);
      const dOk = Math.max(0, okNow - s.ok);
      s.rx = rxNow;
      s.ok = okNow;
      s.ticks++;

      if (!s.poisoned) {
        if (dRx >= STRIKE_RX_BYTES && dOk < STRIKE_OK_BYTES) s.strikes++;
        else s.strikes = 0;

        if (s.strikes >= STRIKES_NEEDED) {
          s.poisoned = true;
          s.probe = false;
          s.ticks = 0;
          try { torrent.pause(); } catch (_) { /* fine */ }
          applyThrottle();
          logger.warn(
            `🛡️ Guard: POISONED SWARM DETECTED — "${torrent.name || h}" received ${(dRx / 1048576).toFixed(0)}MB but verified <1MB. ` +
            'New peers paused, throughput throttled to a trickle. This torrent is garbage — swap sources.'
          );
        }
      } else {
        anyPoisoned = true;
        // Probation: briefly resume every few ticks and see if real data flows
        if (s.ticks % PROBATION_EVERY_TICKS === 0) {
          if (!s.probe) {
            s.probe = true;
            try { torrent.resume(); } catch (_) { /* fine */ }
            s.probeBaseline = okNow;
          }
        } else if (s.probe) {
          const gained = okNow - (s.probeBaseline ?? okNow);
          if (gained >= PROBE_VERIFY_BYTES) {
            s.poisoned = false;
            s.strikes = 0;
            s.probe = false;
            anyPoisoned = false; // may still be recomputed below; best effort
            logger.log(`🛡️ Guard: "${torrent.name || h}" verifies again (+${(gained / 1048576).toFixed(1)}MB during probe) — releasing throttle`);
            releaseThrottle();
          } else {
            s.probe = false;
            try { torrent.pause(); } catch (_) { /* fine */ }
            if (Date.now() - s.lastLog > 5 * 60 * 1000) {
              s.lastLog = Date.now();
              logger.warn(`🛡️ Guard: "${torrent.name || h}" still poisonous — staying throttled`);
            }
          }
        }
      }
    }
    if (!anyPoisoned) releaseThrottle();
  }

  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();

  return {
    state: (hash) => {
      const s = state.get(String(hash || '').toLowerCase());
      if (!s) return { poisoned: false };
      return { poisoned: !!s.poisoned, received: s.rx, verified: s.ok };
    },
    summary: () => ({
      lagMsMean: Math.round(lagMeanMs),
      lagMsP95: Math.round(lagP95Ms),
      throttled: throttleActive,
      poisoned: [...state.entries()].filter(([, s]) => s.poisoned).map(([h]) => h),
    }),
    _tick: tick, // exposed for tests
  };
}

module.exports = { start };
