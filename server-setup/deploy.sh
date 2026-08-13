#!/bin/bash
# Deploy pinz to production. Pushes master, then SSHes to the server with a
# PTY and runs server-setup/remote-deploy.sh (you enter the sudo password
# once per deploy). Same pattern as throughglass's deploy.sh, plus the push —
# pinz has no ver.sh doing it beforehand.
set -eux

SERVER=noah@134.122.127.41

git push origin master

# Hard-reset the server checkout to origin/master: immune to tracked files
# the server dirtied locally. Gitignored state (data/, node_modules/) is
# untouched — the bookmarks live in data/ and survive every deploy.
ssh -t "$SERVER" "cd pinz && git fetch origin && git reset --hard origin/master && ./server-setup/remote-deploy.sh"
