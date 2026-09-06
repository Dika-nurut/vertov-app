#!/usr/bin/env bash
# /scenario e2e happy path on the prod-floor pattern, with the assist gateway
# MOCKED (OPENROUTER_URL → mock-openrouter.mjs) so it runs with ZERO live spend.
#
# Stack (isolated local ports; mirrors prod-floor.sh + a mock gateway):
#   - mock openrouter :4399  (streams a canned <rewrite> proposal)
#   - test api        :4310  (seed_test DB, OPENROUTER_URL=mock, non-Secure cookies)
#   - prod web        :3209  (DIST_DIR=.next-floor)
# Flow: create → type → autosave → select → ask → apply → export .fountain.
#
# Usage:
#   apps/web/e2e/scenario-floor.sh          # build if stale, then run
#   BUILD=1 apps/web/e2e/scenario-floor.sh  # force a rebuild first
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WEB="$ROOT/apps/web"; API="$ROOT/apps/api"
API_PORT="${API_PORT:-4310}"; API_METRICS_PORT="${API_METRICS_PORT:-4311}"
WEB_PORT="${WEB_PORT:-3209}"; MOCK_PORT="${MOCK_PORT:-4399}"
API_BASE="http://127.0.0.1:${API_PORT}"; WEB_BASE="http://127.0.0.1:${WEB_PORT}"

# seed_test URL derived from the repo .env (same server as the dev DB).
ENV_FILE="$ROOT/.env"
[[ -f "$ENV_FILE" ]] || ENV_FILE="/opt/ai-workspace/seed/.env"
BASE_DB="$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
TEST_DB_NAME="${TEST_DB_NAME:-seed_test}"
DB_URL="${BASE_DB%/*}/${TEST_DB_NAME}"
FLOOR_REDIS_URL="${FLOOR_REDIS_URL:-redis://127.0.0.1:6380/14}"

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
wait_health() { for _ in $(seq 1 60); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done; echo "✗ $2 unhealthy"; return 1; }

echo "▶ migrating ${TEST_DB_NAME}…"
( cd "$ROOT" && DATABASE_URL="$DB_URL" pnpm --filter @seed/db migrate >/dev/null )

echo "▶ mock openrouter on :$MOCK_PORT…"
( cd "$WEB" && MOCK_PORT=$MOCK_PORT node e2e/mock-openrouter.mjs ) >/tmp/scenario-mock.log 2>&1 &
pids+=("$!")

echo "▶ test api on :$API_PORT…"
( cd "$API" && env API_PORT=$API_PORT API_METRICS_PORT=$API_METRICS_PORT \
    BETTER_AUTH_URL=$API_BASE BETTER_AUTH_TRUSTED_ORIGINS=$WEB_BASE,$API_BASE \
    CORS_ORIGIN=$WEB_BASE,$API_BASE DATABASE_URL="$DB_URL" \
    REDIS_URL="$FLOOR_REDIS_URL" \
    OPENROUTER_URL="http://127.0.0.1:${MOCK_PORT}" OPENROUTER_API_KEY=test \
    NODE_ENV=development pnpm exec tsx src/server.ts ) >/tmp/scenario-floor-api.log 2>&1 &
pids+=("$!")
wait_health "$API_BASE/health" "test api"

echo "▶ isolated worker/outbox settlement…"
( cd "$ROOT/apps/worker" && env DATABASE_URL="$DB_URL" REDIS_URL="$FLOOR_REDIS_URL" \
    WORKER_METRICS_PORT=4312 AI_PROVIDER=mock NODE_ENV=development \
    pnpm exec tsx src/index.ts ) >/tmp/scenario-floor-worker.log 2>&1 &
pids+=("$!")
wait_health "http://127.0.0.1:4312/ready" "test worker"

if [[ "${BUILD:-0}" == "1" || ! -d "$WEB/.next-floor" ]]; then
  echo "▶ building prod web → .next-floor…"
  ( cd "$WEB" && env DIST_DIR=.next-floor NEXT_PUBLIC_API_URL=$API_BASE BETTER_AUTH_URL=$API_BASE \
      WEB_PUBLIC_URL=$WEB_BASE NEXT_PUBLIC_WEB_URL=$WEB_BASE NODE_ENV=production pnpm exec next build )
fi

echo "▶ prod web on :$WEB_PORT…"
( cd "$WEB" && env DIST_DIR=.next-floor NODE_ENV=production \
    NEXT_PUBLIC_API_URL=$API_BASE BETTER_AUTH_URL=$API_BASE \
    WEB_PUBLIC_URL=$WEB_BASE NEXT_PUBLIC_WEB_URL=$WEB_BASE \
    pnpm exec next start -H 127.0.0.1 -p $WEB_PORT ) >/tmp/scenario-floor-web.log 2>&1 &
pids+=("$!")
wait_health "$WEB_BASE/" "prod web"

echo "▶ running the /scenario happy path…"
cd "$WEB"
env WEB_PUBLIC_URL=$WEB_BASE API_URL=$API_BASE NEXT_PUBLIC_API_URL=$API_BASE \
    GOD_EMAIL=god@seed.local node e2e/_scenario-e2e.mjs

if [[ "${READINESS:-0}" == "1" ]]; then
  env WEB_PUBLIC_URL=$WEB_BASE API_URL=$API_BASE NEXT_PUBLIC_API_URL=$API_BASE \
      GOD_EMAIL=god@seed.local node e2e/_scenario-readiness.mjs
fi

if [[ "${LOAD:-0}" == "1" ]]; then
  echo "▶ running authenticated Scenario load…"
  env DEV_ACCESS="${DEV_ACCESS:-}" node "$ROOT/scripts/scenario-load.mjs" \
    --web "$WEB_BASE" --api "$API_BASE" \
    --editors "${LOAD_EDITORS:-25}" --ai "${LOAD_AI:-5}" \
    --duration "${LOAD_DURATION:-60}" \
    --output "${LOAD_OUTPUT:-/tmp/scenario-load.json}"
fi

if [[ "${PORTFOLIO:-0}" == "1" ]]; then
  env WEB_PUBLIC_URL=$WEB_BASE API_URL=$API_BASE NEXT_PUBLIC_API_URL=$API_BASE \
      GOD_EMAIL=god@seed.local pnpm exec playwright test e2e/board-scenario-source.spec.ts \
      --project=chromium --project=yandex --reporter=line
fi
