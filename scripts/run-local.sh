#!/usr/bin/env bash
# scripts/run-local.sh — Lane F. Build, boot the funnel locally against the
# stub server + local D1, run the smoke gates. Non-zero exit on any red gate.
#
#   ./scripts/run-local.sh            # full pass
#   BREAK=dedup ./scripts/run-local.sh  # prove a gate goes red
#   SKIP_BUILD=1 ./scripts/run-local.sh # reuse the last build
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
STUB_PORT="${STUB_PORT:-8788}"
PERSIST=".wrangler-local"

if [ -z "${SKIP_BUILD:-}" ]; then
  npm run build
fi

# .dev.vars must sit next to the wrangler config wrangler dev is given
if [ ! -f .dev.vars ]; then cp .dev.vars.example .dev.vars; fi
cp .dev.vars dist/server/.dev.vars

# fresh local D1 with migrations applied
rm -rf "$PERSIST"
npx wrangler d1 migrations apply hottublaunch-b2b --local --persist-to "$PERSIST" -c dist/server/wrangler.json >/dev/null

node scripts/stub-server.mjs "$STUB_PORT" &
STUB_PID=$!
npx wrangler dev -c dist/server/wrangler.json --port "$PORT" --persist-to "$PERSIST" --show-interactive-dev-session=false &
DEV_PID=$!
trap 'kill $STUB_PID $DEV_PID 2>/dev/null || true' EXIT

# wait for the worker
for i in $(seq 1 60); do
  if curl -sf -o /dev/null -H 'Accept: text/html' "http://127.0.0.1:$PORT/"; then break; fi
  sleep 1
  if [ "$i" = 60 ]; then echo 'wrangler dev never came up'; exit 1; fi
done

BASE_URL="http://127.0.0.1:$PORT" STUB_URL="http://127.0.0.1:$STUB_PORT" PERSIST_DIR="$PERSIST" \
  BREAK="${BREAK:-}" node scripts/smoke.mjs
