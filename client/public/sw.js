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
  const url = new URL(req.url);

  // Never intercept API, stream, subtitle, or range/media requests — always live direct to server.
  // These must bypass Netlify and go straight to the engine (apiBase).
  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.searchParams.has('token') && url.pathname.includes('/files/')) return; // torrent stream URLs carry token
  if (url.searchParams.has('ngrok-skip-browser-warning')) {
    // Still let API through, but for media we already returned above via /api/ check.
    // For navigation we continue.
    if (url.pathname.startsWith('/api/')) return;
  }
  if (/\.(mp4|m4v|webm|mkv|ts|srt|vtt|mp3|aac)$/i.test(url.pathname)) return;
  // Don't cache Range requests (video scrubbing)
  if (req.headers.has('Range')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache successful navigations/app-shell responses for offline fallback
        if (res.ok && (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html')) {
          const clone = res.clone();
          caches.open('heiken-shell-v1').then((c) => c.put('/index.html', clone)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        // For navigation (page reload, deep link), always return the app shell
        // instead of Response.error() which causes "FetchEvent resulted in network error".
        if (req.mode === 'navigate') {
          const cached = await caches.match('/index.html');
          if (cached) return cached;
          // As last resort, try network again for index.html
          try {
            const shell = await fetch('/index.html');
            return shell;
          } catch {
            // Return a minimal offline page rather than error response
            return new Response('<html><body style="background:#0b0d12;color:#f2f4f8;font-family:sans-serif;display:grid;place-items:center;height:100vh"><div><h2>Offline</h2><p>Engine unreachable. Check server address in login screen.</p></div></body></html>', {
              headers: { 'Content-Type': 'text/html' },
              status: 200
            });
          }
        }
        const hit = await caches.match(req);
        if (hit) return hit;
        // For non-navigate, just fail silently rather than Response.error() which triggers ORB-style logs
        return fetch(req).catch(() => new Response('', { status: 504, statusText: 'Offline' }));
      })
  );
});
