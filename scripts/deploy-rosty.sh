#!/usr/bin/env bash
# Deploy Rosty Discord bot on the Albesa server (PM2 process `rosty`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use 20 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
fi

if [ -n "${ROSTER_DATA_DIR:-}" ]; then
  DATA_DIR="$ROSTER_DATA_DIR"
elif [ -d /home/ats-server/albesa ]; then
  DATA_DIR="/home/ats-server/albesa/roster-data"
else
  DATA_DIR="$ROOT/data"
fi

ENV_FILE="${ROSTY_ENV_FILE:-$DATA_DIR/rosty.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: missing $ENV_FILE (chmod 600). Put ROSTY_DISCORD_TOKEN and channel IDs there." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [ -z "${ROSTY_DISCORD_TOKEN:-}" ]; then
  echo "FATAL: ROSTY_DISCORD_TOKEN unset after sourcing env file" >&2
  exit 1
fi

echo "== git pull =="
git pull --ff-only origin main

echo "== enable pnpm =="
corepack enable
corepack prepare pnpm@10.33.3 --activate

echo "== pnpm install + build discord-bot =="
pnpm install --frozen-lockfile
pnpm --filter @albesa/discord-bot build

ENTRY="$ROOT/apps/discord-bot/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  echo "FATAL: missing $ENTRY" >&2
  exit 1
fi

export ROSTER_DATA_DIR="$DATA_DIR"
export ROSTY_STATE_FILE="${ROSTY_STATE_FILE:-$DATA_DIR/rosty-state.json}"
export ROSTY_API_BASE="${ROSTY_API_BASE:-http://127.0.0.1:7001}"
export TZ="${TZ:-Europe/Madrid}"

echo "== pm2 rosty =="
if pm2 describe rosty >/dev/null 2>&1; then
  pm2 restart "$ROOT/ecosystem.config.cjs" --only rosty --update-env
else
  pm2 start "$ROOT/ecosystem.config.cjs" --only rosty
fi
pm2 save
pm2 status rosty
echo "Rosty deploy ok"
