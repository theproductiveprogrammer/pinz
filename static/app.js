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

  const groups = [...document.querySelectorAll('details.tag')];

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
  if (box) {
    let preSearch = null;
    // flow: main screen search box — user types (or presses /) -> filter() <-- HERE
    const filter = () => {
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

    const openDialog = li => {
      form.reset();
      const editing = !!li;
      form.action = editing ? '/edit' : '/add';
      form.elements.orig.value = editing ? li.dataset.link : '';
      form.elements.link.value = editing ? li.dataset.link : '';
      form.elements.title.value = editing ? li.dataset.title : '';
      form.elements.tags.value = editing ? li.dataset.tags : '';
      heading.textContent = editing ? 'edit link' : 'pin a link';
      submit.textContent = editing ? 'save' : 'pin';
      doneBtn.hidden = !editing || li.dataset.done === '1';
      restoreBtn.hidden = !editing || li.dataset.done !== '1';
      refreshChips();
      dialog.showModal();
      form.elements.link.focus();
    };

    document.getElementById('pin-new').addEventListener('click', () => openDialog(null));
    document.addEventListener('click', e => {
      const btn = e.target.closest('li .edit');
      if (btn) openDialog(btn.closest('li'));
    });
    // Closing is DELIBERATE only — cancel button or Esc. A stray click outside
    // must never eat what the user typed.
    document.getElementById('pin-cancel').addEventListener('click', () => dialog.close());
  }

  // The problem is placing and sizing the photo by editing numbers is guesswork.
  // The way we solve this is direct manipulation: drag the photo to move it, drag
  // its corner handle to resize it (center stays put), and the result is saved
  // back to the YAML in PAGE coordinates (X as % of page width, Y as px from the
  // top of the document) so the photo scrolls with the content it's pinned beside.
  // flow: main screen — user drags the photo or its corner -> POST /image-position
  const photo = document.querySelector('.photo');
  if (photo) {
    photo.addEventListener('pointerdown', e => {
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
