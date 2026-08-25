// render.js — HTML pages built from template literals; every interpolation escaped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The problem is /static ships with a year of browser cache, so a deploy could
// leave users on stale assets mismatched with fresh HTML. The way we solve this is
// stamping asset URLs with the server's boot time — every restart (deploys restart
// the service) is a new URL, and unchanged assets stay cached between deploys.
const ASSET_V = Date.now().toString(36);

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../static');
const DEV = process.env.NODE_ENV !== 'production';

// The problem is a separate stylesheet is a render-blocking round trip, and from far
// away one round trip is a quarter second. The way we solve this is inlining the CSS
// and the (small) JS straight into every page: one request paints a working screen.
// In production they're read once at boot; in dev on every request so edits show.
const assets = {};
function inlineAsset(name) {
  if (DEV || !assets[name]) {
    assets[name] = fs.readFileSync(path.join(STATIC, name), 'utf8')
      // the font URL lives in the CSS; version it like every other static URL
      .replace(/url\("\/static\/([^"?]+)"\)/g, `url("/static/$1?v=${ASSET_V}")`)
      // a literal </script> or </style> in the source would end the inline block early
      .replace(/<\//g, '<\\/');
  }
  return assets[name];
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Masthead clock, spelled out like a ledger heading — "Wednesday 13 August" +
// "14:05:36". The client tick in static/app.js uses the same format.
export function fmtDate(d = new Date()) {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function fmtTime(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Shared page skeleton around every rendered page.
function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preload" href="/static/fonts/space-grotesk.woff2?v=${ASSET_V}" as="font" type="font/woff2" crossorigin>
<style>${inlineAsset('style.css')}</style>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>📌</text></svg>">
</head>
<body>
${body}
<script>${inlineAsset('app.js')}</script>
</body>
</html>`;
}

// flow: GET /login and failed POST /login -> loginPage() <-- HERE
export function loginPage({ error = '' } = {}) {
  return page('pinz — login', `
<main class="login">
  <h1 class="wordmark">pinz</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/login">
    <input name="username" placeholder="username" autocomplete="username" autofocus required>
    <input name="password" type="password" placeholder="password" autocomplete="current-password" required>
    <button>log in</button>
  </form>
</main>`);
}

// flow: any handler error (bad YAML, missing data file, bad input) -> errorPage() <-- HERE
export function errorPage(message, status = 500) {
  return page('pinz — problem', `
<main class="login">
  <h1 class="wordmark">pinz</h1>
  <p class="error">${escapeHtml(message)}</p>
  <p><a href="/">back</a></p>
</main>`);
}

// Each item carries its own data as attributes so the edit dialog can prefill
// without another server round-trip. File pins get an extension marker and an
// authed /file/ href; links keep their URL.
function linkItem(l) {
  const isFile = !!l.file;
  const fileName = isFile ? l.file.split('/').pop().replace(/^\d+-/, '') : '';
  const text = (l.title ?? '').trim() || (isFile ? fileName : l.link);
  const href = isFile ? `/file/${l.file.split('/').map(encodeURIComponent).join('/')}` : l.link;
  const ext = isFile ? (fileName.split('.').pop() ?? '').slice(0, 5).toUpperCase() : '';
  // Search matches what the eye sees: the displayed text plus tags — not the
  // URL, which matched all sorts of things the user never typed.
  const search = [text, ...l.tags].join(' ').toLowerCase();
  // Same-tab on purpose: pinz is a start page, so a click hands the tab over
  // to the link (cmd/ctrl-click still opens a new one).
  return `<li${l.done ? ' class="done"' : ''} data-link="${escapeHtml(l.link ?? '')}" data-file="${escapeHtml(l.file ?? '')}" data-title="${escapeHtml(l.title ?? '')}" data-tags="${escapeHtml(l.tags.join(', '))}" data-done="${l.done ? '1' : ''}" data-added="${escapeHtml(l.added ?? '')}" data-search="${escapeHtml(search)}">${ext ? `<span class="ext">${escapeHtml(ext)}</span>` : ''}<a href="${escapeHtml(href)}">${escapeHtml(text)}</a><button type="button" class="edit quiet" aria-label="edit ${escapeHtml(text)}">✎</button></li>`;
}

// One collapsible "> #tag" section; server renders collapsed, client restores state.
// The untagged group is the inbox, not a real tag — no "#", styled apart.
function tagGroup([tag, links]) {
  const untagged = tag === 'untagged';
  return `<details class="tag${untagged ? ' untagged' : ''}" data-tag="${escapeHtml(tag)}">
<summary>${untagged ? 'untagged' : `#${escapeHtml(tag)}`} <span class="count">${links.length}</span></summary>
<ul>
${links.map(linkItem).join('\n')}
</ul>
</details>`;
}

// The problem is picture_position pins the image anywhere on the page ("X Y [W]",
// typically "50% 320px 10rem"), but it comes from a hand-editable YAML file and lands
// in a style attribute. The way we solve this is accepting only bare CSS lengths,
// falling back to a top-right thumbnail when absent or invalid. Only width is sized —
// height follows the image's natural aspect ratio (no crop, no squaring).
function photoStyle(pos) {
  const LEN = /^\d+(?:\.\d+)?(?:%|px|rem|em|vw|vh)$/;
  const t = String(pos ?? '').trim().split(/\s+/).filter(Boolean);
  const ok = t.length >= 2 && t.length <= 4 && t.every(v => LEN.test(v));
  const [x = '85%', y = '10rem', w = '12rem'] = ok ? t : [];
  return `left:${x};top:${y};width:${w}`;
}

const NOTICES = {
  dup: 'Already pinned — not added twice.',
  restored: 'That link was in your archive — restored.',
  missing: "That link isn't in your file anymore (edited elsewhere?) — nothing changed.",
};

// The problem is the whole app is one screen: date, search, the pin/edit dialog, and
// the user's links grouped under collapsible tags with the archive at the bottom and
// their picture alongside. The way we solve this is rendering everything server-side
// here; static/app.js opens the dialog and prefills it from the clicked item.
// flow: main screen — GET / -> homePage() <-- HERE
export function homePage({ username, doc, groups, notice = '', imgV = '' }) {
  const name = (doc.info.name ?? '').trim() || username;
  const allTags = [...new Set(groups.map(([t]) => t))].filter(t => t !== 'untagged');
  const archived = doc.links.filter(l => l.done);
  return page('pinz', `
<header>
  <nav>
    <span class="who">${escapeHtml(name)}</span>
    <form method="post" action="/logout"><button class="quiet">log out</button></form>
  </nav>
  <time id="clock"><span id="clock-date">${fmtDate()}</span><span id="clock-time">${fmtTime()}</span></time>
</header>
<section class="controls">
  <input id="search" type="search" placeholder="search (press /)" autocomplete="off">
  <span class="buttons"><button type="button" id="pin-new">+ pin a link</button>${groups.length ? '<button type="button" id="review-start" title="press r">review</button>' : ''}</span>
</section>
${NOTICES[notice] ? `<p class="notice">${escapeHtml(NOTICES[notice])}</p>` : ''}
<main>
  <section class="groups">
${groups.map(tagGroup).join('\n')}
${groups.length === 0 ? '<p class="empty">Nothing pinned yet — pin your first link above.</p>' : ''}
${archived.length ? `<details class="tag archive" data-tag="archive">
<summary>archive <span class="count">${archived.length}</span></summary>
<ul>
${archived.map(linkItem).join('\n')}
</ul>
</details>` : ''}
  </section>
  ${doc.info.picture ? `<figure class="photo" style="${escapeHtml(photoStyle(doc.info.picture_position))}"><img src="/img${imgV ? `?v=${escapeHtml(imgV)}` : ''}" alt=""></figure>` : ''}
</main>
<dialog id="pin-dialog">
  <form method="post" action="/add" id="pin-form">
    <h2 id="pin-heading">pin a link</h2>
    <input type="hidden" name="orig" value="">
    <input type="hidden" name="file" value="">
    <p id="pin-file-row" hidden><span class="ext" id="pin-file-ext"></span> <span id="pin-file-name"></span> <a id="pin-file-download" href="" class="quiet">download</a></p>
    <input id="add-link" name="link" type="url" placeholder="https://…" required>
    <input id="add-title" name="title" placeholder="title (optional — fetched if blank)">
    <input id="add-tags" name="tags" placeholder="tags (space or comma separated)">
    ${allTags.length ? `<div id="tag-picker">${allTags.map(t => `<button type="button" class="chip" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}</div>` : ''}
    <div class="actions">
      <button type="button" class="quiet danger" id="pin-delete" hidden>✕ delete</button>
      <button type="button" class="quiet" id="pin-cancel">cancel</button>
      <button name="action" value="done" class="quiet" id="pin-done">✓ archive</button>
      <button name="action" value="restore" class="quiet" id="pin-restore">↩ restore</button>
      <button name="action" value="save" id="pin-submit">pin</button>
    </div>
  </form>
</dialog>
<dialog id="review">
  <div class="review-head"><span id="review-count"></span><span class="review-tools"><button type="button" class="quiet" id="review-edit" aria-label="edit this link">✎ edit</button><button type="button" class="quiet" id="review-close">close</button></span></div>
  <div class="deck">
    <article class="card under" aria-hidden="true"></article>
    <article class="card" id="review-card" tabindex="-1">
      <span class="ext" id="review-ext" hidden></span>
      <h3 id="review-title"></h3>
      <p class="meta"><span id="review-domain"></span><span id="review-age"></span></p>
      <div class="tags" id="review-tags"></div>
    </article>
    <p class="review-end" id="review-end" hidden></p>
  </div>
  <div class="review-actions">
    <span class="hint" id="hint-pass">← pass</span>
    <span class="hint" id="hint-open">open →</span>
  </div>
</dialog>
<div id="upload-veil" hidden><div class="card"><span id="upload-label">uploading…</span><div class="bar"><i id="upload-bar"></i></div></div></div>`);
}
