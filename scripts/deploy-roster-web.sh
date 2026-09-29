#!/usr/bin/env bash
# Deploy the Roster marketing site on the Albesa server.
# Enables pnpm, installs, builds apps/web, and serves it with PM2 on 127.0.0.1:7000.
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

echo "== build apps/web =="
pnpm --filter web build

NEXT_BIN="$ROOT/apps/web/node_modules/next/dist/bin/next"
if [ ! -f "$NEXT_BIN" ]; then
  echo "FATAL: next binary not found at $NEXT_BIN" >&2
  exit 1
fi

echo "== pm2 =="
if pm2 describe roster-web >/dev/null 2>&1; then
  pm2 restart roster-web --update-env
else
  pm2 start "$ROOT/ecosystem.config.cjs"
fi
pm2 save

echo "== health http://127.0.0.1:7000/ =="
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS -o /dev/null "http://127.0.0.1:7000/"; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "roster-web did not answer http://127.0.0.1:7000/" >&2
  pm2 status roster-web || true
  exit 1
fi
echo "http://127.0.0.1:7000/ ok"
