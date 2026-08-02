/**
 * Internet Archive integration — a fully legal catalog of public domain and
 * openly licensed films/shows. Provides search, home rows, and item details
 * including directly streamable file URLs and subtitle files.
 */
const db = require('./jsondb');

const IA = 'https://archive.org';
const CACHE_KEY = 'ia_cache';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function cache() { return db.read(CACHE_KEY, { entries: {} }); }

function cachedGet(key) {
  const entry = cache().entries[key];
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.data;
  return null;
}

function cachedSet(key, data) {
  const c = cache();
  c.entries[key] = { at: Date.now(), data };
  // Prune old entries lazily
  const keys = Object.keys(c.entries);
  if (keys.length > 400) {
    for (const k of keys) if (Date.now() - c.entries[k].at >= CACHE_TTL_MS) delete c.entries[k];
  }
  db.write(CACHE_KEY, c);
}

async function fetchJson(url, timeoutMs = 9000) {
  const hit = cachedGet(url);
  if (hit) return hit;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'SeedBoxLite/2.0 (+legal-media-streaming)' },
    });
    if (!res.ok) throw new Error(`IA responded ${res.status}`);
    const data = await res.json();
    cachedSet(url, data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function img(identifier) {
  return `${IA}/services/img/${encodeURIComponent(identifier)}`;
}

function fileUrl(identifier, filename) {
  return `${IA}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;
}

function docToCard(doc) {
  return {
    kind: 'archive',
    id: doc.identifier,
    title: doc.title || 'Untitled',
    year: doc.year ? parseInt(doc.year, 10) : (doc.date ? parseInt(String(doc.date).slice(0, 4), 10) : null),
    downloads: doc.downloads || 0,
    poster: img(doc.identifier),
    description: Array.isArray(doc.description) ? doc.description.join(' ') : doc.description || '',
  };
}

/**
 * Search Internet Archive advancedsearch API.
 */
async function search(query, { page = 1, rows = 24, sort = 'downloads desc', mediaType = 'movies' } = {}) {
  const q = mediaType === 'all' ? query : `${query} AND mediatype:${mediaType}`;
  const params = new URLSearchParams({ q, output: 'json' });
  ['identifier', 'title', 'year', 'date', 'downloads', 'description', 'mediatype'].forEach((f) => params.append('fl[]', f));
  params.set('rows', String(rows));
  params.set('page', String(page));
  params.append('sort[]', sort);
  const data = await fetchJson(`${IA}/advancedsearch.php?${params.toString()}`);
  const docs = data?.response?.docs || [];
  return {
    results: docs.filter((d) => d.identifier && d.title).map(docToCard),
    numFound: data?.response?.numFound || 0,
    page,
    rowsPerPage: rows,
  };
}

/**
 * Curated rows for the home screen. Each row is one IA query.
 */
const HOME_ROWS = [
  { key: 'trending', title: 'Public Domain Essentials', q: 'collection:feature_films AND mediatype:movies' },
  { key: 'scifi', title: 'Classic Sci-Fi', q: 'collection:feature_films AND subject:(science fiction) AND mediatype:movies' },
  { key: 'horror', title: 'Vintage Horror', q: 'collection:feature_films AND subject:horror AND mediatype:movies' },
  { key: 'comedy', title: 'Golden Age Comedy', q: 'collection:feature_films AND subject:comedy AND mediatype:movies' },
  { key: 'cartoons', title: 'Classic Cartoons', q: 'collection:classic_cartoons AND mediatype:movies' },
  { key: 'silent', title: 'Silent Era', q: 'collection:silent_films AND mediatype:movies' },
  { key: 'docs', title: 'Documentaries', q: 'collection:opensource_movies AND subject:documentary AND mediatype:movies' },
];

async function home() {
  const rows = [];
  let anyOk = false;
  const settled = await Promise.allSettled(
    HOME_ROWS.map(async (row) => {
      const data = await search(row.q, { rows: 18 });
      return { key: row.key, title: row.title, items: data.results };
    })
  );
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value.items.length > 0) {
      rows.push(r.value);
      anyOk = true;
    }
  }
  return { rows, offline: !anyOk };
}

const VIDEO_EXTS = ['.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.avi', '.mov'];
const SUB_EXTS = ['.vtt', '.srt'];
const PLAYABLE_EXTS = ['.mp4', '.m4v', '.webm', '.ogv', '.mov']; // browsers can't stream mkv/avi

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

/**
 * Full details for one IA item: metadata, playable files, subtitles.
 */
async function item(identifier) {
  const data = await fetchJson(`${IA}/metadata/${encodeURIComponent(identifier)}`);
  const meta = data?.metadata || {};
  const files = (data?.files || []).filter((f) => f && f.name && f.private !== 'true');

  const videoFiles = files
    .filter((f) => VIDEO_EXTS.includes(extOf(f.name)))
    .map((f, idx) => ({
      index: idx,
      name: f.name,
      size: parseInt(f.size || '0', 10),
      format: f.format || extOf(f.name),
      url: fileUrl(identifier, f.name),
      browserPlayable: PLAYABLE_EXTS.includes(extOf(f.name)),
    }))
    .sort((a, b) => {
      // Prefer browser-playable, then largest (best quality)
      if (a.browserPlayable !== b.browserPlayable) return a.browserPlayable ? -1 : 1;
      return b.size - a.size;
    })
    .slice(0, 12);

  const subtitles = files
    .filter((f) => SUB_EXTS.includes(extOf(f.name)))
    .map((f) => ({ name: f.name, size: parseInt(f.size || '0', 10), url: fileUrl(identifier, f.name), ext: extOf(f.name) }))
    .slice(0, 25);

  const subjects = meta.subject ? (Array.isArray(meta.subject) ? meta.subject : [meta.subject]) : [];

  return {
    kind: 'archive',
    id: identifier,
    title: meta.title || identifier,
    year: meta.year ? parseInt(meta.year, 10) : (meta.date ? parseInt(String(meta.date).slice(0, 4), 10) : null),
    description: Array.isArray(meta.description) ? meta.description.join(' ') : meta.description || '',
    creator: Array.isArray(meta.creator) ? meta.creator.join(', ') : meta.creator || '',
    runtime: meta.runtime || null,
    language: Array.isArray(meta.language) ? meta.language.join(', ') : meta.language || '',
    license: meta.licenseurl || meta.rights || null,
    subjects: subjects.slice(0, 12),
    downloads: meta.downloads ? parseInt(meta.downloads, 10) : undefined,
    poster: img(identifier),
    backdrop: img(identifier),
    videos: videoFiles,
    subtitles,
    primaryVideo: videoFiles[0] || null,
    streamUrl: videoFiles[0] ? videoFiles[0].url : null,
  };
}

module.exports = { search, home, item, img, fileUrl };
