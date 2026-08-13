# Server Setup

Production deployment for the droplet (Ubuntu 24.04 + nginx + systemd + mise) —
same conventions as throughglass/server-setup.

## Architecture

One process, one hostname, no database, no build step:

```
pinz.charleslobo.com  ←  nginx (TLS via certbot)  ←  node :7469 (loopback)
```

- The express app serves everything itself (pages + /static); nginx only
  proxies and terminates TLS.
- All state is `/home/noah/pinz/data/` — YAML files + images, gitignored, so
  `git reset --hard` deploys never touch it.
- Fully private: every page needs a login; `NODE_ENV=production` (set in the
  unit) makes the session cookie `Secure`.

## Files

- `pinz.service` — systemd unit. Runs `mise run start` as noah from
  `/home/noah/pinz`.
- `pinz.nginx.conf` — vhost. Install to
  `/etc/nginx/sites-available/pinz.charleslobo.com`, symlink into
  `sites-enabled/`; certbot adds TLS in place.
- `remote-deploy.sh` — runs on the server: mise install, npm ci, restart,
  health check.
- `deploy.sh` — runs on your dev machine: push master, then SSH in and invoke
  `remote-deploy.sh`. One sudo password per deploy.

## Assumptions

- Repo cloned at `/home/noah/pinz` as user `noah` (already done), `mise trust`ed.
- `mise` installed at `/usr/bin/mise` (system-wide) — already true.
- nginx + certbot already running for throughglass.

## First-time setup

```bash
# 0. DNS first (propagation can take a while): A record
#    pinz.charleslobo.com → 134.122.127.41

ssh noah@134.122.127.41
cd /home/noah/pinz

# 1. Toolchain + deps
mise trust && mise install          # node lts
mise exec -- npm ci --omit=dev

# 2. Create your account (the ONLY way accounts/data files come to exist).
#    This creates data/ — keep it private:
node bin/pinz-admin.js user add charles.lobo
chmod 700 data

# 3. Smoke-test by hand once (Ctrl-C when satisfied)
NODE_ENV=production mise run start   # then: curl -sI http://127.0.0.1:7469/  → 302 /login

# 4. Service
sudo cp server-setup/pinz.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pinz

# 5. nginx + TLS
sudo cp server-setup/pinz.nginx.conf /etc/nginx/sites-available/pinz.charleslobo.com
sudo ln -sf /etc/nginx/sites-available/pinz.charleslobo.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d pinz.charleslobo.com   # adds TLS + 80→443 redirect

# 6. Verify (below), then optionally set your picture:
node bin/pinz-admin.js image set charles.lobo <file>
node bin/pinz-admin.js image position charles.lobo "50% 20%"
```

## Redeploy

From the repo root on your dev machine:

```bash
./server-setup/deploy.sh
```

Pushes master, then the server hard-resets to origin/master, reinstalls deps
from the lockfile, restarts the service, and health-checks `/login`. `data/`
(bookmarks, users, .secret, images) is gitignored and survives untouched.

## Verify

```bash
curl -sI https://pinz.charleslobo.com/            # 302 → /login
curl -sI https://pinz.charleslobo.com/login       # 200
curl -si -d 'username=x&password=y' https://pinz.charleslobo.com/login | head -1   # 401 after ~500ms
# Log in from a browser: cookie must show Secure + HttpOnly; pin a link;
# check it landed: ssh in and `cat /home/noah/pinz/data/charles.lobo.yml`
# Reboot test: sudo reboot; after ~60s everything above passes again.
```

## Logs

```bash
journalctl -u pinz -f
sudo tail -f /var/log/nginx/error.log
```

## Backups

All state is one small directory of text + images. Nightly cron on the server
(crontab -e), keeping 30:

```cron
50 3 * * * cd /home/noah/pinz && mkdir -p backups && tar czf backups/data-$(date +\%Y\%m\%d).tgz data && ls -t backups/data-*.tgz | tail -n +31 | xargs rm -f
```

Pull a snapshot to your machine whenever (lands in ../devops/backups/):

```bash
mise run server:backup
```

(`backups/` on the server is gitignored, like `data/`.)

## Admin from your machine

Convention: bare mise tasks act locally, `server:*` tasks touch production.

```bash
mise run server:admin -- user list
mise run server:admin -- user passwd charles.lobo
mise run server:image -- photo.jpg "50% 20%"
mise run server:deploy
```

(Raw ssh needs `/usr/bin/mise exec -- node ...` — mise isn't on PATH in
non-interactive shells.)
