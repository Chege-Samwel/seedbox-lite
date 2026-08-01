/**
 * Tiny persistent JSON store with atomic writes and in-memory caching.
 * Used for tickets, sessions, per-user data, and API caches.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(DATA_DIR);

const memory = new Map();

function fileFor(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

function read(name, fallback) {
  if (memory.has(name)) return memory.get(name);
  const file = fileFor(name);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      memory.set(name, data);
      return data;
    }
  } catch (err) {
    console.error(`⚠️ jsondb: failed to read ${name}: ${err.message}`);
  }
  memory.set(name, fallback);
  return fallback;
}

const pendingWrites = new Map();

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
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memory.get(name), null, 2));
    fs.renameSync(tmp, file);
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
