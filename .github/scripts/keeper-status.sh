#!/usr/bin/env bash
# Publishes the keeper's /health JSON (stats only, no keys) to status/keeper.json on the "status" branch every
# 5 minutes, so the venue's health can be read without access to the Actions log.
set -u
dir=$(mktemp -d)
git fetch -q origin status 2>/dev/null && git worktree add -q "$dir" FETCH_HEAD 2>/dev/null || { git worktree add -q --detach "$dir"; (cd "$dir" && git checkout -q --orphan status && git rm -rq . 2>/dev/null); }
cd "$dir"
git config user.name "dry-powder-keeper"
git config user.email "actions@users.noreply.github.com"
mkdir -p status
sleep 90
while true; do
  curl -fsS "http://127.0.0.1:${PORT:-8080}/health" -o status/keeper.json || echo '{"ok":false,"error":"health endpoint unreachable"}' > status/keeper.json
  git add status/keeper.json
  git commit -q -m "keeper status $(date -u +%FT%TZ)" && git push -q -f origin HEAD:status || true
  sleep 300
done
