// app.js — Express wiring: routes, auth, and the friendly-error boundary.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAuth, handleLogin, handleLogout } from './auth.js';
import { loadUserDoc, addLink, editLink, groupByTag, getDataDir, normalizeTag, mutateUserDoc, NoUserFileError } from './store.js';
import { homePage, loginPage, errorPage } from './render.js';
import { fetchTitle } from './title.js';

// Express 4 doesn't catch async handler rejections; route everything through here.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Only http(s) links may be pinned — anything else (javascript:, file:, garbage) is refused.
function parseHttpUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch { return null; }
}

// flow: server start — server.js -> createApp() <-- HERE
export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use('/static', express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../static'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/login', (req, res) => res.send(loginPage()));
  app.post('/login', wrap(handleLogin));
  app.post('/logout', requireAuth, handleLogout);

  // The main (only) screen: everything the user sees, grouped and ordered.
  // flow: main screen — GET / <-- HERE -> loadUserDoc -> groupByTag -> homePage
  app.get('/', wrap(requireAuth), wrap(async (req, res) => {
    const doc = await loadUserDoc(req.user);
    const notice = ['dup', 'restored', 'missing'].find(n => n in req.query) ?? '';
    res.send(homePage({ username: req.user, doc, groups: groupByTag(doc), notice }));
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

  // flow: pin dialog (new link) -> POST /add <-- HERE -> addLink -> redirect /
  app.post('/add', wrap(requireAuth), wrap(async (req, res) => {
    const fields = pinFields(req.body);
    if (!fields) return res.status(400).send(errorPage('Only http(s) URLs can be pinned.'));
    const result = await addLink(req.user, fields);
    res.redirect(303, result === 'ok' ? '/' : `/?${result === 'duplicate' ? 'dup' : 'restored'}=1`);
  }));

  // The problem is fixing a link's fields and completing/restoring it are one dialog
  // to the user. The way we solve this is one endpoint keyed by the link's original
  // URL, where the pressed button (action) decides what happens to the done flag.
  // flow: pin dialog (editing) -> POST /edit <-- HERE -> editLink -> redirect /
  app.post('/edit', wrap(requireAuth), wrap(async (req, res) => {
    const fields = pinFields(req.body);
    if (!fields) return res.status(400).send(errorPage('Only http(s) URLs can be pinned.'));
    const action = String(req.body?.action ?? 'save');
    const done = action === 'done' ? true : action === 'restore' ? false : undefined;
    const result = await editLink(req.user, String(req.body?.orig ?? ''), { ...fields, done });
    res.redirect(303, result === 'ok' ? '/' : `/?${result === 'duplicate' ? 'dup' : 'missing'}=1`);
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

  // The problem is the profile picture lives under data/, which is private. The way we
  // solve this is streaming only the logged-in user's own picture, from a path that
  // comes exclusively from their YAML and is confined to the data dir.
  // flow: main screen <img src="/img"> -> GET /img <-- HERE
  app.get('/img', wrap(requireAuth), wrap(async (req, res) => {
    const doc = await loadUserDoc(req.user);
    const pic = String(doc.info.picture ?? '');
    if (!pic) return res.status(404).end();
    if (/^https?:\/\//.test(pic)) return res.redirect(pic);
    const file = path.resolve(getDataDir(), pic);
    if (!file.startsWith(getDataDir() + path.sep)) return res.status(400).end();
    res.sendFile(file, err => { if (err && !res.headersSent) res.status(404).end(); });
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
    if (err instanceof NoUserFileError) return res.status(500).send(errorPage(err.message));
    if (err?.name === 'YAMLException') {
      return res.status(500).send(errorPage(`Your data file has a problem: ${err.reason ?? err.message}${err.mark ? ` (line ${err.mark.line + 1})` : ''}`));
    }
    console.error(err);
    res.status(500).send(errorPage('Something went wrong.'));
  });

  return app;
}
