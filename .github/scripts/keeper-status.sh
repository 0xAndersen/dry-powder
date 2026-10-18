#!/usr/bin/env bash
# Every 5 minutes, publishes to the "status" branch:
#   status/keeper.json  the keeper's /health JSON (stats only, no keys), so the venue's health can be read without
#                       access to the Actions log;
#   status/stats.json   venue, market and trader statistics from keeper/src/indexer.mjs, which continues from the
#                       stats.json already on the branch (the app's leaderboard, portfolio and trader pages read it).
# Each publish is a single commit with no parent, force-pushed: the branch holds the latest snapshot only, so a
# stats file that changes every 5 minutes does not grow the repository.
# Run from keeper/ (the keeper workflow does), with DEPLOYMENT pointing at the deployment file.
set -u
keeper_dir=$(pwd)
deployment=$(realpath "${DEPLOYMENT:-../deployments/arc-testnet.json}")
dir=$(mktemp -d)
git fetch -q origin status 2>/dev/null && git worktree add -q "$dir" FETCH_HEAD 2>/dev/null || { git worktree add -q --detach "$dir"; (cd "$dir" && git checkout -q --orphan status && git rm -rq . 2>/dev/null); }
cd "$dir"
git config user.name "dry-powder-keeper"
git config user.email "actions@users.noreply.github.com"
mkdir -p status
sleep 90
while true; do
  curl -fsS "http://127.0.0.1:${PORT:-8080}/health" -o status/keeper.json || echo '{"ok":false,"error":"health endpoint unreachable"}' > status/keeper.json
  # Bounded, so a long first back-fill spreads over several rounds instead of delaying keeper.json.
  DEPLOYMENT="$deployment" STATS_FILE="$dir/status/stats.json" MAX_SECONDS="${INDEXER_MAX_SECONDS:-120}" \
    node "$keeper_dir/src/indexer.mjs" || echo "indexer run failed; the previous stats.json stays published"
  git add status/keeper.json
  if test -f status/stats.json; then git add status/stats.json; fi
  commit=$(git commit-tree "$(git write-tree)" -m "status $(date -u +%FT%TZ)") && git push -q -f origin "$commit:refs/heads/status" || true
  sleep 300
done
