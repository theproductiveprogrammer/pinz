// app.js — client enhancements: ticking clock, live search, remembered collapse
// state, title autofill. The page works fully without this file.

(() => {
  'use strict';

  // Keep the header clock alive; format matches src/render.js fmtDateTime.
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const clock = document.getElementById('clock');
  if (clock) {
    const p = n => String(n).padStart(2, '0');
    const tick = () => {
      const d = new Date();
      clock.textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
