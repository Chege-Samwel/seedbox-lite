/* Heiken service worker.
 *
 * Purpose: make Heiken installable (Chrome fires the "Add to Home screen"
 * / install prompt only when a service worker controls the page) and keep
 * the app shell snappy. This deliberately does NOT cache API responses or
 * video streams — those are long-lived/range-based and must always hit the
 * live server (and the server address can change per device).
 *
 * Strategy: network-first for everything. On failure, fall back to a
 * cached copy of the app shell so the UI can still render (and show its
 * offline state) when the tunnel is briefly unreachable.
 */
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('heiken-shell-v1').then((c) => c.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== 'heiken-shell-v1').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Never intercept API, stream, subtitle or image requests — always live.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;
  if (/\.(mp4|m4v|webm|mkv|ts|srt|vtt)$/i.test(url.pathname)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache successful navigations/app-shell responses for offline fallback
        if (res.ok && (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html')) {
          const clone = res.clone();
          caches.open('heiken-shell-v1').then((c) => c.put(url.pathname, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
      )
  );
});
