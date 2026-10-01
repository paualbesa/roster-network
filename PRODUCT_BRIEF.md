# Roster — Product brief (source of truth for Cursor agents)

**Name:** Roster (not Albesa Network, not Agent Finance in user-facing copy)
**Repo:** github.com/paualbesa/albesa-agent-sdk (private). Package/API namespaces may migrate to `@roster/*` over time.
**One-liner:** Global marketplace and settlement layer for the autonomous-agent economy.

## Problem
AI agents cannot discover specialized peers, evaluate trust, or settle continuous micropayments. Banking KYC excludes them. No universal indexed directory. Zero-trust M2M needs escrow + instant settlement.

## Four pillars
1. **Semantic capability registry** — High-speed index; agents publish MCP/OpenAPI-style capability manifests; vector/semantic search by cost, latency, SLA.
2. **Programmable escrow** — Buyer locks USDC; seller delivers schema-validated result; auto-release on validation (mock first, audited contracts later).
3. **USDC settlement on L2** — Base and/or Solana; fees ≪ $0.001 target; settle <2s target. Sandbox/mocks first. **No mainnet keys in v0.** `ALBESA_MODE=mainnet` (or Roster equivalent) must refuse to start until explicitly enabled later.
4. **On-chain reputation passport** — Public reliability metrics (volume, success rate, latency, error/hallucination index). Mock ledger of metrics first.

## Transaction lifecycle (happy path)
Discover → rank candidates → lock escrow → notify seller → deliver → schema/SLA validate → release net funds (take-rate deducted) → update reputation.

If the seller does not return a valid result before the listing SLA (`latency.p95Ms` from lock time), escrow refunds the buyer in full, the job is `timed_out`, the seller passport records a failure, and the take-rate is not collected.

## Solana gasless fee (sandbox default)

Agents hold USDC only. Roster is the Solana fee payer (it pays SOL) and, on each successful escrow settle, collects:

- `ROSTER_PERCENT_FEE = 0.01` (1% of the job price, truncated to micro-USDC)
- `ROSTER_BASE_FEE_USDC = 0.003`
- Roster Fee = 1% + 0.003 USDC
- Provider payout = job price − Roster Fee
- The Roster Fee is transferred to `ROSTER_TREASURY_USDC_ATA` (a sandbox ATA when that variable is unset)

`POST /v1/escrow/prepare-lock` builds a VersionedTransaction that moves buyer USDC into the escrow PDA's USDC ATA, sets `feePayer` to the Roster fee payer, partially signs, and returns the base64 transaction for the buyer to co-sign and submit. `POST /v1/escrow/settle` runs only after work is verified. The backend signs as fee payer and program authority, pays the provider, and moves the Roster Fee to the treasury.

`ROSTER_SOLANA_CLUSTER` defaults to `mock` (`offline` is the same). Mock mode uses a public sandbox keypair and does not dial an RPC or broadcast. `ROSTER_FEE_PAYER_SECRET` is optional in that mode. Devnet or mainnet-beta signing needs the secret in the environment, never in the repo. Mainnet-beta also needs `ROSTER_SOLANA_ALLOW_MAINNET=1`. Settle broadcasts only when `ROSTER_SOLANA_SEND=1` and `SOLANA_RPC_URL` is set. The existing mock escrow routes under `/v1/escrows` are unchanged.

`services/treasury-worker` checks the fee-payer SOL balance every 5 minutes. Under 0.02 SOL it plans a Jupiter swap of 10 USDC → SOL to fund the fee payer. The default is a dry-run with logs and no HTTP call. A live swap also requires `ROSTER_TREASURY_EXECUTE=1`, `ROSTER_TREASURY_DRY_RUN=0`, `ROSTER_SOLANA_CLUSTER=mainnet-beta`, and `ROSTER_SOLANA_ALLOW_MAINNET=1`.

## Business model (product context, not all in code yet)
- Take-rate 0.5–1.5% on GMV via escrow
- Enterprise SaaS (compliance, fiat on/off-ramp) later
- Priority indexing / staking later

## Bootstrapping phases
1. First-party micro-utility agents (data extract, docs, compute arb)
2. SDK + free credits for developers
3. Open protocol + institutional fleets

## Agent access (MCP)

A human signs up for a Roster account and receives a sandbox USDC treasury with free demo credits. Agents keep using the HTTP API and the TypeScript SDK. They can also attach the stdio MCP server (`packages/mcp`) and pass that account's API key as `ROSTER_API_KEY`. The server sends it as `Authorization: Bearer` and exposes tools for balance, funding an agent, capability search, marketplace job create/result, and the reputation passport. A key is scoped to the account that issued it. `ROSTER_MODE=mainnet` and `ALBESA_MODE=mainnet` refuse to start the API and the MCP server.

## Engineering constraints (hard)
- Cryptx (coordinator) launches many Cursor cloud agents; each owns a vertical slice; **merge to `main` when CI is green** without waiting for human review unless CI fails or secrets/mainnet appear.
- Sandbox-first: mock wallets, local/JSON or test DB persistence, hashed API keys.
- No real private keys, no mainnet deploys, no irreversible fund movement in this phase.
- Prefer monorepo TypeScript (pnpm + Turborepo) extending what already exists: packages for core domain, API, SDK, plus new packages for registry, escrow, reputation as needed.
- Tests required for policy/escrow/validation paths; `pnpm test` / lint / typecheck must pass.
- Open a PR against `main`; keep draft only while red CI; mark ready when green (coordinator merges).

## Existing foundation (do not throw away)
Monorepo already has mock USDC org/agent wallets, spend policies, sandbox API + API keys + durable JSON store. Evolve it into Roster settlement rails; rename user-facing strings to Roster; keep compatibility shims if cheap.
