// title.js — best-effort page-title fetch for the add form.

// The problem is pasting a URL and then typing its title by hand is friction. The way
// we solve this is fetching at most 256KB of the page with a 4s timeout and pulling
// the <title> text out; any failure just means the user types it themselves.
// flow: add form title blank -> static/app.js fetches GET /title -> fetchTitle() <-- HERE
export async function fetchTitle(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { accept: 'text/html' } });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = '';
    while (html.length < 262144) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/title>/i.test(html)) break;
    }
    ctrl.abort();
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m ? decodeEntities(m[1]).trim().slice(0, 300) || null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Covers the entities that actually show up in <title> text.
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}
