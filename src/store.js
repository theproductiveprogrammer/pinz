// store.js — YAML data layer: cached reads, atomic writes, tag grouping.

import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

let dataDir = path.resolve('data');

// Points the store at a data directory; server and CLI each call this once at startup.
export function setDataDir(dir) { dataDir = path.resolve(dir); }
export function getDataDir() { return dataDir; }

// Interior dots are allowed (charles.lobo) but not leading/trailing/doubled, so a
// username can never be "." / ".." or hide a path trick. "users" is reserved because
// its data file would be users.yml — the accounts file itself.
const USERNAME_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
export function validUsername(u) { return typeof u === 'string' && u !== 'users' && USERNAME_RE.test(u); }

// Strips "#", trims, lowercases — one canonical form for a tag everywhere.
export function normalizeTag(t) { return String(t ?? '').trim().toLowerCase().replace(/^#/, ''); }

const cache = new Map();

// The problem is hand-edits to the YAML files should show up on the next page load
// without paying a reparse on every request. The way we solve this is stat-ing the
// file on each read and reparsing only when its mtime or size changed.
// flow: GET / -> requireAuth -> loadUserDoc -> loadYaml() <-- HERE
// flow: POST /login -> findUser -> loadUsers -> loadYaml() <-- HERE
async function loadYaml(file) {
  let st;
  try { st = await fsp.stat(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.doc;
  const doc = yaml.load(await fsp.readFile(file, 'utf8')) ?? {};
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, doc });
  return doc;
}

// flow: POST /login -> handleLogin -> findUser -> loadUsers() <-- HERE
export async function loadUsers() {
  const doc = await loadYaml(path.join(dataDir, 'users.yml'));
  return Array.isArray(doc?.users) ? doc.users.filter(u => u && validUsername(u.username)) : [];
}

// flow: POST /login -> handleLogin -> findUser() <-- HERE
// flow: every authed route -> requireAuth -> findUser() <-- HERE
export async function findUser(username) {
  return (await loadUsers()).find(u => u.username === username) ?? null;
}

function userFile(username) {
  if (!validUsername(username)) throw new Error(`bad username: ${username}`);
  return path.join(dataDir, `${username}.yml`);
}

// Error thrown when a user exists in users.yml but has no data file. Accounts are
// only ever created by `pinz-admin user add`; nothing else may invent a data file.
export class NoUserFileError extends Error {
  constructor(username) {
    super(`no data file for "${username}" — accounts are created with: pinz-admin user add ${username}`);
    this.name = 'NoUserFileError';
  }
}

// The problem is a hand-edited file can have any shape, and the rest of the app
// shouldn't have to defend against that. The way we solve this is coercing the doc
// to {info, tag_order, links} once, dropping entries without a usable link.
function normalizeDoc(doc) {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) doc = {};
  doc.info = (doc.info && typeof doc.info === 'object' && !Array.isArray(doc.info)) ? doc.info : {};
  doc.tag_order = Array.isArray(doc.tag_order) ? doc.tag_order.map(normalizeTag).filter(Boolean) : [];
  doc.links = (Array.isArray(doc.links) ? doc.links : [])
    .filter(l => l && typeof l === 'object' && typeof l.link === 'string' && l.link.trim());
  for (const l of doc.links) {
    l.tags = Array.isArray(l.tags) ? [...new Set(l.tags.map(normalizeTag).filter(Boolean))] : [];
  }
  return doc;
}

// The problem is the web app must never see a user without their data file — creation
// is the CLI's job alone. The way we solve this is failing loudly (NoUserFileError)
// instead of pretending the file is empty.
// flow: GET / -> homepage handler -> loadUserDoc() <-- HERE
// flow: GET /img -> image handler -> loadUserDoc() <-- HERE
export async function loadUserDoc(username) {
  const doc = await loadYaml(userFile(username));
  if (doc === null) throw new NoUserFileError(username);
  return normalizeDoc(doc);
}

const writeQueues = new Map();

// The problem is two near-simultaneous saves to one file could interleave and corrupt
// it. The way we solve this is chaining every write for a given key onto a per-key
// promise so they run strictly one at a time.
function enqueueWrite(key, job) {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  writeQueues.set(key, next.catch(() => {}));
  return next;
}

// The problem is a crash mid-write must never leave a half-written data file. The way
// we solve this is writing to a temp file, fsync-ing, then renaming over the original,
// keeping the prior version as a .bak one-step undo.
async function atomicWriteYaml(file, doc) {
  const text = yaml.dump(doc, { lineWidth: 120, noRefs: true });
  const tmp = `${file}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
  try { await fsp.copyFile(file, `${file}.bak`); } catch { /* first write: no original to back up */ }
  await fsp.rename(tmp, file);
  cache.delete(file);
}

// The problem is a web save must not clobber a file the user hand-edited into a broken
// state, and must not conjure files for users the CLI never created. The way we solve
// this is re-reading inside the write lock, refusing on parse failure or (unless the
// CLI passes create:true) on a missing file.
// flow: POST /add -> addLink -> mutateUserDoc() <-- HERE
// flow: terminal `pinz-admin user add` -> cmdUserAdd -> mutateUserDoc() <-- HERE
export function mutateUserDoc(username, mutate, { create = false } = {}) {
  const file = userFile(username);
  return enqueueWrite(username, async () => {
    let doc;
    try { doc = await loadYaml(file); }
    catch (e) { throw new Error(`refusing to write ${file}: current file does not parse (${e.message})`); }
    if (doc === null && !create) throw new NoUserFileError(username);
    doc = normalizeDoc(doc ?? {});
    const ret = await mutate(doc);
    if (ret === false) return doc; // mutation declined: leave the file untouched
    doc = ret ?? doc;
    await fsp.mkdir(dataDir, { recursive: true });
    await atomicWriteYaml(file, doc);
    return doc;
  });
}

// Same guarantees as mutateUserDoc, for users.yml. A username equal to the queue key
// ("users.yml") would merely share the queue — writes serialize, nothing corrupts —
// and "users" itself, the one real filename clash, is a reserved name.
// flow: terminal `pinz-admin user add|passwd|rm` -> mutateUsers() <-- HERE
export function mutateUsers(mutate) {
  const file = path.join(dataDir, 'users.yml');
  return enqueueWrite('users.yml', async () => {
    let doc;
    try { doc = await loadYaml(file); }
    catch (e) { throw new Error(`refusing to write ${file}: current file does not parse (${e.message})`); }
    doc = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : {};
    if (!Array.isArray(doc.users)) doc.users = [];
    doc = (await mutate(doc)) ?? doc;
    await fsp.mkdir(dataDir, { recursive: true });
    await atomicWriteYaml(file, doc);
    return doc;
  });
}

// The problem is the user adds a link once and expects it pinned exactly once.
// The way we solve this is checking for the URL inside the write lock and skipping
// the append when it's already there, reporting back which case happened.
// flow: add-link form -> POST /add -> addLink() <-- HERE
export function addLink(username, { link, title, tags }) {
  let duplicate = false;
  return mutateUserDoc(username, doc => {
    if (doc.links.some(l => l.link === link)) { duplicate = true; return false; }
    doc.links.push({
      link,
      title: title || '',
      tags: [...new Set(tags.map(normalizeTag).filter(Boolean))],
      added: new Date().toISOString(),
    });
    return doc;
  }).then(() => ({ duplicate }));
}

// The problem is the page shows links grouped by tag in the user's preferred order,
// not in YAML storage order. The way we solve this is bucketing links per tag, then
// ordering groups by tag_order position first, alphabetically after, untagged last
// unless tag_order places it explicitly. Links keep file (append) order.
// flow: GET / -> homepage handler -> groupByTag() <-- HERE
export function groupByTag(doc) {
  const groups = new Map();
  for (const l of doc.links) {
    for (const t of (l.tags.length ? l.tags : ['untagged'])) {
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(l);
    }
  }
  const pos = t => { const i = doc.tag_order.indexOf(t); return i === -1 ? Infinity : i; };
  return [...groups.entries()].sort(([a], [b]) => {
    const ia = pos(a), ib = pos(b);
    if (ia !== ib) return ia - ib;
    if ((a === 'untagged') !== (b === 'untagged')) return a === 'untagged' ? 1 : -1;
    return a.localeCompare(b);
  });
}
