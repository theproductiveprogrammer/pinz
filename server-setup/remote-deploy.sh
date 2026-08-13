#!/bin/bash
# Runs on the server. Invoked by ./server-setup/deploy.sh over SSH with a PTY,
# so the first `sudo` prompts for a password; subsequent sudos use the cache.
# deploy.sh already hard-reset this checkout to origin/master, so no pull here.
set -eux

cd /home/noah/pinz

# Toolchain (node lts per mise.toml) + exact deps from the committed lockfile.
# Full path — mise isn't on PATH in non-interactive SSH shells.
/usr/bin/mise install
/usr/bin/mise exec -- npm ci --omit=dev

sudo systemctl restart pinz

sleep 2
sudo journalctl -u pinz -n 30 --no-pager

curl -fsS -o /dev/null https://pinz.charleslobo.com/login && echo "pinz OK"
sudo systemctl status --no-pager -n 0 pinz || true
