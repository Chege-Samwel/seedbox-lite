/**
 * Central API client — token-aware fetch helpers for every backend module.
 */
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const TOKEN_KEY = 'sb_session_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

async function apiFetch(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchWithTimeout(
    `${API_BASE}${path}`,
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
  return data;
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
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, 15000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  return data;
}

// ---------- Browse (Internet Archive) ----------
export const getHome = () => apiFetch('/api/browse/home', { timeoutMs: 25000 });
export const searchArchive = (q, page = 1) =>
  apiFetch(`/api/browse/search?q=${encodeURIComponent(q)}&page=${page}`, { timeoutMs: 25000 });
export const getArchiveItem = (id) => apiFetch(`/api/browse/item/${encodeURIComponent(id)}`, { timeoutMs: 25000 });
export const getSubtitleProxyUrl = (identifier, file) =>
  `${API_BASE}/api/browse/subtitle?item=${encodeURIComponent(identifier)}&file=${encodeURIComponent(file)}`;

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

// ---------- Show tracking ----------
export const getTrackedShows = () => apiFetch('/api/me/shows', { timeoutMs: 12000 });
export const getTrackedShow = (showKey) => apiFetch(`/api/me/shows/${encodeURIComponent(showKey)}`, { timeoutMs: 10000 });
export const setEpisodeWatched = (payload) => apiFetch('/api/me/shows/watched', { method: 'POST', body: payload });

// ---------- Torrent streams (legacy engine) ----------
export const getTorrentDetails = (infoHash) => apiFetch(`/api/torrents/${infoHash}`, { timeoutMs: 10000 });
export const getTorrentStreamUrl = (infoHash, fileIndex) =>
  `${API_BASE}/api/torrents/${infoHash}/files/${fileIndex}/stream?token=${encodeURIComponent(getToken() || '')}`;
export const getTorrentSubtitleUrl = (infoHash, fileIndex) =>
  `${API_BASE}/api/torrents/${infoHash}/files/${fileIndex}/subtitle?token=${encodeURIComponent(getToken() || '')}`;

// ---------- Player heartbeat (drives the -5m/+5m buffer window) ----------
export const sendStreamHeartbeat = (infoHash, fileIdx, position, duration) =>
  apiFetch('/api/streams/heartbeat', {
    method: 'POST',
    body: { infoHash, fileIdx, position, duration },
    timeoutMs: 6000,
  }).catch(() => {}); // heartbeats are best-effort

export const getHealth = () => apiFetch('/api/health', { timeoutMs: 5000 });
