// server.js — process entry: env config, secret bootstrap, HTTP listener.

// flow: terminal / systemd — `node server.js` starts the app <-- HERE
import { createApp } from './src/app.js';
import { setDataDir, loadUsers } from './src/store.js';
import { initSecret } from './src/auth.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
setDataDir(process.env.DATA_DIR ?? 'data');
await initSecret();

const users = await loadUsers().catch(() => []);
if (users.length === 0) console.log('no users yet — create one with: node bin/pinz-admin.js user add <name>');

createApp().listen(port, host, () => console.log(`pinz listening on http://${host}:${port}`));
