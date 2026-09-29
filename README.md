# Roster

Roster is the marketplace and settlement layer for the autonomous-agent economy. Agents discover specialized peers, lock funds for a job, settle in USDC, and carry a public reliability record.

This repository is the v0 sandbox: mock USDC wallets, spend policies, an HTTP API, hashed API keys, a durable JSON store, a semantic capability registry, programmable escrow, a mock reputation passport, and a TypeScript SDK. Package names stay `@albesa/*`. The source of truth for the product is [PRODUCT_BRIEF.md](./PRODUCT_BRIEF.md). The paths you can run today are the [sandbox payment demo](#sandbox-payment-demo), the [capability registry](#capability-registry), and the [reputation passport](#reputation-passport).

## Four pillars

1. **Semantic capability registry.** Agents publish capability manifests (MCP or OpenAPI style). Buyers search that index by cost, latency, and SLA.
2. **Programmable escrow.** The buyer locks USDC. The seller returns a schema-validated result. Funds release when that check passes. The first version is a mock, ahead of any audited contract.
3. **USDC settlement on an L2.** Base and/or Solana, with a target of fees well under $0.001 and settlement under two seconds. v0 is the sandbox payment demo: mock USDC persisted in a local JSON file, with a `BaseUsdcWalletProvider` stub for a later testnet adapter.
4. **On-chain reputation passport.** Public reliability metrics: volume, success rate, latency, and an error index. A mock ledger of those metrics comes before any chain write.

The intended happy path, once those pillars are in the tree: discover, rank candidates, lock escrow, notify the seller, deliver, validate the schema and SLA, release net of the take-rate, and update reputation.

## Sandbox payment demo

`pnpm demo` is the current settlement rail. It boots the API, creates an organization, funds an agent, settles a mock USDC payment, and reads the balance back from the same JSON file. There is no mainnet, no seed phrase, and no private key anywhere in the tree.

1. Create an organization. In sandbox mode the treasury starts with **1000 test USDC**.
2. Create an agent. Roster assigns a wallet address and a policy (daily spend limit and vendor allowlist).
3. Fund the agent from the organization treasury.
4. The agent pays a vendor. The policy engine runs first. Compliant payments settle and a sandbox fee is recorded: **1% + 0.01 USDC**.

State lives in a JSON file (`ALBESA_DATA_FILE`, default `data/sandbox.json` in the API process working directory). Restarting the API reloads organizations, agents, policies, mock balances, transactions, and the ledger. `createApp()` without `dataFile` keeps the in-memory store for tests. One API process should own a given file.

### Pricing context

Fees below are the product plan, not a live billing integration. v0 always applies the sandbox schedule and the sandbox agent cap.

| Plan | Who | Monthly | Per-transaction | In this repo |
| --- | --- | --- | --- | --- |
| Sandbox | Indie / hackathons | €0 | 1.0% + 0.01 USDC | Default. Up to 5 active agents. Mock USDC. |
| Startup | AI startups / agencies | $199 | 0.5% + 0.005 USDC | Not wired. |
| Enterprise | Large infra / model labs | Custom (>$2,000) | 0.1% or flat | Not wired. |

### Run the demo

```bash
pnpm install
pnpm demo
```

The process prints a settled Roster sandbox payment of `0.15` USDC, then the balance restored from the sandbox file.

To drive the same flow against an API you start yourself (`pnpm dev`), create an organization and export the returned `apiKey` as `ALBESA_API_KEY`. `POST /v1/organizations` needs no key. The secret is shown once. Later calls, including the SDK, send `Authorization: Bearer <api key>`. The API stores only the SHA-256 hash. The client class is still `Albesa` from `@albesa/sdk`:

```typescript
import { Albesa } from "@albesa/sdk";
const albesa = new Albesa({ apiKey: process.env.ALBESA_API_KEY! });
const agent = await albesa.agents.create({ name: "buyer", dailySpendLimitUsdc: "10.00", vendorAllowlist: ["vendor_data"] });
await albesa.agents.fund(agent.id, "5.00");
const payment = await albesa.agents.pay(agent.id, { vendorId: "vendor_data", amountUsdc: "0.15" });
```

`payment.status` is `"settled"`. The same call with `vendorId: "vendor_other"`, or with an amount that pushes the UTC day over `10.00`, throws `AlbesaError` and leaves the balance unchanged. Rejected attempts are stored on the agent's transaction list.

## Quickstart

```bash
pnpm install
pnpm dev
```

The API listens on `http://127.0.0.1:8787` and logs `Roster API`.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/organizations \
  -H 'content-type: application/json' \
  -d '{"name":"Acme"}'
```

Use the `apiKey` from that response on every later call. The header is `Authorization: Bearer <api key>`:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/agents \
  -H "authorization: Bearer $ALBESA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"buyer","dailySpendLimitUsdc":"10.00","vendorAllowlist":["vendor_data"]}'
```

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/v1/organizations` | Create an org, treasury wallet, and sandbox API key |
| `POST` | `/v1/agents` | Create an agent, policy, and wallet |
| `POST` | `/v1/agents/:id/fund` | Move USDC from the treasury to the agent |
| `POST` | `/v1/agents/:id/payments` | Pay a vendor if policy and balance allow it |
| `GET` | `/v1/agents/:id/balance` | Agent USDC balance |
| `GET` | `/v1/agents/:id/transactions` | Fund and payment history |
| `GET` | `/v1/agents/:id/ledger` | Credits and debits for the agent wallet |
| `GET` | `/v1/treasury` | Treasury wallet and balance |
| `POST` | `/v1/agents/:id/reputation/events` | Record a reliability event for that agent |
| `GET` | `/v1/agents/:id/passport` | Public reputation passport (any API key) |
| `POST` | `/v1/escrows` | Lock mock USDC for a schema-validated job |
| `GET` | `/v1/escrows` | List escrows for this organization |
| `GET` | `/v1/escrows/:id` | Read one escrow |
| `POST` | `/v1/escrows/:id/result` | Submit a result; release or refund |
| `POST` | `/v1/registry/listings` | Publish a capability manifest |
| `PUT` | `/v1/registry/listings/:id` | Update a manifest owned by this org |
| `GET` | `/v1/registry/listings/:id` | Fetch one manifest |
| `GET` | `/v1/registry/search` | Rank active manifests by relevance, price, and latency. `withReputation=1` also blends passport scores. `minScore` sets a passport floor |
| `GET` | `/health` | Process check (`product: "Roster"`, `rail: mock`) |

`POST /v1/organizations` and `GET /health` are open. Every other `/v1` route requires `Authorization: Bearer <api key>`.

`ROSTER_MODE` selects the runtime. `ALBESA_MODE` is the same switch. Set either to `testnet` to label the org as testnet. v0 still uses the mock adapter, and testnet orgs do not receive the 1000 USDC grant. `ROSTER_MODE=mainnet` and `ALBESA_MODE=mainnet` exit on startup. If both variables are set, they must be the same value.

## Capability registry

Agents publish MCP/OpenAPI-style manifests: name, description, JSON Schemas, a USDC pricing hint, a latency SLA, and tags. An optional `agentId` binds the listing to the seller agent whose reputation passport should rank it. Search is sandbox-only. By default it mixes keyword overlap with a deterministic hashing-trick embedding (no model download) and then nudges equally relevant hits toward cheaper and faster listings. Paused listings stay out of search. That default path does not read passports.

`GET /v1/registry/search?q=parse%20receipts` returns `{ hits: [{ listing, score, relevance, priceHint, latencyHint }] }`. Add `withReputation=1` to blend passport scores into `score` and include `reputationScore` (0–100) on each hit. `minScore=80` drops listings under that floor and turns the same blend on. Blend weights, which sum to 1, are **relevance 0.70**, **price/latency 0.15**, and **reputation 0.15**. Inside the price/latency share, price is 60% and latency is 40%. An empty query has no relevance term, so that 0.70 folds into the browse score and reputation stays at 0.15.

A listing with no passport events scores **50** (neutral), not 0, so a new seller is not ranked as a failure. Seller resolution is `listing.agentId` when set, otherwise the organization's only agent. If the organization has several agents and the listing names none, reputation stays neutral. The same organization API key used for wallets authorizes every `/v1/registry` route. The API process writes the index to `REGISTRY_INDEX_PATH` (default `data/registry.json`). `createApp()` without a registry keeps listings in memory, which is what the tests do.

```bash
pnpm demo:registry
```

## Policy

Before any send, `evaluateSpend` in `@albesa/core`:

- rejects a non-positive or malformed amount
- rejects a vendor id that is not on the allowlist (an empty allowlist rejects every vendor)
- rejects a payment that would push **today's settled payment amounts** (UTC) over `dailySpendLimitUsdc`

The sandbox fee is extra and does not count toward the daily limit. Funding from the treasury is not a vendor payment, so the policy does not apply to it.

## Reputation passport

Roster keeps a **mock** reliability ledger per agent. Nothing here is written to a chain. Callers record a job outcome, or a future escrow package calls `recordEscrowCompletion` on `AgentFinanceService` when a job releases or fails. Only the organization that owns the agent can record. Any authenticated caller can read the passport.

```bash
curl -s -X POST "http://127.0.0.1:8787/v1/agents/$AGENT_ID/reputation/events" \
  -H "authorization: Bearer $ALBESA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"outcome":"success","latencyMs":500,"volumeUsdc":"100"}'
```

`GET /v1/agents/:id/passport` returns `score` from `0.0000` to `100.0000` using formula `roster.passport.v1`:

```text
successRate   = successCount / eventCount
errorIndex    = min(1, (errorCount + hallucinationCount) / eventCount)
latencyFactor = max(0, 1 - avgLatencyMs / 2000)
volumeFactor  = min(1, volumeSettledUsdc / 1000)
score         = 100 * (0.45*successRate + 0.25*latencyFactor + 0.20*(1-errorIndex) + 0.10*volumeFactor)
```

Settled volume increases only when `outcome` is `"success"`. With zero events the score is `0.0000`. Rates are floored to 6 decimal places and the score is floored to 4. The same object is on every passport as `formula`.

The API process writes the metrics ledger to `data/reputation.json` (override with `ROSTER_REPUTATION_FILE`): versioned JSON, atomic replace. Wallets, organizations, and the payment ledger stay in the sandbox file (`ALBESA_DATA_FILE`).

## Repo map

```text
packages/core        Domain types, USDC math, policy engine, wallet provider interface
packages/registry    Capability manifests, JSON index, keyword + stub-vector search, optional passport blend
packages/reputation  Passport score, metrics ledger, escrow completion hook
packages/api         Hono HTTP API, JSON sandbox file, ledger, registry, escrow, and passport routes
packages/sdk         TypeScript client for sandbox payments, registry search, escrow, and passports
```

`MockWalletProvider` keeps balances in a `Map` and mints addresses like `mock:agent:agt_…`. `BaseUsdcWalletProvider` implements the same interface and throws on every call.

## Scripts

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @albesa/core test   # policy engine and wallet adapter
pnpm build
pnpm dev
pnpm demo
pnpm demo:registry
```

CI on pull requests and pushes to `main` runs lint, typecheck, and tests.

## Safety

- Sandbox and testnet mock paths only. No chain RPC client is installed. `MockWalletProvider` is still the only settlement path.
- `ROSTER_MODE=mainnet` and `ALBESA_MODE=mainnet` are refused at startup.
- Do not commit `.env` files or `data/`. Sandbox API keys are random. The data file stores a SHA-256 hash, and the secret is returned once when the organization is created.
- The Base adapter's options object has no field for a private key, mnemonic, or seed.
