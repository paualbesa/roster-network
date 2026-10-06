#!/usr/bin/env bash
# Deploy the Roster HTTP API on the Albesa server.
# Enables pnpm, installs, builds packages/api, and serves it with PM2 on 127.0.0.1:7001.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use 20 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
fi

echo "== git pull =="
git pull --ff-only origin main

echo "== enable pnpm =="
corepack enable
corepack prepare pnpm@10.33.3 --activate
if ! command -v pnpm >/dev/null 2>&1; then
  echo "FATAL: pnpm is not on PATH after corepack" >&2
  exit 1
fi

echo "== pnpm install =="
pnpm install --frozen-lockfile

echo "== build packages/api =="
# The API serves remote MCP at /mcp from packages/mcp/dist, and @albesa/mcp only
# dev-depends on @albesa/api, so build its workspace deps, then mcp, then the API.
pnpm --filter "@albesa/api^..." build
pnpm --filter "@albesa/sdk" build
pnpm --filter "@albesa/mcp" build
pnpm --filter "@albesa/api" build

SERVER_JS="$ROOT/packages/api/dist/server.js"
if [ ! -f "$SERVER_JS" ]; then
  echo "FATAL: API server not found at $SERVER_JS" >&2
  exit 1
fi

if [ -n "${ROSTER_DATA_DIR:-}" ]; then
  DATA_DIR="$ROSTER_DATA_DIR"
elif [ -d /home/ats-server/albesa ]; then
  DATA_DIR="/home/ats-server/albesa/roster-data"
else
  DATA_DIR="$ROOT/data"
fi

echo "== data dir $DATA_DIR =="
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Sandbox only. Do not forward a shell key or a mainnet switch into PM2.
# ROSTER_ADMIN_TOKEN is kept when the operator exported it. The value is not printed.
# Optional Devnet rail: source roster-data/solana-devnet.env when present.
SOLANA_ENV="$DATA_DIR/solana-devnet.env"
if [ -f "$SOLANA_ENV" ]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1091
  source "$SOLANA_ENV"
  set +a
  echo "note: sourced solana-devnet.env (rail=${ROSTER_WALLET:-${ROSTER_RAIL:-unset}})"
fi
unset ROSTER_API_KEY ALBESA_API_KEY ALBESA_MODE || true
case "${ROSTER_WALLET:-${ROSTER_RAIL:-mock}}" in
  solana-devnet|solana_devnet|devnet)
    export ROSTER_WALLET=solana-devnet
    export ROSTER_RAIL=solana-devnet
    ;;
  *)
    unset ROSTER_WALLET ALBESA_WALLET ROSTER_RAIL || true
    ;;
esac
if [ -z "${ROSTER_ADMIN_TOKEN:-}" ]; then
  echo "note: ROSTER_ADMIN_TOKEN is unset, so /v1/admin stays disabled"
else
  echo "note: ROSTER_ADMIN_TOKEN is set and will be passed to roster-api"
fi
export ROSTER_MODE=sandbox
export HOST=127.0.0.1
export PORT=7001
export NODE_ENV=production
export ROSTER_DATA_DIR="$DATA_DIR"
export ALBESA_DATA_FILE="$DATA_DIR/sandbox.json"
export ROSTER_REPUTATION_FILE="$DATA_DIR/reputation.json"
export REGISTRY_INDEX_PATH="$DATA_DIR/registry.json"
export ROSTER_JOBS_FILE="$DATA_DIR/jobs.json"
ROSTER_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
export ROSTER_GIT_SHA
echo "note: releasing $ROSTER_GIT_SHA"

if [ -n "${SUPABASE_URL:-}${SUPABASE_ANON_KEY:-}${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    echo "FATAL: SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must all be set, or all left unset." >&2
    exit 1
  fi
  echo "note: Supabase persistence is enabled (keys are not printed)"
else
  echo "note: Supabase env is unset; roster-api keeps the JSON files"
fi

echo "== pm2 =="
if pm2 describe roster-api >/dev/null 2>&1; then
  pm2 restart "$ROOT/ecosystem.config.cjs" --only roster-api --update-env
else
  pm2 start "$ROOT/ecosystem.config.cjs" --only roster-api
fi
pm2 save

echo "== health http://127.0.0.1:7001/health =="
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  body=""
  if body="$(curl -fsS "http://127.0.0.1:7001/health" 2>/dev/null)" \
    && printf '%s' "$body" | grep -q '"product":"Roster"'; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "roster-api did not answer http://127.0.0.1:7001/health" >&2
  pm2 status roster-api || true
  exit 1
fi
echo "http://127.0.0.1:7001/health ok"
