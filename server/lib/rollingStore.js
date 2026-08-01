/**
 * RollingDiskChunkStore — disk-backed, strictly capped, rolling buffer for
 * WebTorrent pieces.
 *
 * Design goals (per product spec):
 *  - Pieces live on DISK, never in an unbounded RAM pool. RAM only carries
 *    pieces in flight through streams.
 *  - The store keeps at most ~capBytes per torrent (≈ the governor's
 *    -5m / +5m window gives ~10 min of media). Every `put` beyond the cap
 *    evicts the OLDEST chunks that lie OUTSIDE the protected playhead window
 *    — the trailing-minutes deletion, automated.
 *  - destroy()/close() wipes the torrent's directory; boot wipes the whole
 *    root, so no stale chunks survive restarts.
 *
 * WebTorrent calls: new Store(pieceLength, opts) then get/put/close/destroy.
 * The governor sets the protected window via setProtectedWindow().
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = process.env.STORE_DIR
  ? path.resolve(process.env.STORE_DIR)
  : path.join(__dirname, '..', 'data', 'chunks');

const DEFAULT_CAP = parseInt(process.env.STORE_CAP_MB || '800', 10) * 1024 * 1024; // ≈10 min @ ~10 Mbps
const DISK_CAP = parseInt(process.env.DISK_CAP_MB || '12000', 10) * 1024 * 1024;   // global safety

// Registry of live stores for global accounting
const registry = new Set();

// Boot: remove any residue from crashed/killed sessions
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch (_) { /* fine */ }
fs.mkdirSync(ROOT, { recursive: true });

function dirTotal(dir) {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) total += dirTotal(path.join(dir, ent.name));
      else total += fs.statSync(path.join(dir, ent.name)).size;
    }
  } catch (_) { /* evicted mid-scan */ }
  return total;
}

function stats() {
  return { rootBytes: dirTotal(ROOT), diskCapBytes: DISK_CAP, stores: registry.size };
}

class RollingDiskChunkStore {
  constructor(chunkLength, opts = {}) {
    this.chunkLength = chunkLength;
    this.name = opts.name || opts.torrent?.name || 'torrent';
    const id = (opts.infoHash || opts.torrent?.infoHash || this.name || `${Date.now()}`)
      .toString().replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
    this.dir = path.join(ROOT, id);
    this.capBytes = DEFAULT_CAP;
    this.protected = { s: 0, e: Infinity }; // piece numbers
    this.chunks = new Map(); // index → { size, at }
    this.bytes = 0;
    this.closed = false;
    fs.mkdirSync(this.dir, { recursive: true });
    registry.add(this);
  }

  /** Governor hook: which pieces must survive eviction + total byte budget. */
  setProtectedWindow(startPiece, endPiece, capBytes) {
    this.protected = { s: startPiece, e: endPiece };
    if (capBytes > 0) this.capBytes = Math.max(capBytes, 32 * 1024 * 1024);
    this._evict();
  }

  _file(index) {
    return path.join(this.dir, String(index));
  }

  get(index, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = null; }
    fs.readFile(this._file(index), (err, buf) => {
      if (err) {
        const e = new Error('Chunk not found');
        e.notFound = true;
        return cb(e);
      }
      const meta = this.chunks.get(index);
      if (meta) meta.at = Date.now();
      cb(null, buf);
    });
  }

  put(index, buf, cb) {
    if (this.closed) return cb?.(new Error('Store closed'));
    const file = this._file(index);
    fs.writeFile(file, buf, (err) => {
      if (err) return cb?.(err);
      const prev = this.chunks.get(index);
      if (prev) this.bytes -= prev.size;
      this.chunks.set(index, { size: buf.length, at: Date.now() });
      this.bytes += buf.length;
      this._evict();
      cb?.(null);
    });
  }

  close(cb) {
    this._cleanup(cb);
  }

  destroy(cb) {
    this._cleanup(cb);
  }

  _cleanup(cb) {
    if (this.closed) { if (cb) cb(null); return; }
    this.closed = true;
    registry.delete(this);
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    if (cb) cb(null);
  }

  /** Evict oldest chunks outside the protected window until under the cap. */
  _evict() {
    if (this.bytes <= this.capBytes) return;
    const { s, e } = this.protected;
    let removed = 0;
    while (this.bytes > this.capBytes) {
      let oldestIdx = -1;
      let oldestAt = Infinity;
      for (const [idx, meta] of this.chunks) {
        if (idx >= s && idx <= e) continue; // inside the playhead window — keep
        if (meta.at < oldestAt) { oldestAt = meta.at; oldestIdx = idx; }
      }
      if (oldestIdx === -1) break; // everything is protected; cap exceeded but safe
      const meta = this.chunks.get(oldestIdx);
      this.chunks.delete(oldestIdx);
      this.bytes -= meta?.size || 0;
      removed++;
      try { fs.unlinkSync(this._file(oldestIdx)); } catch (_) { /* best effort */ }
    }
    if (removed > 0) {
      console.log(`🗑️ RollingStore[${this.name.slice(0, 34)}]: evicted ${removed} trailing chunks · ${(this.bytes / 1048576).toFixed(0)}MB kept`);
    }
  }
}

/** Reach through webtorrent's wrappers (Immediate → Cache → ours). */
function findRolling(torrent) {
  let node = torrent?.store;
  for (let depth = 0; node && depth < 4; depth++) {
    if (node instanceof RollingDiskChunkStore) return node;
    node = node.store || node._store;
  }
  return null;
}

module.exports = { RollingDiskChunkStore, findRolling, stats, ROOT };
