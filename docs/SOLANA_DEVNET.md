# Solana Devnet settlement rail (sandbox)

Roster can settle sandbox jobs on **real Solana Devnet** alongside the default `mock` rail.

## Selection

| Env | Effect |
| --- | --- |
| unset / `ROSTER_RAIL=mock` | Default mock USDC ledger (no chain). |
| `ROSTER_RAIL=solana-devnet` or `ROSTER_WALLET=solana-devnet` | Real Devnet SPL transfers + explorer signatures. |

On the Albesa server, deploy sources `/home/ats-server/albesa/roster-data/solana-devnet.env` when present (see `scripts/setup-solana-devnet.sh` and `ecosystem.config.cjs`). Comment out `ROSTER_*` lines in that file to fall back to mock without deleting the keypair.

## Fee payer / treasury

- Keypair is generated **on the server only** under `roster-data/solana-devnet-fee-payer.json` (`chmod 600`).
- Never commit the secret; never print it.
- Public key is reported by `/health` → `solana.feePayer` and by the setup script.
- Live sandbox treasury pubkey: `8s1QdYzbHkoMthqzuX1mzb9A1PaQZw8SPWV5Jz5iyZjW` (Explorer: [devnet](https://explorer.solana.com/address/8s1QdYzbHkoMthqzuX1mzb9A1PaQZw8SPWV5Jz5iyZjW?cluster=devnet)).

## Asset

Circle’s public Devnet USDC faucet is not automatable. The rail mints a **Roster test SPL** (6 decimals, USDC-shaped) with the fee payer as mint authority. Explorer links are labeled **devnet** (`?cluster=devnet`).

## Airdrop / rate limits

Boot calls `requestAirdrop` for fee-payer SOL (fees + rent for mint/ATAs).

- Public RPC faucets (`api.devnet.solana.com`, faucet.solana.com) are **heavily rate-limited** (e.g. ~2 requests / 8 hours on the web faucet; RPC often returns 429 / “faucet has run dry”).
- When airdrop fails, the API **stays up**:
  - Soft credits park sandbox grants in an in-process ledger so org creation does not hard-fail.
  - Fleet bootstrap **skips** treasury→agent fund if the rail cannot settle (warns; listings still bind).
  - On-chain hire → release still needs fee-payer SOL; fund manually then restart with `solana-devnet.env` enabled.
- Manual fund: https://faucet.solana.com (select **Devnet**) → paste the fee-payer pubkey above.
- Alternatives: Helius/QuickNode/Triton Devnet RPC airdrops, [Solana cookbook faucets](https://solana.com/developers/cookbook/development/airdrops-and-faucets).

Mock remains the default when `solana-devnet.env` is absent or commented out.

## Health

`GET /health` includes `rail` and, when `solana-devnet` is active, a `solana` block (`feePayer`, `mint`, `feePayerSol`, `airdropOk`, `airdropError`, label).

## Setup

```bash
# on the API host, from the repo root (needs @solana/web3.js on PATH via pnpm)
ROSTER_DATA_DIR=/home/ats-server/albesa/roster-data bash scripts/setup-solana-devnet.sh
# then deploy roster-api (ecosystem loads solana-devnet.env)
```
