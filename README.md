# Pinz - bookmarking tool

## Goals

- Fast
- Clean
- Ordered
- Grouped

## Expected interface

```
Date + Time

[search box]

> #tag1           [Nice Image]
> #tag2
v #tag3
  [Link1]
  [Link2]
  [Link3]
  [Link4]
> #tag4
```

## Data

YAML files in `/data` folder

```
data/
  users.yml
  user1.yml
    - info
      - picture (picture location?) etc
    - links
      - link: https://link
        title:
        tags:
      - link: https://link
        title:
        tags:
      
  user2.yml
  user3.yml
```

## Admin

Command line interface fine to change password of users, add/position image

## Running

```sh
npm install
node bin/pinz-admin.js user add <name>   # accounts are ONLY created here
npm start                                # http://127.0.0.1:7469
```

Env vars: `PORT` (7469, "PINZ" on a phone keypad), `HOST` (127.0.0.1), `DATA_DIR` (./data), `NODE_ENV=production` adds the `Secure` cookie flag.

### Admin CLI

```sh
node bin/pinz-admin.js user add <username>
node bin/pinz-admin.js user passwd <username>
node bin/pinz-admin.js user list
node bin/pinz-admin.js user rm <username>
node bin/pinz-admin.js image set <username> <file>
node bin/pinz-admin.js image position <username> "50% 20%"
```

All commands accept `--data <dir>`. Passwords are prompted (hidden), or piped: `printf 'pw' | node bin/pinz-admin.js user add me`.

### Notes

- A missing `data/<user>.yml` is an error, never auto-created — only `user add` creates it.
- Hand-editing the YAML is first-class: reorder `tag_order` or links, save, refresh. Writes are atomic with a `.bak` of the previous version; the app refuses to write over a file that doesn't parse. YAML comments are lost when the app rewrites a file.
- Run exactly one server instance per data dir (writes are serialized in-process).
- Sessions are 30-day signed cookies (secret at `data/.secret`); changing a password does not kill existing sessions, deleting the user does.

### Deploy (droplet)

`deploy/pinz.service` is a hardened systemd unit expecting the app at `/opt/pinz` under a `pinz` user, bound to `127.0.0.1:7469`. Put your reverse proxy in front:

```
# nginx                                  # Caddy
location / {                             pinz.example.com {
  proxy_pass http://127.0.0.1:7469;        reverse_proxy 127.0.0.1:7469
}                                        }
```

Back up `data/` — it's just text + images.
