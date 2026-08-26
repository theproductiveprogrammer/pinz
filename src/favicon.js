// favicon.js — every pin owns its icon: a per-link file under data/favicons/ named
// l_<id>.<ext>, referenced from the link's YAML as `icon`. Site icons are only a
// cache (favicons/<host>.<ext>) that a search copies from.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from './store.js';

const MAX_BYTES = 512 * 1024;
const TYPES = {
  'image/png': 'png', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
};
const EXTS = new Set(Object.values(TYPES));

// Public hostnames only — no ports, IPs, or localhost — are ever fetched by the
// server, so a request can't point it at itself or the droplet's private network.
const HOST_RE = /^(?=.{1,253}$)(?!localhost$)([a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i;
const fetchable = h => HOST_RE.test(String(h ?? ''));

// The site-cache key for a link: hostname, plus "_port" so local dev apps on
// different ports (localhost_7942) stay apart.
export function iconKey(link) {
  try {
    const u = new URL(link);
    return (u.port ? `${u.hostname}_${u.port}` : u.hostname).toLowerCase();
  } catch { return ''; }
}
// A per-link icon key: "l_" + 12 hex.
const LINK_RE = /^l_[0-9a-f]{12}$/;
export const isLinkKey = k => LINK_RE.test(String(k ?? ''));
// A host key is a safe filename stem: hostname characters plus an optional _port.
const HOSTKEY_RE = /^(?=.{1,260}$)[a-z0-9](?:[a-z0-9-]*\.)*[a-z0-9-]+(?:_\d{1,5})?$/i;
export function validKey(k) { return isLinkKey(k) || HOSTKEY_RE.test(String(k ?? '')); }
// What the pin dialog may store in the icon field: nothing, "none", or a link key.
export const validIconField = v => v === '' || v === 'none' || isLinkKey(v);

const dir = () => path.join(getDataDir(), 'favicons');
const versionOf = st => Math.round(st.mtimeMs).toString(36);

// The cached file for a key, if any — extension unknown until found.
export async function iconFile(key) {
  for (const ext of EXTS) {
    const f = path.join(dir(), `${key}.${ext}`);
    try { await fsp.access(f); return f; } catch { /* next */ }
  }
  return null;
}

// A miss is remembered too (empty .none file), so a site with no icon isn't
// re-fetched on every search; it's retried after a week.
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

// Downloads one candidate image to <key>.<ext>; null if it isn't a usable image.
async function download(key, url) {
  try {
    const res = await fetchWithin(url, 4000, { accept: 'image/*' });
    const ext = TYPES[(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()];
    if (!res.ok || !ext) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    await fsp.mkdir(dir(), { recursive: true });
    const file = path.join(dir(), `${key}.${ext}`);
    await fsp.writeFile(file, buf);
    return file;
  } catch { return null; }
}

// The problem is a site's icon is what makes a link recognisable, and it shouldn't
// be fetched once per link. The way we solve this is a per-host cache — the page's
// declared icon, else /favicon.ico — that link searches copy from; misses are
// remembered so absent icons cost nothing next time. Returns a file path or null.
// flow: icon search -> resolveLinkIcon -> siteIcon() <-- HERE
export async function siteIcon(host, { fresh = false } = {}) {
  if (!HOSTKEY_RE.test(host)) return null;
  host = host.toLowerCase();
  if (fresh) for (const ext of [...EXTS, 'none']) await fsp.rm(path.join(dir(), `${host}.${ext}`), { force: true });
  const hit = await iconFile(host);
  if (hit) return hit;
  // local / IP / port hosts are never fetched — only a file or paste can give them an icon
  if (!fetchable(host) || await recentMiss(host)) return null;
  await fsp.mkdir(dir(), { recursive: true });
  const candidates = [await declaredIcon(host), `https://${host}/favicon.ico`].filter(Boolean);
  for (const url of candidates) {
    const file = await download(host, url);
    if (file) return file;
  }
  await fsp.writeFile(missFile(host), '');
  return null;
}

const newKey = () => `l_${crypto.randomBytes(6).toString('hex')}`;
const result = async file => ({ icon: path.basename(file).split('.')[0], v: versionOf(await fsp.stat(file)) });

// Copies any icon file into a brand-new per-link file — links never share a file.
async function copyToLink(src) {
  await fsp.mkdir(dir(), { recursive: true });
  const file = path.join(dir(), `${newKey()}${path.extname(src)}`);
  await fsp.copyFile(src, file);
  return result(file);
}

// The problem is a new pin should get an icon without the user doing anything. The
// way we solve this is a two-step search: the site's icon (cached per host), else
// the icon of another pin on the same site — either one copied into this link's
// own file. Returns {icon, v} or null when nothing was found.
// flow: pin dialog URL typed / ↻ refetch -> POST /favicon refetch -> resolveLinkIcon() <-- HERE
// flow: terminal `pinz-admin icons` -> cmdIcons -> resolveLinkIcon() <-- HERE
export async function resolveLinkIcon(link, doc, { fresh = false } = {}) {
  const host = iconKey(link);
  if (!host) return null;
  const site = await siteIcon(host, { fresh });
  if (site) return copyToLink(site);
  for (const l of doc?.links ?? []) {
    if (l.link === link || !isLinkKey(l.icon) || iconKey(l.link) !== host) continue;
    const f = await iconFile(l.icon);
    if (f) return copyToLink(f);
  }
  return null;
}

// The problem is the search can come up empty or wrong (a bot wall, a per-document
// icon on SharePoint), and the user can usually get the image themselves. The way we
// solve this is two more ways in: an image URL the server downloads (public hosts
// only — a localhost URL would point at the droplet), or bytes the browser already
// has (file picker, paste, CORS-readable URL). Both land in a new per-link file.
// flow: edit dialog "from URL" -> POST /favicon set -> linkIconFromUrl() <-- HERE
export async function linkIconFromUrl(url) {
  try {
    const u = new URL(url);
    if (!fetchable(u.hostname)) return null;
    const file = await download(newKey(), u.href);
    return file ? result(file) : null;
  } catch { return null; }
}
// flow: edit dialog "from file" / paste -> POST /favicon/upload -> linkIconFromBytes() <-- HERE
export async function linkIconFromBytes(buf, contentType) {
  const ext = TYPES[String(contentType ?? '').split(';')[0].trim().toLowerCase()];
  if (!ext || !buf?.length || buf.length > MAX_BYTES) return null;
  await fsp.mkdir(dir(), { recursive: true });
  const file = path.join(dir(), `${newKey()}.${ext}`);
  await fsp.writeFile(file, buf);
  return result(file);
}

// Deletes a per-link icon file (a replaced icon, a deleted pin, a cancelled dialog).
export async function removeLinkIcon(key) {
  if (!isLinkKey(key)) return;
  for (const ext of EXTS) await fsp.rm(path.join(dir(), `${key}.${ext}`), { force: true });
}

// The problem is icon URLs are cached by the browser for a year, so a replaced icon
// would never show. The way we solve this is one directory read per page render:
// key → version (file mtime), stamped into each link's icon URL.
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
