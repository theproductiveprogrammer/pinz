// app.js — client enhancements: ticking clock, live search, remembered collapse
// state, title autofill. The page works fully without this file.

(() => {
  'use strict';

  // Keep the masthead clock alive; format matches fmtDate/fmtTime in src/render.js.
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const clockDate = document.getElementById('clock-date');
  const clockTime = document.getElementById('clock-time');
  if (clockDate && clockTime) {
    const p = n => String(n).padStart(2, '0');
    const tick = () => {
      const d = new Date();
      clockDate.textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
      clockTime.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  let groups = [...document.querySelectorAll('details.tag')];

  // Every load starts clean: nothing remembers which groups were open (and old
  // remembered state from earlier versions is wiped).
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('pinz.open.')) localStorage.removeItem(k);
  }

  // The problem is finding one link among many without leaving the page. The way we
  // solve this is filtering the server-rendered list in place: hide non-matching
  // links, force-open groups with hits, hide groups without any. Open state from
  // before the search is snapshotted and put back when the search clears.
  const box = document.getElementById('search');
  let filter = () => {};
  if (box) {
    let preSearch = null;
    // flow: main screen search box — user types (or presses /) -> filter() <-- HERE
    filter = () => {
      const q = box.value.trim().toLowerCase();
      if (q && !preSearch) preSearch = new Map(groups.map(d => [d.dataset.tag, d.open]));
      for (const d of groups) {
        let hits = 0;
        for (const li of d.querySelectorAll('li')) {
          const hit = !q || li.dataset.search.includes(q);
          li.hidden = !hit;
          if (hit) hits++;
        }
        if (q) {
          d.hidden = hits === 0;
          d.open = hits > 0;
        } else {
          d.hidden = false;
        }
      }
      if (!q && preSearch) {
        for (const d of groups) d.open = preSearch.get(d.dataset.tag) ?? false;
        preSearch = null;
      }
    };
    box.addEventListener('input', filter);
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== box && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        box.focus();
      }
    });
  }

  // The problem is one dialog serves three jobs: pin a new link, edit an existing
  // one, and complete/restore it. The way we solve this is prefilling the form from
  // the clicked item's data attributes and switching the form's target and buttons
  // to match the mode.
  // flow: main screen — "+ pin a link" or an item's ✎ -> openDialog() <-- HERE -> POST /add | /edit
  const dialog = document.getElementById('pin-dialog');
  // assigned below; review mode (further down) hands its card to the same dialog
  let openDialog = () => {};
  // true while the edit dialog is open on behalf of review mode: saves and deletes
  // then update the page in place instead of reloading, so the deck can carry on
  let reviewPaused = false;
  const form = document.getElementById('pin-form');
  if (dialog && form) {
    const heading = document.getElementById('pin-heading');
    const submit = document.getElementById('pin-submit');
    const doneBtn = document.getElementById('pin-done');
    const restoreBtn = document.getElementById('pin-restore');

    // The tag chips mirror the tags input both ways: clicking a chip toggles
    // the tag in the input; typing in the input relights the chips. No native
    // datalist dropdown — it covered the save button.
    const tagsInput = form.elements.tags;
    const picker = document.getElementById('tag-picker');
    const parseTags = () => tagsInput.value.split(/[\s,]+/).map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
    const refreshChips = () => {
      if (!picker) return;
      const current = new Set(parseTags());
      for (const chip of picker.children) chip.classList.toggle('on', current.has(chip.dataset.tag));
    };
    if (picker) {
      picker.addEventListener('click', e => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        const tag = chip.dataset.tag;
        const current = parseTags();
        const next = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag];
        tagsInput.value = next.join(', ');
        refreshChips();
      });
      tagsInput.addEventListener('input', refreshChips);
    }

    const deleteBtn = document.getElementById('pin-delete');
    const fileRow = document.getElementById('pin-file-row');
    // set while an uploaded file sits unpinned; deleted from the server if the
    // dialog closes without pinning it
    let orphanFile = '';

    // One dialog, three shapes: pin a link, edit a pin, pin a fresh upload.
    // File pins show a filename row instead of the URL input; every pin being
    // edited can be archived or deleted.
    openDialog = (li, upload) => {
      form.reset();
      const editing = !!li;
      const file = upload?.file || (li ? li.dataset.file : '');
      form.action = editing ? '/edit' : '/add';
      form.elements.orig.value = editing ? (li.dataset.link || li.dataset.file) : '';
      form.elements.file.value = file;
      form.elements.link.value = editing ? li.dataset.link : '';
      form.elements.title.value = editing ? li.dataset.title : upload?.title ?? '';
      form.elements.tags.value = editing ? li.dataset.tags : '';
      form.elements.link.hidden = !!file;
      form.elements.link.required = !file;
      form.elements.link.disabled = !!file;
      fileRow.hidden = !file;
      if (file) {
        const name = file.split('/').pop().replace(/^\d+-/, '');
        document.getElementById('pin-file-ext').textContent = (name.split('.').pop() ?? '').slice(0, 5).toUpperCase();
        document.getElementById('pin-file-name').textContent = name;
        const dl = document.getElementById('pin-file-download');
        dl.href = `/file/${file.split('/').map(encodeURIComponent).join('/')}`;
        dl.hidden = !editing; // an unpinned upload isn't servable yet
      }
      heading.textContent = editing ? (file ? 'edit file' : 'edit link') : (file ? 'pin a file' : 'pin a link');
      submit.textContent = editing ? 'save' : 'pin';
      doneBtn.hidden = !editing || li.dataset.done === '1';
      restoreBtn.hidden = !editing || li.dataset.done !== '1';
      deleteBtn.hidden = !editing;
      refreshChips();
      dialog.showModal();
      (file ? form.elements.title : form.elements.link).focus();
    };

    document.getElementById('pin-new').addEventListener('click', () => openDialog(null));
    document.addEventListener('click', e => {
      const btn = e.target.closest('li .edit');
      if (btn) openDialog(btn.closest('li'));
    });
    // Closing is DELIBERATE only — cancel button or Esc. A stray click outside
    // must never eat what the user typed.
    document.getElementById('pin-cancel').addEventListener('click', () => dialog.close());

    const removePin = key => fetch('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `key=${encodeURIComponent(key)}`,
    });

    // The problem is archive keeps everything, and some pins should truly go —
    // files cost disk, dead links are clutter. The way we solve this is a
    // confirmed delete on any pin being edited; for files, the download link sits
    // right beside it for a last copy first.
    // flow: edit dialog -> "✕ delete" -> POST /delete
    deleteBtn.addEventListener('click', async () => {
      const key = form.elements.file.value || form.elements.orig.value;
      if (!key || !confirm('Delete this pin forever?')) return;
      await removePin(key).catch(() => {});
      if (!reviewPaused) return location.reload();
      for (const li of document.querySelectorAll('details.tag li')) {
        if ((li.dataset.link || li.dataset.file) === key) li.remove();
      }
      dialog.close();
    });

    // pinning claims the upload; closing without pinning deletes the orphan
    form.addEventListener('submit', () => { orphanFile = ''; });

    // The problem is a save from inside review mode must not reload the page — that
    // would throw the deck away. The way we solve this is posting the form ourselves,
    // letting the server's redirect hand back the fresh page, and swapping the list
    // in place before the dialog closes and the deck resumes.
    // flow: review card ✎ -> edit dialog save/archive -> POST /edit (fetch) <-- HERE -> applyPage
    form.addEventListener('submit', async e => {
      if (!reviewPaused) return;
      e.preventDefault();
      try {
        // getAttribute: the form's buttons are named "action", which shadows form.action
        const res = await fetch(form.getAttribute('action'), { method: 'POST', body: new URLSearchParams(new FormData(form, e.submitter)) });
        if (res.ok) applyPage(await res.text());
      } catch { /* the next review pass shows the truth */ }
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      if (orphanFile) { removePin(orphanFile).catch(() => {}); orphanFile = ''; }
    });

    // The problem is a dropped file takes real seconds to reach the server, and
    // silence reads as "nothing happened" — inviting a second drop. The way we
    // solve this is dimming the page behind an uploading card with a live progress
    // bar the moment the file lands, and ignoring further drops until it's done.
    // (XHR, not fetch: only XHR reports upload progress.)
    const veil = document.getElementById('upload-veil');
    const veilLabel = document.getElementById('upload-label');
    const veilBar = document.getElementById('upload-bar');
    const uploadFile = f => new Promise(resolve => {
      veilLabel.textContent = `uploading ${f.name}…`;
      veilBar.style.width = '0%';
      veil.hidden = false;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/upload?name=${encodeURIComponent(f.name)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = ev => {
        if (ev.lengthComputable) veilBar.style.width = `${Math.round(ev.loaded / ev.total * 100)}%`;
      };
      xhr.onload = () => { veil.hidden = true; resolve({ ok: xhr.status >= 200 && xhr.status < 300, body: xhr.responseText }); };
      xhr.onerror = () => { veil.hidden = true; resolve({ ok: false, body: '' }); };
      xhr.send(f);
    });

    // The problem is getting a document in should be as direct as dragging the
    // photo around. The way we solve this is accepting a file dropped anywhere on
    // the page: upload it (25MB cap), then open the pin dialog to title and tag it.
    // flow: OS file dropped on the page -> uploadFile -> POST /upload -> openDialog(file mode)
    addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dropping'); });
    addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
    addEventListener('drop', async e => {
      e.preventDefault();
      document.body.classList.remove('dropping');
      const f = e.dataTransfer?.files?.[0];
      if (!f || !veil.hidden) return; // an upload is already in flight
      const res = await uploadFile(f);
      if (!res.ok) {
        let msg = '';
        try { msg = JSON.parse(res.body).error; } catch { /* not json */ }
        alert(msg || 'upload failed');
        return;
      }
      const { file, title } = JSON.parse(res.body);
      orphanFile = file;
      openDialog(null, { file, title });
    });
  }

  // The problem is placing and sizing the photo by editing numbers is guesswork.
  // The way we solve this is direct manipulation: drag the photo to move it, drag
  // its corner handle to resize it (center stays put), and the result is saved
  // back to the YAML in PAGE coordinates (X as % of page width, Y as px from the
  // top of the document) so the photo scrolls with the content it's pinned beside.
  // flow: main screen — user drags the photo or its corner -> POST /image-position
  // Delegated from the document: the photo element is replaced by a background
  // refresh (below), and a listener bound to the old one would die with it.
  document.addEventListener('pointerdown', e => {
    const photo = e.target.closest('.photo');
    if (!photo) return;
    e.preventDefault();
    photo.setPointerCapture(e.pointerId);
    const r0 = photo.getBoundingClientRect();
    // page-coordinate center — fixed during resize, follows the cursor on move
    const cx0 = r0.left + r0.width / 2 + scrollX;
    const cy0 = r0.top + r0.height / 2 + scrollY;
    const resizing = e.clientX > r0.right - 18 && e.clientY > r0.bottom - 18;
    const dx = cx0 - e.pageX;
    const dy = cy0 - e.pageY;
    if (!resizing) photo.classList.add('dragging');
    const onMove = ev => {
      if (resizing) {
        // width only — height follows the image's natural aspect ratio
        photo.style.width = `${Math.max(32, Math.round((ev.pageX - cx0) * 2))}px`;
      } else {
        photo.style.left = `${Math.round(ev.pageX + dx)}px`;
        photo.style.top = `${Math.round(ev.pageY + dy)}px`;
      }
    };
    const up = () => {
      photo.removeEventListener('pointermove', onMove);
      photo.classList.remove('dragging');
      const r = photo.getBoundingClientRect();
      const cx = r.left + r.width / 2 + scrollX;
      const cy = r.top + r.height / 2 + scrollY;
      const pos = `${(cx / innerWidth * 100).toFixed(1)}% ${Math.round(cy)}px ${Math.round(r.width)}px`;
      fetch('/image-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `pos=${encodeURIComponent(pos)}`,
      }).catch(() => { /* position still applies until reload */ });
    };
    photo.addEventListener('pointermove', onMove);
    photo.addEventListener('pointerup', up, { once: true });
  });

  // The problem is from far away every network round trip is a quarter second, and
  // a start page should be up before the hand leaves the keyboard. The way we solve
  // this is a service worker (sw.js) that answers "/" from cache at once and fetches
  // the real page behind it; when that differs, the list is swapped in place here —
  // keeping open groups, the search, and the dialog exactly as the user has them.
  // flow: new tab -> sw.js pageResponse -> postMessage -> refresh() <-- HERE
  // Swap this page's list (and the dialog's tag chips) for a freshly rendered copy,
  // keeping open groups and the search filter. Shared by the service-worker refresh
  // below and by saves made from inside review mode.
  function applyPage(html) {
    const next = new DOMParser().parseFromString(html, 'text/html');
    const open = new Set(groups.filter(d => d.open).map(d => d.dataset.tag));
    document.querySelector('main').replaceWith(next.querySelector('main'));
    const oldPicker = document.getElementById('tag-picker');
    const newPicker = next.getElementById('tag-picker');
    if (oldPicker && newPicker) oldPicker.replaceWith(newPicker);
    else if (oldPicker) oldPicker.remove();
    else if (newPicker && form) form.elements.tags.insertAdjacentElement('afterend', newPicker);
    groups = [...document.querySelectorAll('details.tag')];
    for (const d of groups) d.open = open.has(d.dataset.tag);
    filter();
  }

  if ('serviceWorker' in navigator && dialog) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* plain network loads still work */ });
    const refresh = html => {
      if (document.querySelector('dialog[open]')) return; // never pull the page out from under an open dialog
      applyPage(html);
    };
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'refresh') refresh(e.data.html);
      if (e.data?.type === 'expired') location.replace('/login');
    });
  }

  // The problem is links pile up faster than they're read, and scanning a long list
  // never answers "is this still worth opening?". The way we solve this is a deck:
  // every active link, shuffled, one card at a time — swipe/arrow right opens it in
  // a new tab, left passes. Nothing is changed by reviewing; deleting and retagging
  // stay in the edit dialog.
  // flow: main screen — "review" button -> startReview() <-- HERE -> showCard -> window.open
  const review = document.getElementById('review');
  const startBtn = document.getElementById('review-start');
  if (review && startBtn) {
    const card = document.getElementById('review-card');
    const under = review.querySelector('.card.under');
    const end = document.getElementById('review-end');
    const count = document.getElementById('review-count');
    const hintPass = document.getElementById('hint-pass');
    const hintOpen = document.getElementById('hint-open');
    let deck = [];
    let at = 0;
    let opened = 0;

    // The deck holds keys (URL or stored path), not rows: an edit re-renders the
    // list, and the card must find the link's fresh row — or notice it's gone.
    const liFor = key => document.querySelector(
      `details.tag:not(.archive) li[data-link="${CSS.escape(key)}"], details.tag:not(.archive) li[data-file="${CSS.escape(key)}"]`);

    // Every active link once (a link under two tags is listed twice), in random order.
    const buildDeck = () => {
      const keys = [...new Set([...document.querySelectorAll('details.tag:not(.archive) li')].map(li => li.dataset.link || li.dataset.file))];
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      return keys;
    };

    // The current card's row, skipping any link that was archived or deleted mid-review.
    const current = () => {
      while (at < deck.length && !liFor(deck[at])) deck.splice(at, 1);
      return at < deck.length ? liFor(deck[at]) : null;
    };

    const age = iso => {
      const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
      if (Number.isNaN(days)) return '';
      if (days < 1) return 'today';
      if (days < 30) return `${days}d ago`;
      if (days < 365) return `${Math.floor(days / 30)}mo ago`;
      return `${Math.floor(days / 365)}y ago`;
    };

    const showCard = () => {
      card.classList.remove('dragging');
      card.style.transform = '';
      hintPass.classList.remove('lit');
      hintOpen.classList.remove('lit');
      const li = current();
      count.textContent = li ? `${at + 1} / ${deck.length}` : `${deck.length} / ${deck.length}`;
      card.hidden = !li;
      document.getElementById('review-edit').hidden = !li;
      under.hidden = !deck[at + 1];
      end.hidden = !!li;
      if (!li) { end.textContent = `all ${deck.length} reviewed — ${opened} opened`; return; }
      const link = li.dataset.link;
      const a = li.querySelector('a');
      document.getElementById('review-title').textContent = a.textContent;
      const ext = li.querySelector('.ext');
      const extEl = document.getElementById('review-ext');
      extEl.hidden = !ext;
      extEl.textContent = ext ? ext.textContent : '';
      let domain = '';
      try { domain = link ? new URL(link).hostname.replace(/^www\./, '') : ''; } catch { /* file pin */ }
      document.getElementById('review-domain').textContent = domain;
      document.getElementById('review-age').textContent = age(li.dataset.added);
      document.getElementById('review-tags').replaceChildren(...li.dataset.tags.split(/,\s*/).filter(Boolean).map(t => {
        const s = document.createElement('span'); s.textContent = `#${t}`; return s;
      }));
    };

    // Understand: window.open must run synchronously inside the user's gesture
    // (key or pointerup) or the browser treats it as a popup and blocks it.
    const verdict = open => {
      const li = current();
      if (!li) return;
      if (open) { window.open(li.querySelector('a').href, '_blank'); opened++; }
      card.classList.remove('dragging');
      card.style.transform = `translateX(${open ? 120 : -120}%) rotate(${open ? 12 : -12}deg)`;
      at++;
      setTimeout(showCard, 160);
    };

    const startReview = () => {
      if (!reviewPaused) { deck = buildDeck(); at = 0; opened = 0; }
      reviewPaused = false;
      showCard();
      review.showModal();
      card.focus();
    };
    startBtn.addEventListener('click', startReview);
    // "r" from anywhere on the board, like "/" for search — never from inside a
    // text field or over an open dialog.
    document.addEventListener('keydown', e => {
      if (e.key !== 'r' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      startReview();
    });
    document.getElementById('review-close').addEventListener('click', () => review.close());

    // The problem is a card sometimes needs fixing (retag, retitle, archive, delete)
    // right there, and the edit dialog already does all of that. The way we solve
    // this is handing the card's row to the existing dialog and, however it closes
    // (cancel, save, archive, delete), reopening the deck where it was — a link that
    // left the board is simply skipped.
    // flow: review card ✎ (or "e") -> editCurrent() <-- HERE -> openDialog -> dialog close -> startReview
    const editBtn = document.getElementById('review-edit');
    const editCurrent = () => {
      const li = current();
      if (!li) return;
      reviewPaused = true;
      review.close();
      openDialog(li);
    };
    editBtn.addEventListener('click', editCurrent);
    dialog.addEventListener('close', () => { if (reviewPaused) startReview(); });
    review.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); verdict(true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); verdict(false); }
      if (e.key === 'e') { e.preventDefault(); editCurrent(); }
    });

    // Swipe: the card follows the finger; past a third of its width (or a quick
    // flick) the release is the verdict, otherwise it springs back.
    card.addEventListener('pointerdown', e => {
      if (!current()) return;
      e.preventDefault();
      card.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
      const x0 = e.clientX;
      const t0 = Date.now();
      const limit = card.offsetWidth / 3;
      let dx = 0;
      const onMove = ev => {
        dx = ev.clientX - x0;
        card.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
        hintOpen.classList.toggle('lit', dx > limit);
        hintPass.classList.toggle('lit', dx < -limit);
      };
      const onUp = () => {
        card.removeEventListener('pointermove', onMove);
        const flick = Math.abs(dx) > 40 && Date.now() - t0 < 250;
        if (Math.abs(dx) > limit || flick) verdict(dx > 0);
        else { card.classList.remove('dragging'); card.style.transform = ''; }
      };
      card.addEventListener('pointermove', onMove);
      card.addEventListener('pointerup', onUp, { once: true });
      card.addEventListener('pointercancel', onUp, { once: true });
    });
  }

  // Fill the title field from the server's /title lookup when the user leaves it blank.
  const linkInput = document.getElementById('add-link');
  const titleInput = document.getElementById('add-title');
  if (linkInput && titleInput) {
    linkInput.addEventListener('change', async () => {
      if (titleInput.value.trim() || !linkInput.value.trim()) return;
      try {
        const res = await fetch(`/title?url=${encodeURIComponent(linkInput.value.trim())}`);
        const { title } = await res.json();
        if (title && !titleInput.value.trim()) titleInput.value = title;
      } catch { /* user types it themselves */ }
    });
  }
})();
