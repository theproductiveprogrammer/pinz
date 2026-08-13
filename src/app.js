// app.js — Express wiring: routes, auth, and the friendly-error boundary.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAuth, handleLogin, handleLogout } from './auth.js';
import { loadUserDoc, addLink, groupByTag, getDataDir, normalizeTag, NoUserFileError } from './store.js';
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
    res.send(homePage({ username: req.user, doc, groups: groupByTag(doc), duplicate: 'dup' in req.query }));
  }));

  // flow: add-link form -> POST /add <-- HERE -> addLink -> redirect /
  app.post('/add', wrap(requireAuth), wrap(async (req, res) => {
    const url = parseHttpUrl(req.body?.link);
    if (!url) return res.status(400).send(errorPage('Only http(s) URLs can be pinned.'));
    const title = String(req.body?.title ?? '').trim();
    const tags = String(req.body?.tags ?? '').split(',').map(normalizeTag).filter(Boolean);
    const { duplicate } = await addLink(req.user, { link: url.href, title, tags });
    res.redirect(303, duplicate ? '/?dup=1' : '/');
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
