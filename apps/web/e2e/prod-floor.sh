#!/usr/bin/env bash
# Isolated PROD-build studio e2e floor (§A2 of the studio-hardening plan).
#
# WHY: the default floor hits the dev server over the tunnel — un-minified
# bundles re-downloaded per fresh browser context saturate the single dev
# server, so the 40-test studio sweep flakes (120s hydration timeouts, preview
# races) and is "green only on retry". This stands up a self-contained, minified
# prod build on http://127.0.0.1 with its OWN api (non-Secure cookies over http)
# so each page load is fast + deterministic and the sweep passes at --retries=0.
#
# Stack (all on free local ports, isolated from the live :3000/:4000 dev stack
# and the test DB the integration suite already migrates):
#   - test api  :4310 (metrics :4311) → seed_test DB, BETTER_AUTH_URL=http://…
#     so it issues a non-Secure session cookie that works over http.
#   - prod web  :3209 → DIST_DIR=.next-floor, NEXT_PUBLIC_API_URL=the test api.
#
# Usage:
#   apps/web/e2e/prod-floor.sh            # build if stale, then run the sweep
#   BUILD=1 apps/web/e2e/prod-floor.sh    # force a rebuild first
#   apps/web/e2e/prod-floor.sh -g "E2"    # pass extra args to playwright
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WEB="$ROOT/apps/web"
API="$ROOT/apps/api"

API_PORT=4310 ; API_METRICS_PORT=4311 ; WEB_PORT=3209
API_BASE="http://127.0.0.1:${API_PORT}"
WEB_BASE="http://127.0.0.1:${WEB_PORT}"
# A release floor may provide a separately isolated PostgreSQL instance. Keep
# the historical local default for existing studio callers, but do not force
# Boards release tests onto it.
DB_URL="${TEST_DATABASE_URL:-postgres://seed:CHANGE_ME_HEX24@127.0.0.1:5434/seed_test}"
TEST_REDIS_URL="${TEST_REDIS_URL:-${REDIS_URL:-redis://127.0.0.1:6380}}"

api_env=(
  API_PORT=$API_PORT API_METRICS_PORT=$API_METRICS_PORT
  BETTER_AUTH_URL=$API_BASE
  BETTER_AUTH_TRUSTED_ORIGINS=$WEB_BASE,$API_BASE
  CORS_ORIGIN=$WEB_BASE,$API_BASE
  DATABASE_URL=$DB_URL
  REDIS_URL=$TEST_REDIS_URL
  NODE_ENV=development
)
web_build_env=(
  DIST_DIR=.next-floor
  NEXT_PUBLIC_API_URL=$API_BASE
  BETTER_AUTH_URL=$API_BASE
  WEB_PUBLIC_URL=$WEB_BASE
  NEXT_PUBLIC_WEB_URL=$WEB_BASE
  NODE_ENV=production
)

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_health() { # url, name
  for _ in $(seq 1 60); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "✗ $2 never became healthy at $1" >&2; return 1
}

wait_performance_load() {
  local max_load="$1"
  local timeout_seconds="${BOARDS_PERF_SETTLE_TIMEOUT_SECONDS:-300}"
  local elapsed=0 load1
  while (( elapsed <= timeout_seconds )); do
    read -r load1 _ < /proc/loadavg
    if awk -v current="$load1" -v maximum="$max_load" \
      'BEGIN { exit !(current <= maximum) }'; then
      echo "▶ performance host eligible after build (load1=$load1 ≤ $max_load)"
      return 0
    fi
    if (( elapsed % 30 == 0 )); then
      echo "… waiting for performance host to settle (load1=$load1 > $max_load)"
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "✗ performance host did not settle below load1=$max_load in ${timeout_seconds}s" >&2
  return 1
}

# 1) test api (reuse if already serving seed_test on :4310)
if ! curl -sf "$API_BASE/health" >/dev/null 2>&1; then
  echo "▶ starting test api on :$API_PORT (seed_test)…"
  ( cd "$API" && env "${api_env[@]}" pnpm exec tsx src/server.ts ) >/tmp/prod-floor-api.log 2>&1 &
  pids+=("$!")
  wait_health "$API_BASE/health" "test api"
fi

# 2) prod build (if forced or missing)
if [[ "${BUILD:-0}" == "1" || ! -d "$WEB/.next-floor" ]]; then
  echo "▶ building prod web → .next-floor…"
  ( cd "$WEB" && env "${web_build_env[@]}" pnpm exec next build )
fi

# A production build is intentionally CPU-heavy and can contaminate the
# one-minute load used to qualify a performance sample. Wait at the actual
# measurement boundary, after build and before starting the browser workload.
if [[ -n "${BOARDS_PERF_MAX_LOAD:-}" ]]; then
  wait_performance_load "$BOARDS_PERF_MAX_LOAD"
fi

# 3) prod web. Pass the api/auth env at RUNTIME too — NEXT_PUBLIC_* is inlined at
# build, but any server-side fetch reads process.env at runtime and would
# otherwise fall back to the tunnel from .env.local.
echo "▶ starting prod web on :$WEB_PORT…"
( cd "$WEB" && env DIST_DIR=.next-floor NODE_ENV=production \
    NEXT_PUBLIC_API_URL=$API_BASE BETTER_AUTH_URL=$API_BASE \
    WEB_PUBLIC_URL=$WEB_BASE NEXT_PUBLIC_WEB_URL=$WEB_BASE \
    pnpm exec next start -H 127.0.0.1 -p $WEB_PORT ) >/tmp/prod-floor-web.log 2>&1 &
pids+=("$!")
wait_health "$WEB_BASE/" "prod web"

# 4) run the studio floor against the prod stack at --retries=0. The readiness
# mode reuses the exact same isolated stack for the dedicated cross-browser /
# device + local-draft recovery matrix.
echo "▶ running studio floor against $WEB_BASE …"
cd "$WEB"
if [[ "${BOARDS_RELEASE:-0}" == "1" ]]; then
  env WEB_PUBLIC_URL=$WEB_BASE \
      BETTER_AUTH_URL=$API_BASE \
      API_URL=$API_BASE \
      NEXT_PUBLIC_API_URL=$API_BASE \
      GOD_EMAIL=god@seed.local \
      pnpm exec playwright test "$@"
elif [[ "${STUDIO_READINESS:-0}" == "1" ]]; then
  env WEB_PUBLIC_URL=$WEB_BASE \
      BETTER_AUTH_URL=$API_BASE \
      API_URL=$API_BASE \
      NEXT_PUBLIC_API_URL=$API_BASE \
      pnpm exec playwright test --config playwright.studio-readiness.config.ts "$@"
else
  env WEB_PUBLIC_URL=$WEB_BASE \
      BETTER_AUTH_URL=$API_BASE \
      API_URL=$API_BASE \
      NEXT_PUBLIC_API_URL=$API_BASE \
      GOD_EMAIL=god@seed.local \
      pnpm exec playwright test --project=studio "$@"
fi
