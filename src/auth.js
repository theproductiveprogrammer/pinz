// auth.js — HMAC-signed cookie sessions and login/logout. No session store:
// the cookie itself is the session, verified against a secret in data/.secret.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { getDataDir, findUser } from './store.js';
import { loginPage } from './render.js';

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

let secret = null;

// The problem is signed cookies need a secret that survives restarts without the user
// managing keys. The way we solve this is generating 32 random bytes into data/.secret
// on first boot and reusing it forever after.
// flow: server start — server.js -> initSecret() <-- HERE
export async function initSecret() {
  const file = path.join(getDataDir(), '.secret');
  try {
    secret = (await fsp.readFile(file, 'utf8')).trim();
    if (!secret) throw new Error('empty');
  } catch {
    secret = crypto.randomBytes(32).toString('hex');
    await fsp.mkdir(getDataDir(), { recursive: true });
    await fsp.writeFile(file, `${secret}\n`, { mode: 0o600 });
  }
}

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

// Builds the "payload.mac" session token carrying username + expiry.
function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + THIRTY_DAYS_S * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

// The problem is the session cookie is attacker-supplied input. The way we solve this
// is recomputing the HMAC and comparing timing-safe before trusting any of its content.
function verifyToken(token) {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expect = Buffer.from(sign(payload));
  if (mac.length !== expect.length || !crypto.timingSafeEqual(mac, expect)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.u !== 'string' || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

// Minimal cookie-header parse; we only ever look for one cookie.
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionCookie(value, { expire = false } = {}) {
  const parts = [`pinz=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${expire ? 0 : THIRTY_DAYS_S}`];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

// The problem is every page is private: nothing may render without a valid session,
// and a deleted user's old cookie must stop working. The way we solve this is verifying
// the cookie and re-checking the username still exists in users.yml on every request.
// flow: GET /, POST /add, GET /img, POST /logout, GET /title -> requireAuth() <-- HERE
export async function requireAuth(req, res, next) {
  const token = readCookie(req, 'pinz');
  const data = token && verifyToken(token);
  const user = data && await findUser(data.u).catch(() => null);
  if (!user) return res.redirect('/login');
  req.user = user.username;
  next();
}

// Compare target for unknown usernames so lookup misses cost the same as hash misses.
const DUMMY_HASH = bcrypt.hashSync('pinz-dummy-password', 12);

// The problem is turning a correct password into a browser session, giving nothing
// away on failure. The way we solve this is bcrypt-comparing against the real hash or
// a dummy one, then setting the signed cookie only on a genuine match.
// flow: login screen — user submits POST /login -> handleLogin() <-- HERE
export async function handleLogin(req, res) {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const user = await findUser(username).catch(() => null);
  const match = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !match) {
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).send(loginPage({ error: 'Wrong username or password.' }));
  }
  res.setHeader('Set-Cookie', sessionCookie(makeToken(user.username)));
  res.redirect(303, '/');
}

// flow: header log-out button -> POST /logout -> handleLogout() <-- HERE
export function handleLogout(req, res) {
  res.setHeader('Set-Cookie', sessionCookie('', { expire: true }));
  res.redirect(303, '/login');
}
