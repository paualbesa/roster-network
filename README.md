# Albesa Tech Agent Finance

Albesa gives each AI agent a programmable USDC wallet. A company keeps one treasury balance. The API hands spending power to agents, and a policy blocks a payment when the agent goes outside the rules a developer set — daily cap or vendor allowlist. Think of it as Stripe for agent-to-agent payments: your code creates an agent, funds it, and lets it pay.

This repository is the v0 scaffold. Payments settle on an **in-memory mock rail**. There is no mainnet, no seed phrase, and no private key anywhere in the tree. A `BaseUsdcWalletProvider` stub marks where USDC on Base (Coinbase L2, testnet first) will plug in later.

## How a payment works

1. Create an organization. In sandbox mode the treasury starts with **1000 test USDC**.
2. Create an agent. Albesa assigns a wallet address and a policy (daily spend limit + vendor allowlist).
3. Fund the agent from the organization treasury.
4. The agent pays a vendor. The policy engine runs first. Compliant payments settle and a sandbox fee is recorded: **1% + 0.01 USDC**.

State lives in a JSON file (`ALBESA_DATA_FILE`, default `data/sandbox.json` in the API process working directory). Restarting the API reloads organizations, agents, policies, mock balances, transactions, and the ledger. `createApp()` without `dataFile` keeps the in-memory store for tests. One API process should own a given file.

## Pricing context

Fees below are the product plan, not a live billing integration. v0 always applies the sandbox schedule and the sandbox agent cap.

| Plan | Who | Monthly | Per-transaction | In this repo |
| --- | --- | --- | --- | --- |
| Sandbox | Indie / hackathons | €0 | 1.0% + 0.01 USDC | Default. Up to 5 active agents. Mock USDC. |
| Startup | AI startups / agencies | $199 | 0.5% + 0.005 USDC | Not wired. |
| Enterprise | Large infra / model labs | Custom (>$2,000) | 0.1% or flat | Not wired. |

## Hello, agent payment

Start the API (`pnpm dev`). `POST /v1/organizations` needs no key. Copy `apiKey` from that response into `ALBESA_API_KEY`. The secret is shown once. Later calls, including the SDK, send `Authorization: Bearer <api key>`. The API stores only the SHA-256 hash. Then:

```typescript
import { Albesa } from "@albesa/sdk";
const albesa = new Albesa({ apiKey: process.env.ALBESA_API_KEY! });
const agent = await albesa.agents.create({ name: "buyer", dailySpendLimitUsdc: "10.00", vendorAllowlist: ["vendor_data"] });
await albesa.agents.fund(agent.id, "5.00");
const payment = await albesa.agents.pay(agent.id, { vendorId: "vendor_data", amountUsdc: "0.15" });
```

`payment.status` is `"settled"`. The same call with `vendorId: "vendor_other"`, or with an amount that pushes the UTC day over `10.00`, throws `AlbesaError` and leaves the balance unchanged. Rejected attempts are stored on the agent's transaction list.

To run that flow in one command (it boots the API, creates the org, and prints the settled payment):

```bash
pnpm install
pnpm demo
```

## Quickstart

```bash
pnpm install
pnpm dev
```

The API listens on `http://127.0.0.1:8787`.

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
| `GET` | `/health` | Process check (`rail: mock`) |

`POST /v1/organizations` and `GET /health` are open. Every other `/v1` route requires `Authorization: Bearer <api key>`.

Set `ALBESA_MODE=testnet` to label the org as testnet. v0 still uses the mock adapter, and testnet orgs do **not** receive the 1000 USDC grant. `ALBESA_MODE=mainnet` exits on startup.

## Policy

Before any send, `evaluateSpend` in `@albesa/core`:

- rejects a non-positive or malformed amount
- rejects a vendor id that is not on the allowlist (an empty allowlist rejects every vendor)
- rejects a payment that would push **today's settled payment amounts** (UTC) over `dailySpendLimitUsdc`

The sandbox fee is extra and does not count toward the daily limit. Funding from the treasury is not a vendor payment, so the policy does not apply to it.

## Repo map

```text
packages/core   Domain types, USDC math, policy engine, wallet provider interface
packages/api    Hono HTTP API, JSON sandbox file, and ledger
packages/sdk    TypeScript client used in the hello example
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
```

CI on pull requests and pushes to `main` runs lint, typecheck, and tests.

## Safety

- Sandbox and testnet mock paths only. No chain RPC client is installed. `MockWalletProvider` is still the only settlement path.
- Do not commit `.env` files or `data/`. Sandbox API keys are random. The data file stores a SHA-256 hash, and the secret is returned once when the organization is created.
- The Base adapter's options object has no field for a private key, mnemonic, or seed.
