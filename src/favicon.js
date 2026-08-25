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
  if (await recentMiss(host)) return null;
  await fsp.mkdir(dir(), { recursive: true });
  const candidates = [await declaredIcon(host), `https://${host}/favicon.ico`].filter(Boolean);
  for (const url of candidates) {
    try {
      const res = await fetchWithin(url, 4000, { accept: 'image/*' });
      const ext = TYPES[(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()];
      if (!res.ok || !ext) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) continue;
      const file = path.join(dir(), `${host}.${ext}`);
      await fsp.writeFile(file, buf);
      return file;
    } catch { /* try the next candidate */ }
  }
  await fsp.writeFile(missFile(host), '');
  return null;
}
