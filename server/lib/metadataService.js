/**
 * Picture/metadata library — turns keywords (a title from a magnet name or a
 * search phrase) into posters, backdrops, overviews, and full TV season /
 * episode structures.
 *
 * Provider chain (first hit wins):
 *   1. TMDB  — if TMDB_API_KEY is set (richest data: backdrops, seasons)
 *   2. TVMaze — free, no key needed, excellent TV season/episode data
 *   3. iTunes — free, no key needed, decent movie artwork fallback
 *   4. OMDb  — legacy key from this repo as a last-resort movie poster
 *
 * All responses are cached to disk; failures degrade gracefully (found:false).
 */
const db = require('./jsondb');

const CACHE_KEY = 'metadata_cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const OMDB_KEY = process.env.OMDB_API_KEY || '8265bd1c';
const TMDB_IMG = 'https://image.tmdb.org/t/p';

function cache() { return db.read(CACHE_KEY, { entries: {} }); }

async function cachedJson(url, timeoutMs = 8000) {
  const c = cache();
  const hit = c.entries[url];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'SeedBoxLite/2.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    c.entries[url] = { at: Date.now(), data };
    if (Object.keys(c.entries).length > 600) {
      for (const k of Object.keys(c.entries)) if (Date.now() - c.entries[k].at >= CACHE_TTL_MS) delete c.entries[k];
    }
    db.write(CACHE_KEY, c);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

function cleanTitle(raw) {
  // Strip common torrent-name noise: quality tags, years, release groups
  let t = String(raw || '');
  t = t.replace(/\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i, '');
  t = t.replace(/[._]/g, ' ');
  t = t.replace(/\b(720p|1080p|2160p|4k|480p|bluray|brrip|bdrip|webrip|web[- ]?dl|hdtv|x264|x265|hevc|h264|h265|aac|dts|yify|rarbg|etrg|proper|repack|extended|unrated|hdrip|cam|ts|dvdscr|dvdrip)\b/gi, '');
  const yearMatch = t.match(/\b(19\d{2}|20[0-3]\d)\b/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
  if (yearMatch) t = t.slice(0, yearMatch.index);
  t = t.replace(/\[\s*[^\]]*\]|\(\s*[^\)]*\)\s*$/g, '').replace(/\s{2,}/g, ' ').trim();
  return { title: t, year };
}

/** S#/E# extraction from a filename, e.g. "Show.S02E05..." */
function parseEpisode(raw) {
  const m = String(raw || '').match(/[sS](\d{1,2})[eE](\d{1,3})/) || String(raw || '').match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (!m) return { season: null, episode: null };
  return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
}

// ---------- Normalizers ----------

function normalizeTmdbMovie(r) {
  return {
    source: 'tmdb',
    id: `tmdb-movie-${r.id}`,
    kind: 'movie',
    title: r.title || r.original_title,
    year: r.release_date ? parseInt(r.release_date.slice(0, 4), 10) : null,
    overview: r.overview || '',
    poster: r.poster_path ? `${TMDB_IMG}/w500${r.poster_path}` : null,
    backdrop: r.backdrop_path ? `${TMDB_IMG}/w1280${r.backdrop_path}` : null,
    rating: r.vote_average || null,
  };
}

function normalizeTmdbTv(r) {
  return {
    source: 'tmdb',
    id: `tmdb-tv-${r.id}`,
    kind: 'show',
    title: r.name || r.original_name,
    year: r.first_air_date ? parseInt(r.first_air_date.slice(0, 4), 10) : null,
    overview: r.overview || '',
    poster: r.poster_path ? `${TMDB_IMG}/w500${r.poster_path}` : null,
    backdrop: r.backdrop_path ? `${TMDB_IMG}/w1280${r.backdrop_path}` : null,
    rating: r.vote_average || null,
  };
}

function normalizeTvmazeShow(s) {
  return {
    source: 'tvmaze',
    id: `tvmaze-${s.id}`,
    kind: 'show',
    title: s.name,
    year: s.premiered ? parseInt(s.premiered.slice(0, 4), 10) : null,
    overview: stripHtml(s.summary),
    poster: s.image?.original || s.image?.medium || null,
    backdrop: s.image?.original || null,
    rating: s.rating?.average || null,
    genres: s.genres || [],
  };
}

function normalizeItunes(r) {
  const art = r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : null;
  return {
    source: 'itunes',
    id: `itunes-${r.trackId}`,
    kind: r.wrapperType === 'track' && r.primaryGenreName && r.kind === 'feature-movie' ? 'movie' : (r.collectionType === 'TV Season' ? 'show' : 'movie'),
    title: r.trackName || r.collectionName,
    year: r.releaseDate ? parseInt(r.releaseDate.slice(0, 4), 10) : null,
    overview: r.longDescription || r.shortDescription || '',
    poster: art,
    backdrop: null,
    rating: null,
  };
}

function normalizeOmdb(r) {
  return {
    source: 'omdb',
    id: `omdb-${r.imdbID}`,
    kind: r.Type === 'series' ? 'show' : 'movie',
    title: r.Title,
    year: r.Year ? parseInt(r.Year, 10) : null,
    overview: r.Plot || '',
    poster: r.Poster && r.Poster !== 'N/A' ? r.Poster : null,
    backdrop: null,
    rating: r.imdbRating ? parseFloat(r.imdbRating) : null,
  };
}

// ---------- Search ----------

/**
 * Look up artwork/metadata for a keyword. Tries providers in order.
 * type: 'movie' | 'show' | 'any'
 */
async function lookup(queryInput, { type = 'any', year = null } = {}) {
  if (!queryInput) return { found: false };
  const query = String(queryInput).trim();
  if (!query) return { found: false };

  // 1) TMDB
  if (TMDB_KEY) {
    try {
      const tmdbType = type === 'movie' ? 'movie' : type === 'show' ? 'tv' : 'multi';
      const data = await cachedJson(
        `https://api.themoviedb.org/3/search/${tmdbType}?api_key=${TMDB_KEY}&language=en-US&page=1&include_adult=false&query=${encodeURIComponent(query)}${year ? `&year=${year}&first_air_date_year=${year}` : ''}`
      );
      const list = (data.results || []).filter((r) => r.media_type !== 'person');
      if (list.length) {
        const best = list[0];
        return { found: true, best: best.media_type === 'tv' || best.first_air_date ? normalizeTmdbTv(best) : normalizeTmdbMovie(best), results: list.slice(0, 10).map((r) => (r.media_type === 'tv' || r.first_air_date ? normalizeTmdbTv(r) : normalizeTmdbMovie(r))) };
      }
    } catch (err) {
      console.warn(`⚠️ TMDB lookup failed: ${err.message}`);
    }
  }

  // 2) TVMaze (TV)
  if (type === 'show' || type === 'any') {
    try {
      const data = await cachedJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
      if (Array.isArray(data) && data.length) {
        const shows = data.filter((d) => d.show).sort((a, b) => (b.score || 0) - (a.score || 0));
        if (shows.length) {
          return { found: true, best: normalizeTvmazeShow(shows[0].show), results: shows.slice(0, 10).map((d) => normalizeTvmazeShow(d.show)) };
        }
      }
    } catch (err) {
      console.warn(`⚠️ TVMaze lookup failed: ${err.message}`);
    }
  }

  // 3) iTunes
  try {
    const media = type === 'show' ? 'tvShow' : 'movie';
    const data = await cachedJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=${media}&limit=10${year ? '' : ''}&country=US`
    );
    if (data.results && data.results.length) {
      return { found: true, best: normalizeItunes(data.results[0]), results: data.results.map(normalizeItunes) };
    }
  } catch (err) {
    console.warn(`⚠️ iTunes lookup failed: ${err.message}`);
  }

  // 4) OMDb
  try {
    const data = await cachedJson(
      `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(query)}${year ? `&y=${year}` : ''}&type=${type === 'show' ? 'series' : 'movie'}&plot=short`
    );
    if (data && data.Response === 'True') {
      return { found: true, best: normalizeOmdb(data), results: [normalizeOmdb(data)] };
    }
  } catch (err) {
    console.warn(`⚠️ OMDb lookup failed: ${err.message}`);
  }

  return { found: false };
}

// ---------- TV show structure (seasons + episodes) ----------

async function tvmazeShowStructure(showId, seasonNumber) {
  const [seasons, episodes] = await Promise.all([
    cachedJson(`https://api.tvmaze.com/shows/${showId}/seasons`),
    cachedJson(`https://api.tvmaze.com/shows/${showId}/episodes`),
  ]);
  const seasonList = (seasons || []).map((s) => ({
    number: s.number,
    name: s.name || `Season ${s.number}`,
    episodeCount: s.episodeOrder || (episodes || []).filter((e) => e.season === s.number).length,
    poster: s.image?.original || s.image?.medium || null,
    premiereDate: s.premiereDate || null,
  }));
  const wanted = seasonNumber != null
    ? (episodes || []).filter((e) => e.season === seasonNumber)
    : [];
  const epList = wanted.map((e) => ({
    season: e.season,
    number: e.number,
    name: e.name,
    overview: stripHtml(e.summary),
    runtime: e.runtime || null,
    airdate: e.airdate || null,
    still: e.image?.original || e.image?.medium || null,
    rating: e.rating?.average || null,
  }));
  return { seasons: seasonList, episodes: epList };
}

async function tmdbShowStructure(tmdbId, seasonNumber) {
  const show = await cachedJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=en-US`);
  const seasons = (show.seasons || [])
    .filter((s) => s.season_number > 0)
    .map((s) => ({
      number: s.season_number,
      name: s.name,
      episodeCount: s.episode_count,
      poster: s.poster_path ? `${TMDB_IMG}/w500${s.poster_path}` : null,
      premiereDate: s.air_date || null,
    }));
  let episodes = [];
  if (seasonNumber != null) {
    const data = await cachedJson(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_KEY}&language=en-US`);
    episodes = (data.episodes || []).map((e) => ({
      season: e.season_number,
      number: e.episode_number,
      name: e.name,
      overview: e.overview || '',
      runtime: e.runtime || null,
      airdate: e.air_date || null,
      still: e.still_path ? `${TMDB_IMG}/w300${e.still_path}` : null,
      rating: e.vote_average || null,
    }));
  }
  return {
    seasons,
    episodes,
    meta: {
      backdrop: show.backdrop_path ? `${TMDB_IMG}/w1280${show.backdrop_path}` : null,
      overview: show.overview || '',
    },
  };
}

/**
 * Resolve a show by name (tvmaze id, tmdb id or free text) and get structure.
 * Returns { found, show, seasons, episodes? }
 */
async function getShow(nameOrId, seasonNumber = null) {
  try {
    // Direct TVMaze id
    if (/^tvmaze-(\d+)$/.test(nameOrId)) {
      const id = nameOrId.split('-')[1];
      const showData = await cachedJson(`https://api.tvmaze.com/shows/${id}`);
      const structure = await tvmazeShowStructure(id, seasonNumber);
      return { found: true, show: normalizeTvmazeShow(showData), ...structure };
    }
    // Direct TMDB id
    if (TMDB_KEY && /^tmdb-tv-(\d+)$/.test(nameOrId)) {
      const id = nameOrId.split('-')[2];
      const structure = await tmdbShowStructure(id, seasonNumber);
      const showData = await cachedJson(`https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}&language=en-US`);
      return { found: true, show: normalizeTmdbTv(showData), ...structure };
    }
    // Free-text search → providers
    const result = await lookup(nameOrId, { type: 'show' });
    if (!result.found) return { found: false };
    const show = result.best;
    if (show.source === 'tvmaze') {
      const structure = await tvmazeShowStructure(show.id.split('-')[1], seasonNumber);
      return { found: true, show, ...structure };
    }
    if (show.source === 'tmdb' && TMDB_KEY) {
      const structure = await tmdbShowStructure(show.id.split('-')[2], seasonNumber);
      return { found: true, show, ...structure };
    }
    return { found: true, show, seasons: [], episodes: [] };
  } catch (err) {
    console.warn(`⚠️ Show structure lookup failed for "${nameOrId}": ${err.message}`);
    return { found: false, error: err.message };
  }
}

module.exports = { lookup, getShow, cleanTitle, parseEpisode };
