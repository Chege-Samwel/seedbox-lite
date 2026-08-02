/**
 * Tiny persistent JSON store with atomic writes and in-memory caching.
 * Used for tickets, sessions, per-user data, and API caches.
 *
 * Multi-process coherence (the tickets CLI edits these files while the
 * server runs):
 *  - read():  if the on-disk file is newer than our cached copy, the
 *    external commit wins — reload it and DROP any debounced write of ours,
 *    even one that is still pending (a CLI revoke landing in the 150ms
 *    window after a login must not be hidden from the next request).
 *  - flush(): before overwriting, re-check the disk; if it changed since
 *    our last known stamp, our pending delta is stale — drop it and reload
 *    instead of clobbering the external commit.
 * Change detection uses mtime + size (same-ms writers are distinguished by
 * size). Last-writer-wins only for back-to-back commits with no reader in
 * between, which is the best a shared JSON file can do without locking.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(DATA_DIR);

const memory = new Map();
const meta = new Map(); // name → { mtimeMs, size } of the file our cached copy came from
const pendingWrites = new Map();

function fileFor(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

const changed = (st, known) =>
  st.mtimeMs > known.mtimeMs || (st.mtimeMs === known.mtimeMs && st.size !== known.size);

const stampOf = (st) => ({ mtimeMs: st.mtimeMs, size: st.size });

function read(name, fallback) {
  if (memory.has(name)) {
    try {
      const file = fileFor(name);
      const known = meta.get(name) || { mtimeMs: 0, size: -1 };
      const st = fs.existsSync(file) ? fs.statSync(file) : null;
      if (st && changed(st, known)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        memory.set(name, data);
        meta.set(name, stampOf(st));
        // External commit supersedes our queued write — cancel it, or its
        // flush would re-clobber what we just reloaded.
        if (pendingWrites.has(name)) {
          clearTimeout(pendingWrites.get(name));
          pendingWrites.delete(name);
        }
      }
    } catch (err) {
      console.error(`⚠️ jsondb: hot-reload of ${name} failed: ${err.message}`);
    }
    return memory.get(name);
  }
  const file = fileFor(name);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      memory.set(name, data);
      try { meta.set(name, stampOf(fs.statSync(file))); } catch (_) { /* fine */ }
      return data;
    }
  } catch (err) {
    console.error(`⚠️ jsondb: failed to read ${name}: ${err.message}`);
  }
  memory.set(name, fallback);
  meta.set(name, { mtimeMs: 0, size: -1 });
  return fallback;
}

function write(name, data) {
  memory.set(name, data);
  // Debounce disk writes per key (150ms) to avoid hammering fs during polls
  if (pendingWrites.has(name)) clearTimeout(pendingWrites.get(name));
  pendingWrites.set(name, setTimeout(() => {
    pendingWrites.delete(name);
    flush(name);
  }, 150));
}

function flush(name) {
  if (!memory.has(name)) return;
  const file = fileFor(name);
  try {
    // Never clobber a newer on-disk copy with our stale cache.
    const known = meta.get(name) || { mtimeMs: 0, size: -1 };
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (changed(st, known)) {
        try {
          memory.set(name, JSON.parse(fs.readFileSync(file, 'utf8')));
          meta.set(name, stampOf(st));
        } catch (_) { /* keep memory on parse failure */ }
        return;
      }
    }
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memory.get(name), null, 2));
    fs.renameSync(tmp, file);
    // Stamp our own write so the hot-reload check doesn't bounce it back
    try { meta.set(name, stampOf(fs.statSync(file))); } catch (_) { /* fine */ }
  } catch (err) {
    console.error(`⚠️ jsondb: failed to write ${name}: ${err.message}`);
  }
}

function flushAll() {
  for (const name of memory.keys()) flush(name);
}

process.on('exit', () => {
  try { flushAll(); } catch (_) { /* best effort */ }
});

module.exports = { read, write, flush, flushAll, DATA_DIR };
