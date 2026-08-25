// app.js — Express wiring: routes, auth, and the friendly-error boundary.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAuth, handleLogin, handleLogout } from './auth.js';
import fsp from 'node:fs/promises';
import { loadUserDoc, addLink, editLink, addFilePin, deletePin, groupByTag, getDataDir, normalizeTag, mutateUserDoc, NoUserFileError } from './store.js';
import { homePage, loginPage, errorPage } from './render.js';
import { fetchTitle } from './title.js';
import { webPicture, pictureVersion } from './image.js';
import { siteIcon, editIcon, storeIcon, iconVersions, iconKey, validKey } from './favicon.js';

// The picture path comes from a hand-editable YAML, so it's only trusted once
// resolved and proven to sit inside the data dir. Returns null for none/unsafe.
function localPicture(doc) {
  const pic = String(doc.info.picture ?? '');
  if (!pic || /^https?:\/\//.test(pic)) return null;
  const file = path.resolve(getDataDir(), pic);
  return file.startsWith(getDataDir() + path.sep) ? file : null;
}

// Express 4 doesn't catch async handler rejections; route everything through here.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Only http(s) links may be pinned — anything else (javascript:, file:, garbage) is refused.
function parseHttpUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch { return null; }
}

// A stored-file path is only trusted if it's the plain "files/<user>/<name>" shape —
// no separators in the name, so no traversal, and never another user's directory.
function ownFilePath(user, rel) {
  const m = /^files\/([^/]+)\/([^/]+)$/.exec(String(rel ?? ''));
  return m && m[1] === user && m[2] !== '.' && m[2] !== '..' ? rel : null;
}

// Extensions safe to render in the browser; everything else (svg and html included —
// they can carry scripts into the logged-in origin) downloads instead.
const INLINE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'pdf', 'txt']);

// flow: server start — server.js -> createApp() <-- HERE
export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../static');
  // Every /static URL carries ?v=<boot time> (see render.js), so what's cached can never
  // go stale — let the browser keep it for a year and skip even the revalidation trip.
  app.use('/static', express.static(staticDir, { maxAge: '1y', immutable: true }));
  // The service worker must be served from the root to control "/" — and never cached,
  // so a deploy's new worker is picked up on the next visit.
  // flow: main screen loads -> static/app.js registers -> GET /sw.js <-- HERE
  app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(staticDir, 'sw.js'));
  });
  app.use(express.urlencoded({ extended: false }));

  app.get('/login', (req, res) => res.send(loginPage()));
  app.post('/login', wrap(handleLogin));
  app.post('/logout', requireAuth, handleLogout);

  // The main (only) screen: everything the user sees, grouped and ordered.
  // flow: main screen — GET / <-- HERE -> loadUserDoc -> groupByTag -> homePage
  app.get('/', wrap(requireAuth), wrap(async (req, res) => {
    const doc = await loadUserDoc(req.user);
    const notice = ['dup', 'restored', 'missing'].find(n => n in req.query) ?? '';
    const local = localPicture(doc);
    const imgV = local ? await pictureVersion(local) : '';
    res.send(homePage({ username: req.user, doc, groups: groupByTag(doc), notice, imgV, icons: await iconVersions() }));
  }));

  // Shared by /add and /edit: the validated fields of the pin dialog.
  // Tags split on commas AND whitespace — "atlas dev" is two tags, not one
  // tag with a space in it (tags are hashtag-shaped, never multi-word).
  function pinFields(body) {
    const url = parseHttpUrl(body?.link);
    return url && {
      link: url.href,
      title: String(body?.title ?? '').trim(),
      tags: String(body?.tags ?? '').split(/[\s,]+/).map(normalizeTag).filter(Boolean),
    };
  }

  // flow: pin dialog (new link or uploaded file) -> POST /add <-- HERE -> addLink | addFilePin
  app.post('/add', wrap(requireAuth), wrap(async (req, res) => {
    const file = ownFilePath(req.user, req.body?.file);
    if (file) {
      try { await fsp.access(path.join(getDataDir(), file)); }
      catch { return res.status(400).send(errorPage('That upload is gone — drop the file again.')); }
      const title = String(req.body?.title ?? '').trim();
      const tags = String(req.body?.tags ?? '').split(/[\s,]+/).map(normalizeTag).filter(Boolean);
      await addFilePin(req.user, { file, title, tags });
      return res.redirect(303, '/');
    }
    const fields = pinFields(req.body);
    if (!fields) return res.status(400).send(errorPage('Only http(s) URLs can be pinned.'));
    const result = await addLink(req.user, fields);
    // warm the icon cache now so the review card never waits on it; never awaited
    siteIcon(iconKey(fields.link)).catch(() => {});
    res.redirect(303, result === 'ok' ? '/' : `/?${result === 'duplicate' ? 'dup' : 'restored'}=1`);
  }));

  // The problem is fixing a pin's fields and completing/restoring it are one dialog
  // to the user. The way we solve this is one endpoint keyed by the pin's identity
  // (URL, or stored path for files), where the pressed button (action) decides what
  // happens to the done flag. File pins never change their file here.
  // flow: pin dialog (editing) -> POST /edit <-- HERE -> editLink -> redirect /
  app.post('/edit', wrap(requireAuth), wrap(async (req, res) => {
    const isFile = !!ownFilePath(req.user, req.body?.file);
    const fields = isFile
      ? {
          title: String(req.body?.title ?? '').trim(),
          tags: String(req.body?.tags ?? '').split(/[\s,]+/).map(normalizeTag).filter(Boolean),
        }
      : pinFields(req.body);
    if (!fields) return res.status(400).send(errorPage('Only http(s) URLs can be pinned.'));
    const action = String(req.body?.action ?? 'save');
    const done = action === 'done' ? true : action === 'restore' ? false : undefined;
    const result = await editLink(req.user, String(req.body?.orig ?? ''), { ...fields, done });
    res.redirect(303, result === 'ok' ? '/' : `/?${result === 'duplicate' ? 'dup' : 'missing'}=1`);
  }));

  // The problem is dropped documents need somewhere to live before they're pinned.
  // The way we solve this is streaming the raw body (25MB cap) into the user's own
  // files/ directory under a timestamped, sanitized name, returning the stored path
  // for the pin dialog to submit.
  // flow: file dropped on the page -> static/app.js -> POST /upload <-- HERE -> pin dialog
  app.post('/upload', wrap(requireAuth), express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
    const original = String(req.query.name ?? 'file').slice(0, 120);
    const safe = original.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'file';
    const rel = `files/${req.user}/${Date.now()}-${safe}`;
    const abs = path.join(getDataDir(), rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, req.body);
    res.json({ file: rel, title: original });
  }));

  // The problem is pinned documents are as private as the bookmarks. The way we solve
  // this is serving a file only when it appears in the logged-in user's own YAML,
  // inline for browser-safe types and as a download for everything else (svg/html
  // could carry scripts into this origin).
  // flow: file pin clicked -> GET /file/* <-- HERE
  app.get('/file/*', wrap(requireAuth), wrap(async (req, res) => {
    const rel = ownFilePath(req.user, decodeURIComponent(req.params[0] ?? ''));
    if (!rel) return res.status(400).end();
    const doc = await loadUserDoc(req.user);
    const entry = doc.links.find(l => l.file === rel);
    if (!entry) return res.status(404).end();
    const abs = path.join(getDataDir(), rel);
    const name = rel.split('/').pop().replace(/^\d+-/, '');
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (INLINE_EXT.has(ext)) {
      res.sendFile(abs, err => { if (err && !res.headersSent) res.status(404).end(); });
    } else {
      res.download(abs, name, err => { if (err && !res.headersSent) res.status(404).end(); });
    }
  }));

  // flow: edit dialog "✕ delete" (or a cancelled upload) -> POST /delete <-- HERE -> deletePin
  app.post('/delete', wrap(requireAuth), wrap(async (req, res) => {
    const key = String(req.body?.key ?? '');
    if (!key) return res.status(400).end();
    await deletePin(req.user, key);
    // orphans (uploaded but never pinned) have no entry — remove the file itself too
    const rel = ownFilePath(req.user, key);
    if (rel) await fsp.unlink(path.join(getDataDir(), rel)).catch(() => {});
    res.status(204).end();
  }));

  // The problem is placing the photo by typing "X% Y%" numbers is guesswork; dragging
  // it is the honest interface. The way we solve this is letting the client persist
  // the dropped position/size here, validated exactly like the CLI's image position.
  // flow: user drags the photo, drops it -> static/app.js -> POST /image-position <-- HERE
  app.post('/image-position', wrap(requireAuth), wrap(async (req, res) => {
    const LEN = /^\d+(\.\d+)?(%|px|rem|em|vw|vh)$/;
    const tokens = String(req.body?.pos ?? '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 4 || !tokens.every(t => LEN.test(t))) return res.status(400).end();
    await mutateUserDoc(req.user, doc => { doc.info.picture_position = tokens.join(' '); });
    res.status(204).end();
  }));

  // The problem is the profile picture lives under data/, which is private, and the
  // original is far too big to ship. The way we solve this is streaming only the
  // logged-in user's own picture, as its resized webp derivative, and — when the page
  // asked for it by version — telling the browser to keep it for a year.
  // flow: main screen <img src="/img?v=…"> -> GET /img <-- HERE -> webPicture
  app.get('/img', wrap(requireAuth), wrap(async (req, res) => {
    const doc = await loadUserDoc(req.user);
    const pic = String(doc.info.picture ?? '');
    if (!pic) return res.status(404).end();
    if (/^https?:\/\//.test(pic)) return res.redirect(pic);
    const file = localPicture(doc);
    if (!file) return res.status(400).end();
    let out;
    try { out = await webPicture(file); }
    catch (e) { console.error('picture derivative failed, serving original:', e.message); out = file; }
    // versioned URLs change when the picture does, so they can be cached forever
    res.setHeader('Cache-Control', req.query.v ? 'private, max-age=31536000, immutable' : 'private, max-age=3600');
    res.sendFile(out, err => { if (err && !res.headersSent) res.status(404).end(); });
  }));

  // The problem is a site icon is shared by every link on that domain and never
  // changes in practice. The way we solve this is one route keyed by hostname that
  // serves the cached file (fetching it the first time) with a month of browser
  // cache; a miss is a 404 the card quietly hides.
  // flow: review card <img src="/favicon/<host>"> -> GET /favicon/:host <-- HERE -> siteIcon
  app.get('/favicon/:host', wrap(requireAuth), wrap(async (req, res) => {
    if (!validKey(req.params.host)) return res.status(400).end();
    const file = await siteIcon(req.params.host);
    // a miss is cached a day too, so the card doesn't re-ask for icons that don't exist
    if (!file) { res.setHeader('Cache-Control', 'private, max-age=86400'); return res.status(404).end(); }
    // versioned URLs (from the page) change whenever the icon does: cache them for good
    res.setHeader('Cache-Control', req.query.v ? 'private, max-age=31536000, immutable' : 'private, max-age=2592000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // an svg icon is a document if opened directly; sandboxed, it can't run anything
    if (file.endsWith('.svg')) res.setHeader('Content-Security-Policy', "sandbox; script-src 'none'");
    res.sendFile(file, err => { if (err && !res.headersSent) res.status(404).end(); });
  }));

  // flow: edit dialog icon row (refetch / set URL / remove) -> POST /favicon <-- HERE -> editIcon
  app.post('/favicon', wrap(requireAuth), wrap(async (req, res) => {
    const host = String(req.body?.host ?? '');
    const action = String(req.body?.action ?? '');
    if (!validKey(host) || !['refetch', 'set', 'remove'].includes(action)) return res.status(400).end();
    const v = await editIcon(host, action, String(req.body?.url ?? ''));
    if (v === null) return res.status(400).end();
    res.json({ v });
  }));

  // flow: edit dialog icon row "from file" / paste / CORS-readable URL -> POST /favicon/upload <-- HERE -> storeIcon
  app.post('/favicon/upload', wrap(requireAuth), express.raw({ type: () => true, limit: '512kb' }), wrap(async (req, res) => {
    const host = String(req.query.host ?? '');
    if (!validKey(host)) return res.status(400).end();
    const v = await storeIcon(host, req.body, req.headers['content-type']);
    if (v === null) return res.status(400).end();
    res.json({ v });
  }));

  // flow: add form title blank -> static/app.js fetch -> GET /title <-- HERE -> fetchTitle
  app.get('/title', wrap(requireAuth), wrap(async (req, res) => {
    const url = parseHttpUrl(req.query.url);
    res.json({ title: url ? await fetchTitle(url.href) : null });
  }));

  // The problem is data-file trouble (bad YAML, missing file) must read as a clear
  // message, never a stack trace. The way we solve this is mapping known error types
  // to a friendly page and logging the rest.
  // flow: any thrown handler error -> errorBoundary() <-- HERE
  // eslint-disable-next-line no-unused-vars
  app.use(function errorBoundary(err, req, res, next) {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'file too large — 25MB max' });
    if (err instanceof NoUserFileError) return res.status(500).send(errorPage(err.message));
    if (err?.name === 'YAMLException') {
      return res.status(500).send(errorPage(`Your data file has a problem: ${err.reason ?? err.message}${err.mark ? ` (line ${err.mark.line + 1})` : ''}`));
    }
    console.error(err);
    res.status(500).send(errorPage('Something went wrong.'));
  });

  return app;
}
