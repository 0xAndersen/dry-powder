#!/usr/bin/env bash
# Whole-system check with the production keeper: local chain + contracts + mock Kraken + scripted traders,
# with keeper/src/main.mjs (not the test bot) publishing prices and executing, then the UI run.
# The dated market settles 20 s after expiry so the UI can show the expired state; epoch settlement is left to the UI here (the test clicks "Settle epoch"); the keeper does it in production.
#
#   frontend/e2e/with-keeper.sh            # from the repo root; needs anvil, forge build, npm ci in frontend + keeper
set -euo pipefail
cd "$(dirname "$0")/.."
LOGS=${LOGS:-e2e/out}
mkdir -p "$LOGS"
# Anvil's well-known development account #2, which the local deploy registers as the publisher. Local chain only.
BOT_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

EXTERNAL_KEEPER=1 TRADERS=${TRADERS:-12} node e2e/stack.mjs > "$LOGS/stack.log" 2>&1 &
STACK=$!
cleanup() { kill "$KEEPER" "$STACK" 2>/dev/null || true; wait 2>/dev/null || true; }
KEEPER=0
trap cleanup EXIT
for _ in $(seq 1 60); do grep -q "ready:" "$LOGS/stack.log" && break; sleep 2; done
grep -q "ready:" "$LOGS/stack.log" || { cat "$LOGS/stack.log"; exit 1; }

( cd ../keeper && DEPLOYMENT=../frontend/e2e/.state/addresses.json RPC_URL=http://127.0.0.1:8645 CHAIN_ID=31337 \
  KRAKEN_URL=http://127.0.0.1:8647 PUBLISHER_KEY=$BOT_KEY KEEPER_KEY=$BOT_KEY MIN_FEE_GWEI=2 STALE_FEED_MS=4000 \
  HEARTBEAT_SECONDS=20 SETTLE_EPOCHS=0 SETTLE_MARKET_DELAY_SECONDS=20 exec node src/main.mjs ) > "$LOGS/keeper.log" 2>&1 &
KEEPER=$!
sleep 30
node e2e/run.mjs
# The MCP server, driven through a real MCP client from an agent account on the same chain.
if [ -d ../mcp/node_modules ]; then (cd ../mcp && node test/smoke.mjs); fi
grep -q '"errors":{}' <(tail -1 "$LOGS/keeper.log") || echo "keeper reported errors: $(tail -1 "$LOGS/keeper.log")"
