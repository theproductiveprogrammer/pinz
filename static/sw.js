// sw.js — service worker: the start page paints from cache instantly, then the
// network copy replaces it in place. Only "/" is cached here; the font and picture
// carry versioned URLs and live in the ordinary browser cache for a year.

const CACHE = 'pinz-page';
const PAGE = '/';

// Set by a same-origin POST (add/edit/delete/logout…): the very next visit to "/"
// must show the result, so it goes network-first instead of cache-first.
let freshNext = false;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// The masthead clock is server-rendered, so two otherwise identical pages never
// match byte-for-byte. Compare with it blanked out.
const strip = html => html.replace(/<time id="clock">.*?<\/time>/s, '');

// Ask the tab being loaded to do something (swap in fresh HTML, or leave for /login).
// Understand: the fresh fetch can finish before the tab exists as a client — the
// navigation hasn't committed yet — so the lookup retries for a couple of seconds.
async function tell(clientId, msg) {
  for (let i = 0; i < 20; i++) {
    const c = clientId && await self.clients.get(clientId);
    if (c) return c.postMessage(msg);
    await new Promise(r => setTimeout(r, 100));
  }
}

// The problem is a session that expired (or a logout) must not keep showing a
// cached page that can't be acted on. The way we solve this is treating a
// redirect from "/" as the end of the cache: drop it and send tabs to login.
// Understand: with redirect "manual" (what navigations use too) the 302 to /login
// arrives as an opaqueredirect (status 0), not as a followed, redirected response.
// A fresh Request is built rather than reusing the navigation's own — once the
// navigation has been answered from cache, refetching its Request object fails.
const usable = res => res.ok && !res.redirected;
async function fetchPage(clientId) {
  const res = await fetch(PAGE, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
  if (!usable(res)) {
    await (await caches.open(CACHE)).delete(PAGE);
    if (res.redirected || res.type === 'opaqueredirect') tell(clientId, { type: 'expired' });
  }
  return res;
}

// The problem is the page must feel instant from anywhere, but must also be right.
// The way we solve this is cache-first for "/": respond from cache, fetch in the
// background, and if the fresh page differs, store it and tell the tab to swap.
// flow: new tab -> GET / -> sw fetch handler -> pageResponse() <-- HERE -> app.js refresh
async function pageResponse(clientId) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(PAGE);
  if (!cached || freshNext) {
    freshNext = false;
    const res = await fetchPage(clientId).catch(() => null);
    if (res && usable(res)) { await cache.put(PAGE, res.clone()); return res; }
    return res ?? cached ?? Response.error();
  }
  // background revalidate; the response below goes out immediately. Clone now:
  // once `cached` is handed to the navigation its body is spent and can't be read.
  const spare = cached.clone();
  fetchPage(clientId).then(async res => {
    if (!usable(res)) return;
    const fresh = await res.clone().text();
    const old = await spare.text();
    await cache.put(PAGE, res);
    if (strip(fresh) !== strip(old)) tell(clientId, { type: 'refresh', html: fresh });
  }).catch(() => { /* offline: the cached page stands */ });
  return cached;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') {
    // any write may change the page; the redirect that follows must not show stale data
    freshNext = true;
    if (url.pathname === '/logout') e.waitUntil(caches.open(CACHE).then(c => c.delete(PAGE)));
    return;
  }
  // only the bare page — "/?dup=1" style notices go straight to the network
  if (e.request.mode === 'navigate' && url.pathname === PAGE && !url.search) {
    e.respondWith(pageResponse(e.resultingClientId));
  }
});
