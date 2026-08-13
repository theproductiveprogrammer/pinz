#!/usr/bin/env node
// pinz-admin — manage users and images from the terminal. This is the only place
// accounts (and their data files) are ever created; the web app refuses to invent them.

import fsp from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import {
  setDataDir, getDataDir, loadUsers, findUser, validUsername,
  mutateUsers, mutateUserDoc,
} from '../src/store.js';

function die(msg) { console.error(`pinz-admin: ${msg}`); process.exit(1); }

// The problem is passwords typed at a terminal must not echo, but scripts still need
// to pipe one in. The way we solve this is raw-mode keystroke reading on a TTY and a
// plain line read otherwise.
function promptHidden(question) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', d => { buf += d; });
      stdin.on('end', () => resolve(buf.split('\n')[0]));
      return;
    }
    stdin.resume();
    stdin.setRawMode(true);
    let buf = '';
    const onData = ch => {
      ch = ch.toString('utf8');
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { // enter / ctrl-D
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') { // ctrl-C
        stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') { // backspace
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function promptPassword() {
  const pw = await promptHidden('password: ');
  if (pw.length < 4) die('password too short (min 4 characters)');
  return bcrypt.hashSync(pw, 12);
}

// flow: terminal — admin runs `pinz-admin user add <name>` to create an account <-- HERE
async function cmdUserAdd(username) {
  if (!validUsername(username)) die('username must be lowercase letters, digits, "_", "-", or interior dots (and not "users")');
  if (await findUser(username)) die(`user "${username}" already exists`);
  const hash = await promptPassword();
  await mutateUsers(doc => {
    doc.users.push({ username, password_hash: hash, created: new Date().toISOString().slice(0, 10) });
  });
  // The account's data file is born here and only here.
  await mutateUserDoc(username, doc => doc, { create: true });
  console.log(`created user "${username}" and ${path.join(getDataDir(), `${username}.yml`)}`);
}

// flow: terminal — `pinz-admin user passwd <name>` <-- HERE
async function cmdUserPasswd(username) {
  if (!await findUser(username)) die(`no such user "${username}"`);
  const hash = await promptPassword();
  await mutateUsers(doc => {
    doc.users.find(u => u.username === username).password_hash = hash;
  });
  console.log(`password updated for "${username}" (existing sessions stay valid until they expire)`);
}

// flow: terminal — `pinz-admin user list` <-- HERE
async function cmdUserList() {
  const users = await loadUsers();
  if (users.length === 0) return console.log('no users');
  for (const u of users) console.log(`${u.username}\t(created ${u.created ?? '?'})`);
}

// flow: terminal — `pinz-admin user rm <name>` <-- HERE
async function cmdUserRm(username) {
  if (!await findUser(username)) die(`no such user "${username}"`);
  const answer = await promptHidden(`really remove "${username}"? their .yml stays on disk. [y/N] `);
  if (answer.trim().toLowerCase() !== 'y') die('aborted');
  await mutateUsers(doc => { doc.users = doc.users.filter(u => u.username !== username); });
  console.log(`removed "${username}" from users.yml (bookmarks file kept)`);
}

// flow: terminal — `pinz-admin image set <name> <file>` <-- HERE
async function cmdImageSet(username, file) {
  if (!await findUser(username)) die(`no such user "${username}"`);
  if (!file) die('usage: image set <username> <file>');
  const ext = path.extname(file).toLowerCase() || '.jpg';
  await fsp.mkdir(path.join(getDataDir(), 'images'), { recursive: true });
  const rel = path.join('images', username + ext);
  await fsp.copyFile(file, path.join(getDataDir(), rel));
  await mutateUserDoc(username, doc => { doc.info.picture = rel; });
  console.log(`picture set: ${rel}`);
}

// flow: terminal — `pinz-admin image position <name> "50% 20%"` <-- HERE
async function cmdImagePosition(username, pos) {
  if (!await findUser(username)) die(`no such user "${username}"`);
  if (!pos || !/^[a-z0-9% .-]{1,40}$/i.test(pos)) die('position must be a CSS object-position value, e.g. "50% 20%"');
  await mutateUserDoc(username, doc => { doc.info.picture_position = pos; });
  console.log(`picture position set: ${pos}`);
}

function usage() {
  console.log(`usage: pinz-admin [--data <dir>] <command>

  user add <username>            create an account (prompts for password)
  user passwd <username>         change a password (prompts)
  user list                      list accounts
  user rm <username>             remove an account (data file kept)
  image set <username> <file>    copy an image into data/ and use it
  image position <username> "<x% y%>"   set the image crop (CSS object-position)`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const dataIdx = argv.indexOf('--data');
if (dataIdx !== -1) { setDataDir(argv[dataIdx + 1] ?? die('--data needs a directory')); argv.splice(dataIdx, 2); }

const commands = {
  'user add': cmdUserAdd,
  'user passwd': cmdUserPasswd,
  'user list': cmdUserList,
  'user rm': cmdUserRm,
  'image set': cmdImageSet,
  'image position': cmdImagePosition,
};
const cmd = commands[argv.slice(0, 2).join(' ')];
if (!cmd) usage();
await cmd(...argv.slice(2));
process.exit(0);
