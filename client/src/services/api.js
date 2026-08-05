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
const withNgrokBypass = (url) => `${url}${url.includes('?') ? '&' : '?'}ngrok-skip-browser-warning=1`;
const TOKEN_KEY = 'sb_session_token';
const CONSENT_KEY = 'sb_consent'; // 'granted' | 'denied'

  for (;;) {
    try {
      const res = await fetchWithTimeout(
        withNgrokBypass(`${apiBase()}${path}`),
        { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
        timeoutMs
      );
      if (!err.status && apiBase() !== '' && window.location?.origin && !window.location.origin.startsWith(apiBase())) {
        try {
          const res2 = await fetchWithTimeout(
            withNgrokBypass(`${window.location.origin}${path}`),
            { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
            timeoutMs
          );
  apiFetch(path, { ...opts, timeoutMs: opts.timeoutMs || 15000 }).catch((e) => { throw e; });

export async function adminApi(path, adminKey, { method = 'GET', body } = {}) {
  const res = await fetchWithTimeout(withNgrokBypass(`${apiBase()}${path}`), {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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