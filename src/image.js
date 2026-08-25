// image.js — the profile picture as the browser should receive it: small, webp, versioned.

import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// Wide enough for a ~400px-wide photo on a 2x screen; nobody's picture is shown larger.
const MAX_WIDTH = 1000;

// The problem is uploaded pictures are phone-sized originals (0.3–2.3 MB) and, over a
// long-haul link, they alone cost seconds. The way we solve this is keeping a resized
// webp beside the original (images/.web/<name>.webp), rebuilt whenever the original
// is newer, and serving that instead.
// flow: main screen <img src="/img?v=…"> -> GET /img -> webPicture() <-- HERE
export async function webPicture(source) {
  const st = await fsp.stat(source);
  const out = path.join(path.dirname(source), '.web', `${path.basename(source)}.webp`);
  const cur = await fsp.stat(out).catch(() => null);
  if (cur && cur.mtimeMs >= st.mtimeMs) return out;
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  // rotate() honours EXIF orientation so phone photos don't come out sideways
  await sharp(source).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toFile(tmp);
  await fsp.rename(tmp, out);
  return out;
}

// The problem is a picture cached for a year would never update when replaced. The
// way we solve this is putting the original's mtime in the URL — a new upload is a
// new URL, an unchanged one stays in the browser cache forever.
// flow: GET / -> homepage handler -> pictureVersion() <-- HERE -> homePage
export async function pictureVersion(source) {
  const st = await fsp.stat(source).catch(() => null);
  return st ? Math.round(st.mtimeMs).toString(36) : '';
}
