// render.js — HTML pages built from template literals; every interpolation escaped.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Wed 13 Aug 2026, 14:05:36" — the client clock in static/app.js uses the same format.
export function fmtDateTime(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Shared page skeleton around every rendered page.
function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>📌</text></svg>">
</head>
<body>
${body}
<script src="/static/app.js" defer></script>
</body>
</html>`;
}

// flow: GET /login and failed POST /login -> loginPage() <-- HERE
export function loginPage({ error = '' } = {}) {
  return page('pinz — login', `
<main class="login">
  <h1>pinz</h1>
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
  <h1>pinz</h1>
  <p class="error">${escapeHtml(message)}</p>
  <p><a href="/">back</a></p>
</main>`);
}

// Each item carries its own data as attributes so the edit dialog can prefill
// without another server round-trip.
function linkItem(l) {
  const text = (l.title ?? '').trim() || l.link;
  const search = [l.title ?? '', l.link, ...l.tags].join(' ').toLowerCase();
  return `<li${l.done ? ' class="done"' : ''} data-link="${escapeHtml(l.link)}" data-title="${escapeHtml(l.title ?? '')}" data-tags="${escapeHtml(l.tags.join(', '))}" data-done="${l.done ? '1' : ''}" data-search="${escapeHtml(search)}"><a href="${escapeHtml(l.link)}" target="_blank" rel="noopener">${escapeHtml(text)}</a><button type="button" class="edit quiet" aria-label="edit ${escapeHtml(text)}">✎</button></li>`;
}

// One collapsible "> #tag" section; server renders collapsed, client restores state.
function tagGroup([tag, links]) {
  return `<details class="tag" data-tag="${escapeHtml(tag)}">
<summary>#${escapeHtml(tag)} <span class="count">${links.length}</span></summary>
<ul>
${links.map(linkItem).join('\n')}
</ul>
</details>`;
}

// The problem is picture_position comes from a hand-editable YAML file but lands in a
// style attribute. The way we solve this is only accepting a plain CSS position token
// and falling back to center otherwise.
function safePosition(pos) {
  return typeof pos === 'string' && /^[a-z0-9% .-]{1,40}$/i.test(pos) ? pos : 'center';
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
export function homePage({ username, doc, groups, notice = '' }) {
  const name = (doc.info.name ?? '').trim() || username;
  const allTags = [...new Set(groups.map(([t]) => t))].filter(t => t !== 'untagged');
  const archived = doc.links.filter(l => l.done);
  return page('pinz', `
<header>
  <time id="clock">${fmtDateTime()}</time>
  <nav>
    <span class="who">${escapeHtml(name)}</span>
    <form method="post" action="/logout"><button class="quiet">log out</button></form>
  </nav>
</header>
<section class="controls">
  <input id="search" type="search" placeholder="search (press /)" autocomplete="off">
  <button type="button" class="quiet" id="pin-new">+ pin a link</button>
  ${NOTICES[notice] ? `<p class="notice">${escapeHtml(NOTICES[notice])}</p>` : ''}
</section>
<main>
  <section class="groups">
${groups.map(tagGroup).join('\n')}
${groups.length === 0 ? '<p class="empty">Nothing pinned yet.</p>' : ''}
${archived.length ? `<details class="tag archive" data-tag="archive">
<summary>archive <span class="count">${archived.length}</span></summary>
<ul>
${archived.map(linkItem).join('\n')}
</ul>
</details>` : ''}
  </section>
  ${doc.info.picture ? `<aside><img src="/img" alt="" style="object-position:${escapeHtml(safePosition(doc.info.picture_position))}"></aside>` : ''}
</main>
<dialog id="pin-dialog">
  <form method="post" action="/add" id="pin-form">
    <h2 id="pin-heading">pin a link</h2>
    <input type="hidden" name="orig" value="">
    <input id="add-link" name="link" type="url" placeholder="https://…" required>
    <input id="add-title" name="title" placeholder="title (optional — fetched if blank)">
    <input id="add-tags" name="tags" list="all-tags" placeholder="tags, comma, separated">
    <datalist id="all-tags">${allTags.map(t => `<option value="${escapeHtml(t)}">`).join('')}</datalist>
    <div class="actions">
      <button type="button" class="quiet" id="pin-cancel">cancel</button>
      <button name="action" value="done" class="quiet" id="pin-done">✓ complete</button>
      <button name="action" value="restore" class="quiet" id="pin-restore">↩ restore</button>
      <button name="action" value="save" id="pin-submit">pin</button>
    </div>
  </form>
</dialog>`);
}
