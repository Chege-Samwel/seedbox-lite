/**
 * Central API client — token-aware fetch helpers for every backend module.
 */
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

// ── API base resolution ─────────────────────────────────────────────────
// The build-time VITE_API_BASE_URL is only for split hosting (static UI on
// one origin, API on another). History lesson: a placeholder
// (`https://seedbox-api.<domain>`) shipped in .env.production and turned
// every "Cannot reach the server" login red. So:
//  1. a baked value that still looks like a template is ignored entirely;
//  2. if calls against the baked base die with a NETWORK error (not 4xx —
//  those mean the server answered), we retry the same request against the
//  origin that served the UI and, if that works, learn the override so
//  <video>/<track> URL builders follow too.
const BAKED_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BAKED_IS_TEMPLATE = !BAKED_BASE || BAKED_BASE.includes('<') || BAKED_BASE.includes('seedbox-api.');
const OVERRIDE_KEY = 'sb_api_base_override';

export const apiBase = () => {
  const saved = localStorage.getItem(OVERRIDE_KEY);
  if (saved !== null) return saved;
  return BAKED_IS_TEMPLATE ? '' : BAKED_BASE;
};
/** Point the whole app at a different Heiken server (split hosting with a
 *  changing tunnel URL). Empty string clears the override. */
export const setApiBaseOverride = (b) => {
  let clean = String(b || '').trim();
  // Accept a URL copied from Markdown/chat as well as a bare URL. This keeps
  // a pasted `[[https://...](https://...)]` value from becoming the host.
  const url = clean.match(/https?:\/\/[^\s\])}]+/i);
  if (url) clean = url[0];
  clean = clean.replace(/\/+$/, '');
  if (clean) localStorage.setItem(OVERRIDE_KEY, clean);
  else localStorage.removeItem(OVERRIDE_KEY);
  window.dispatchEvent(new Event('sb_api_base_changed'));
};
const setBaseOverride = (b) => { setApiBaseOverride(b); };
const TOKEN_KEY = 'sb_session_token';
const CONSENT_KEY = 'sb_consent'; // 'granted' | 'denied'

/**
 * Consent-aware storage:
 *  - consent granted → localStorage (persistent: auto-login next visit)
 *  - denied/unset   → sessionStorage (dies with the tab, nothing persisted)
 */
export const getConsent = () => localStorage.getItem(CONSENT_KEY);

export const setConsent = (mode) => {
  const token = getToken();
  const user = localStorage.getItem('sb_user') || sessionStorage.getItem('sb_user');
  if (mode === 'granted') {
    localStorage.setItem(CONSENT_KEY, 'granted');
    if (token) { localStorage.setItem(TOKEN_KEY, token); sessionStorage.removeItem(TOKEN_KEY); }
    if (user) { localStorage.setItem('sb_user', user); sessionStorage.removeItem('sb_user'); }
  } else {
    localStorage.setItem(CONSENT_KEY, 'denied');
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('sb_user');
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    if (user) sessionStorage.setItem('sb_user', user);
  }
};

export const getToken = () =>
  sessionStorage.getItem(TOKEN_KEY) || (getConsent() === 'granted' ? localStorage.getItem(TOKEN_KEY) : null);

export const setToken = (t) => {
  const store = getConsent() === 'granted' ? localStorage : sessionStorage;
  // Always clear both to avoid split-brain states
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  if (t) store.setItem(TOKEN_KEY, t);
};

export const getCachedUser = () => {
  const raw = sessionStorage.getItem('sb_user') || (getConsent() === 'granted' ? localStorage.getItem('sb_user') : null);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};

export const setCachedUser = (u) => {
  localStorage.removeItem('sb_user');
  sessionStorage.removeItem('sb_user');
  if (u) (getConsent() === 'granted' ? localStorage : sessionStorage).setItem('sb_user', JSON.stringify(u));
};

// Helper to append ngrok bypass query param for resources that cannot carry custom headers
const withNgrokBypass = (url) => `${url}${url.includes('?') ? '&' : '?'}ngrok-skip-browser-warning=1`;

async function apiFetch(path, { method = 'GET', body, timeoutMs = 20000, retries = 0 } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetchWithTimeout(
        withNgrokBypass(`${apiBase()}${path}`),
        { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
        timeoutMs
      );
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) {
        const err = new Error(data?.error || data?.message || `Request failed (${res.status})`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      // Success against a learned-override-less base: if the configured base
      // was broken before, note that it works now (clears stale overrides).
      return data;
    } catch (err) {
      // Network-level failure against a non-empty base: the baked URL may be
      // wrong for how the UI was reached (LAN IP, tunnel, swapped ports).
      // Retry against the origin that served this page — if THAT works,
      // remember it so every future call (and stream URL) follows.
      if (!err.status && apiBase() !== '' && window.location?.origin && !window.location.origin.startsWith(apiBase())) {
        try {
          const res2 = await fetchWithTimeout(
            withNgrokBypass(`${window.location.origin}${path}`),
            { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
            timeoutMs
          );
          const data2 = await res2.json().catch(() => null);
          if (res2.ok) {
            console.warn(`[seedbox] configured API base (${apiBase()}) unreachable — re-pinned to same-origin (${window.location.origin})`);
            setBaseOverride(window.location.origin);
            return data2;
          }
        } catch { /* fall through to the original error */ }
      }
      // Retry idempotent GETs once or twice: a busy server (torrent engine
      // warming up) can otherwise leave the archive UI dead until reload.
      const transient = !err.status || err.status >= 500;
      if (method === 'GET' && transient && attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ---------- Auth ----------
export const loginWithTicket = (ticketCode) =>
  apiFetch('/api/auth/login', { method: 'POST', body: { ticketCode } });
export const validateSession = () => apiFetch('/api/auth/validate', { timeoutMs: 10000 });
export const logoutSession = () => apiFetch('/api/auth/logout', { method: 'POST', timeoutMs: 8000 }).catch(() => ({}));

// ---------- Admin ----------
export const adminFetch = (path, adminKey, opts = {}) =>
  apiFetch(path, { ...opts, timeoutMs: opts.timeoutMs || 15000 }).catch((e) => { throw e; });

export async function adminApi(path, adminKey, { method = 'GET', body } = {}) {
  const res = await fetchWithTimeout(withNgrokBypass(`${apiBase()}${path}`), {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, 15000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  return data;
}

// ---------- Browse (RSS home + Internet Archive) ----------
export const getHome = (refresh = false) => apiFetch(`/api/browse/home${refresh ? '?refresh=1' : ''}`, { timeoutMs: 30000, retries: 2 });
export const getRssItem = (infoHash) => apiFetch(`/api/rss/item/${encodeURIComponent(infoHash)}`, { timeoutMs: 25000, retries: 1 });
export const getRssFeeds = () => apiFetch('/api/rss/feeds', { timeoutMs: 12000, retries: 1 });
export const searchArchive = (q, page = 1) =>
  apiFetch(`/api/browse/search?q=${encodeURIComponent(q)}&page=${page}`, { timeoutMs: 25000, retries: 1 });
export const getArchiveItem = (id) => apiFetch(`/api/browse/item/${encodeURIComponent(id)}`, { timeoutMs: 25000, retries: 1 });
export const getSubtitleProxyUrl = (identifier, file) =>
  `${apiBase()}/api/browse/subtitle?item=${encodeURIComponent(identifier)}&file=${encodeURIComponent(file)}&ngrok-skip-browser-warning=1`;
// Range-capable server proxy for archive.org video — used as the automatic
// fallback when an IA edge node CORS-blocks direct media playback.
export const getArchiveStreamProxyUrl = (identifier, file) =>
  `${apiBase()}/api/browse/stream?item=${encodeURIComponent(identifier)}&file=${encodeURIComponent(file)}&token=${encodeURIComponent(getToken() || '')}&ngrok-skip-browser-warning=1`;

// ---------- Metadata (picture library / TV structure) ----------
export const searchMetadata = (q, type = 'any') =>
  apiFetch(`/api/metadata/search?q=${encodeURIComponent(q)}&type=${type}`, { timeoutMs: 25000 });
export const getShowData = (name, season = null) =>
  apiFetch(`/api/metadata/show?name=${encodeURIComponent(name)}${season ? `&season=${season}` : ''}`, { timeoutMs: 25000 });

// ---------- Pipeline (user magnet library) ----------
export const getLibrary = () => apiFetch('/api/me/library', { timeoutMs: 12000 });
export const addToLibrary = (payload) => apiFetch('/api/me/library', { method: 'POST', body: payload, timeoutMs: 15000 });
export const updateLibraryItem = (id, patch) => apiFetch(`/api/me/library/${id}`, { method: 'PATCH', body: patch });
export const refreshArtwork = (id, body = {}) => apiFetch(`/api/me/library/${id}/artwork`, { method: 'POST', body, timeoutMs: 25000 });
export const removeLibraryItem = (id) => apiFetch(`/api/me/library/${id}`, { method: 'DELETE' });

// ---------- History ----------
export const getHistory = () => apiFetch('/api/me/history', { timeoutMs: 12000 });
export const getHistoryEntry = (key) => apiFetch(`/api/me/history/${encodeURIComponent(key)}`, { timeoutMs: 8000 });
export const saveHistory = (entry) => apiFetch('/api/me/history', { method: 'POST', body: entry });
export const removeHistoryEntry = (key) => apiFetch(`/api/me/history/${encodeURIComponent(key)}`, { method: 'DELETE' });
export const clearAllHistory = (keepInProgress = false) =>
  apiFetch(`/api/me/history${keepInProgress ? '?keepInProgress=1' : ''}`, { method: 'DELETE' });

// ---------- Favorites ----------
export const getFavorites = () => apiFetch('/api/me/favorites', { timeoutMs: 12000 });
export const addFavorite = (entry) => apiFetch('/api/me/favorites', { method: 'POST', body: entry });
export const removeFavorite = (key) => apiFetch(`/api/me/favorites/${encodeURIComponent(key)}`, { method: 'DELETE' });

// ---------- Show tracking ----------
export const getTrackedShows = () => apiFetch('/api/me/shows', { timeoutMs: 12000 });
export const getTrackedShow = (showKey) => apiFetch(`/api/me/shows/${encodeURIComponent(showKey)}`, { timeoutMs: 10000 });
export const setEpisodeWatched = (payload) => apiFetch('/api/me/shows/watched', { method: 'POST', body: payload });

// ---------- Torrent streams (legacy engine) ----------
export const getTorrentDetails = (infoHash) => apiFetch(`/api/torrents/${infoHash}`, { timeoutMs: 10000 });

// Warmup: starts on Play click, re-centers on "go to time". The server loads
// the magnet if the torrent is missing (quit/restart/reap) and buffers ~1
// minute from the requested position before reporting `ready`.
export const startWarmup = (infoHash, { magnet, fileIdx, positionSecs, durationSecs, windowSecs } = {}) =>
  apiFetch(`/api/torrents/${infoHash}/warmup`, {
    method: 'POST',
    body: { magnet, fileIdx, positionSecs, durationSecs, windowSecs },
    timeoutMs: 15000,
  });
export const getWarmupStatus = (infoHash, { fileIdx, positionSecs, durationSecs, windowSecs } = {}) => {
  const q = new URLSearchParams();
  if (fileIdx != null) q.set('fileIdx', String(fileIdx));
  if (positionSecs != null) q.set('positionSecs', String(positionSecs));
  if (durationSecs != null) q.set('durationSecs', String(durationSecs));
  if (windowSecs != null) q.set('windowSecs', String(windowSecs));
  const qs = q.toString();
  return apiFetch(`/api/torrents/${infoHash}/warmup${qs ? `?${qs}` : ''}`, { timeoutMs: 12000 });
};

export const getTorrentStreamUrl = (infoHash, fileIndex) =>
  `${apiBase()}/api/torrents/${infoHash}/files/${fileIndex}/stream?token=${encodeURIComponent(getToken() || '')}&ngrok-skip-browser-warning=1`;

// ---------- Transcode (quality variants from one big source) ----------
export const getTranscodeStatus = () => apiFetch('/api/transcode/status', { timeoutMs: 8000 });
export const getTranscodeUrl = (infoHash, fileIndex, quality, startSecs = 0) => {
  const q = new URLSearchParams({ quality, token: getToken() || '', 'ngrok-skip-browser-warning': '1' });
  if (startSecs > 0.5) q.set('t', String(Math.max(0, startSecs).toFixed(1)));
  return `${apiBase()}/api/torrents/${infoHash}/files/${fileIndex}/transcode?${q.toString()}`;
};
export const getTorrentSubtitleUrl = (infoHash, fileIndex) =>
  `${apiBase()}/api/torrents/${infoHash}/files/${fileIndex}/subtitle?token=${encodeURIComponent(getToken() || '')}&ngrok-skip-browser-warning=1`;

// ---------- Player heartbeat (drives the -5m/+5m buffer window) ----------
export const sendStreamHeartbeat = (infoHash, fileIdx, position, duration) =>
  apiFetch('/api/streams/heartbeat', {
    method: 'POST',
    body: { infoHash, fileIdx, position, duration },
    timeoutMs: 6000,
  }).catch(() => {}); // heartbeats are best-effort

export const getHealth = () => apiFetch('/api/health', { timeoutMs: 5000 });
