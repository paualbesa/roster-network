#!/usr/bin/env bash
# Deploy roster-escrow to Solana DEVNET using the server fee-payer.
# Never prints key material. Requires solana CLI + funded fee-payer.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${ROSTER_DATA_DIR:-/home/ats-server/albesa/roster-data}"
SOLANA_ENV="$DATA_DIR/solana-devnet.env"
SO="$ROOT/programs/roster-escrow/deploy/roster_escrow.so"
# Keypair staged next to .so on the server (not in git). Fall back to target/deploy.
KP="${ROSTER_ESCROW_PROGRAM_KEYPAIR:-}"
if [ -z "$KP" ]; then
  if [ -f "$DATA_DIR/roster-escrow-program-keypair.json" ]; then
    KP="$DATA_DIR/roster-escrow-program-keypair.json"
  elif [ -f "$ROOT/programs/roster-escrow/deploy/roster_escrow-keypair.json" ]; then
    KP="$ROOT/programs/roster-escrow/deploy/roster_escrow-keypair.json"
  elif [ -f "$ROOT/target/deploy/roster_escrow-keypair.json" ]; then
    KP="$ROOT/target/deploy/roster_escrow-keypair.json"
  fi
fi

if [ ! -f "$SO" ]; then
  echo "FATAL: missing $SO — build with cargo-build-sbf first" >&2
  exit 1
fi
if [ -z "${KP:-}" ] || [ ! -f "$KP" ]; then
  echo "FATAL: program keypair not found. Place it at $DATA_DIR/roster-escrow-program-keypair.json" >&2
  exit 1
fi

if [ -f "$SOLANA_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$SOLANA_ENV"
  set +a
fi

FEE_PAYER="${ROSTER_FEE_PAYER_KEYPAIR:-$DATA_DIR/solana-devnet-fee-payer.json}"
RPC="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
PROGRAM_ID="$(solana-keygen pubkey "$KP")"

SIZE=$(stat -c%s "$SO")
RENT_SOL=$(solana rent "$SIZE" -u "$RPC" | awk '/Rent-exempt minimum/{print $3}')
BAL=$(solana balance -k "$FEE_PAYER" -u "$RPC" | awk '{print $1}')
echo "program_id=$PROGRAM_ID"
echo "so_bytes=$SIZE rent_approx_sol=$RENT_SOL fee_payer_sol=$BAL"
# Need ~2x rent for upgradeable buffer during deploy
python3 - <<PY
bal=float("$BAL"); rent=float("$RENT_SOL")
need=rent*2.2+0.05
print(f"estimated_need_sol={need:.4f}")
if bal < need:
    raise SystemExit(f"FATAL: fee-payer SOL {bal} < estimated deploy cost {need:.4f}")
PY

echo "== solana program deploy (devnet) =="
solana program deploy "$SO" \
  --program-id "$KP" \
  --keypair "$FEE_PAYER" \
  --url "$RPC" \
  --max-len "$SIZE"

echo "== write program id into solana-devnet.env (idempotent) =="
touch "$SOLANA_ENV"
if grep -q '^ROSTER_ESCROW_PROGRAM_ID=' "$SOLANA_ENV" 2>/dev/null; then
  sed -i "s|^ROSTER_ESCROW_PROGRAM_ID=.*|ROSTER_ESCROW_PROGRAM_ID=$PROGRAM_ID|" "$SOLANA_ENV"
else
  printf '\n# Non-custodial escrow program (DEVNET)\nROSTER_ESCROW_PROGRAM_ID=%s\n' "$PROGRAM_ID" >> "$SOLANA_ENV"
fi
# Do not force-enable noncustodial-devnet here — leave ROSTER_ESCROW_MODE as operator choice.
echo "deployed program_id=$PROGRAM_ID"
solana balance -k "$FEE_PAYER" -u "$RPC"

echo "note: run scripts/e2e-escrow-devnet.mjs after API build to InitializeConfig + E2E"
