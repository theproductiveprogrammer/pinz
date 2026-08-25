// favicon.js — one cached site icon per domain under data/favicons/.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from './store.js';

const MAX_BYTES = 512 * 1024;
const TYPES = {
  'image/png': 'png', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
};
const EXTS = new Set(Object.values(TYPES));

// Hostnames only — no ports, IPs, or localhost — so a request can't point the
// server at itself or at the droplet's private network.
const HOST_RE = /^(?=.{1,253}$)(?!localhost$)([a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i;
export function validHost(h) { return HOST_RE.test(String(h ?? '')); }

const dir = () => path.join(getDataDir(), 'favicons');

// The cached file for a host, if any — extension unknown until found.
async function cached(host) {
  for (const ext of EXTS) {
    const f = path.join(dir(), `${host}.${ext}`);
    try { await fsp.access(f); return f; } catch { /* next */ }
  }
  return null;
}

// A miss is remembered too (empty .none file), so a site with no icon isn't
// re-fetched on every review; it's retried after a week.
const missFile = host => path.join(dir(), `${host}.none`);
async function recentMiss(host) {
  const st = await fsp.stat(missFile(host)).catch(() => null);
  return st && Date.now() - st.mtimeMs < 7 * 86400000;
}

async function fetchWithin(url, ms, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers }); }
  finally { clearTimeout(timer); }
}

// Reads the page's <link rel="icon"> (or apple-touch-icon) from its first 256KB.
async function declaredIcon(host) {
  try {
    const res = await fetchWithin(`https://${host}/`, 4000, { accept: 'text/html' });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = '';
    while (html.length < 262144) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const links = html.match(/<link\b[^>]*>/gi) ?? [];
    const pick = want => links.find(l => new RegExp(`rel=["']?[^"'>]*\\b${want}\\b`, 'i').test(l));
    const tag = pick('icon') ?? pick('apple-touch-icon');
    const href = tag?.match(/href=["']?([^"'\s>]+)/i)?.[1];
    return href ? new URL(href, res.url).href : null;
  } catch { return null; }
}

// The user said "no icon for this site": permanent until they refetch or set one.
const offFile = host => path.join(dir(), `${host}.off`);

// Downloads one candidate image into the cache; null if it isn't a usable image.
async function download(host, url) {
  try {
    const res = await fetchWithin(url, 4000, { accept: 'image/*' });
    const ext = TYPES[(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()];
    if (!res.ok || !ext) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    const file = path.join(dir(), `${host}.${ext}`);
    await fsp.writeFile(file, buf);
    return file;
  } catch { return null; }
}

// The problem is a review card shows a bare domain, and a site's icon is what makes
// it recognisable at a glance. The way we solve this is fetching the icon once per
// domain — the page's declared one, else /favicon.ico — into data/favicons/, and
// remembering misses so absent icons cost nothing next time. Returns a file path or null.
// flow: review card <img src="/favicon/<host>"> -> GET /favicon/:host -> siteIcon() <-- HERE
// flow: pin dialog -> POST /add -> siteIcon() (prefetch, not awaited) <-- HERE
export async function siteIcon(host) {
  if (!validHost(host)) return null;
  host = host.toLowerCase();
  const hit = await cached(host);
  if (hit) return hit;
  if (await recentMiss(host) || await fsp.access(offFile(host)).then(() => true, () => false)) return null;
  await fsp.mkdir(dir(), { recursive: true });
  const candidates = [await declaredIcon(host), `https://${host}/favicon.ico`].filter(Boolean);
  for (const url of candidates) {
    const file = await download(host, url);
    if (file) return file;
  }
  await fsp.writeFile(missFile(host), '');
  return null;
}

// Forget everything cached about a host: icon, miss marker, and "off" marker.
async function clearIcon(host) {
  for (const ext of [...EXTS, 'none', 'off']) await fsp.rm(path.join(dir(), `${host}.${ext}`), { force: true });
}

// The problem is the automatic fetch can be wrong or blocked (a bot wall, a stale
// icon), and some sites the user simply wants blank. The way we solve this is three
// explicit verbs from the edit dialog: refetch from scratch, set from an image URL
// the user found, or remove (and stop trying). Returns the new version, '' if none.
// flow: edit dialog icon row -> POST /favicon -> editIcon() <-- HERE
export async function editIcon(host, action, url) {
  if (!validHost(host)) return null;
  host = host.toLowerCase();
  await fsp.mkdir(dir(), { recursive: true });
  await clearIcon(host);
  let file = null;
  if (action === 'refetch') file = await siteIcon(host);
  else if (action === 'set') { try { file = await download(host, new URL(url).href); } catch { file = null; } }
  else if (action === 'remove') await fsp.writeFile(offFile(host), '');
  else return null;
  return file ? versionOf(await fsp.stat(file)) : '';
}

const versionOf = st => Math.round(st.mtimeMs).toString(36);

// The problem is icon URLs are cached by the browser for a month, so a replaced icon
// would never show — and the page shouldn't probe for icons that don't exist. The way
// we solve this is one directory read per page render: host → version (file mtime),
// stamped into each link's URL and data attributes.
// flow: GET / -> homepage handler -> iconVersions() <-- HERE -> homePage
export async function iconVersions() {
  const map = new Map();
  for (const name of await fsp.readdir(dir()).catch(() => [])) {
    const i = name.lastIndexOf('.');
    if (i < 1 || !EXTS.has(name.slice(i + 1))) continue;
    const st = await fsp.stat(path.join(dir(), name)).catch(() => null);
    if (st) map.set(name.slice(0, i), versionOf(st));
  }
  return map;
}
