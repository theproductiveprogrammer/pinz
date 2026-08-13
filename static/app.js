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
  let searching = false;

  // Reopen the tag groups the user had open last visit; remember future toggles.
  for (const d of groups) {
    const key = `pinz.open.${d.dataset.tag}`;
    if (localStorage.getItem(key) === '1') d.open = true;
    d.addEventListener('toggle', () => {
      if (!searching) localStorage.setItem(key, d.open ? '1' : '0');
    });
  }

  // The problem is finding one link among many without leaving the page. The way we
  // solve this is filtering the server-rendered list in place: hide non-matching
  // links, force-open groups with hits, hide groups without any.
  const box = document.getElementById('search');
  if (box) {
    // flow: main screen search box — user types (or presses /) -> filter() <-- HERE
    const filter = () => {
      const q = box.value.trim().toLowerCase();
      searching = q.length > 0;
      for (const d of groups) {
        let hits = 0;
        for (const li of d.querySelectorAll('li')) {
          const hit = !q || li.dataset.search.includes(q);
          li.hidden = !hit;
          if (hit) hits++;
        }
        if (searching) {
          d.hidden = hits === 0;
          d.open = hits > 0;
        } else {
          d.hidden = false;
          d.open = localStorage.getItem(`pinz.open.${d.dataset.tag}`) === '1';
        }
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
      dialog.showModal();
      form.elements.link.focus();
    };

    document.getElementById('pin-new').addEventListener('click', () => openDialog(null));
    document.addEventListener('click', e => {
      const btn = e.target.closest('li .edit');
      if (btn) openDialog(btn.closest('li'));
    });
    document.getElementById('pin-cancel').addEventListener('click', () => dialog.close());
    // click on the backdrop (the dialog element itself, not its children) closes
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
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
