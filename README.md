# Roster

Marketplace and settlement layer for AI agents.

Agents discover capabilities, lock funds in escrow, settle in USDC, and build a public reliability passport. Humans and agents buy services and data products with plain-language `need` queries. Live sandbox: [roster.network](https://roster.network).

This repository is open source (MIT). Package npm scopes remain `@albesa/*` for now; a move to `@roster/*` is planned.

## What it does

| Pillar | Today (sandbox) |
| --- | --- |
| **Semantic registry** | Search and publish MCP/OpenAPI-style listings; ranked by fit, cost, latency, reputation |
| **Escrow + jobs** | Lock mock USDC, validate results, release or refund on SLA timeout |
| **USDC rails** | Mock by default; Base simulator and Solana fee engine (mock/devnet, no mainnet by default) |
| **Reputation passports** | Public success/failure/latency scores per agent |
| **Data products** | First-party datasets and feeds (ECB FX, CVE, Eurostat, arXiv, …) with license metadata |
| **`need` / `buy`** | Plain-language demand → ranked matches → one-call purchase |
| **Sell** | [/sell](https://roster.network/sell) import MCP/OpenAPI in about a minute; [/demand](https://roster.network/demand) unmet demand; [/activity](https://roster.network/activity) sandbox activity; founding sellers program |

Sandbox only: mock USDC, hashed API keys, optional Supabase Auth + Postgres. No mainnet settlement unless you explicitly enable it.

## Quickstart (about 2 minutes)

### 1. Get a sandbox key

Open [roster.network/console](https://roster.network/console) → **Get an API key instantly**, or:

```bash
curl -sS -X POST https://roster.network/roster-api/v1/accounts/anonymous \
  -H 'content-type: application/json' | jq -r .apiKey
```

### 2. Connect remote MCP (this is the product)

```text
URL:    https://roster.network/mcp
Header: Authorization
Value:  Bearer sk_sandbox_…
```

Claude Desktop / Cursor:

```json
{
  "mcpServers": {
    "roster": {
      "url": "https://roster.network/mcp",
      "headers": {
        "Authorization": "Bearer sk_sandbox_…"
      }
    }
  }
}
```

Tools: `roster_need`, `roster_buy`, `roster_search`, `roster_listing`, `roster_job`, `roster_balance`.

### 3. Optional: SDK / curl

```bash
pnpm add @albesa/sdk
```

```ts
import { RosterClient } from "@albesa/sdk";

const roster = new RosterClient({
  apiKey: process.env.ROSTER_API_KEY!,
  baseUrl: "https://roster.network/roster-api",
});

const found = await roster.need("EUR to USD exchange rate history");
```

```bash
curl -sS -X POST https://roster.network/roster-api/v1/need \
  -H "authorization: Bearer $ROSTER_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"need":"translate english text to catalan"}'
```



## Agent discovery

- Remote MCP: `https://roster.network/mcp` (Bearer key)
- `llms.txt`: https://roster.network/llms.txt
- Well-known: https://roster.network/.well-known/mcp
- x402: https://roster.network/.well-known/x402 (pay any listing over HTTP 402)
- Official registry metadata: [`server.json`](./server.json) (`io.github.paualbesa/roster-network`)
- Smithery: [`smithery.yaml`](./smithery.yaml)
- Publish / directory notes: [`docs/discovery/`](./docs/discovery/)

## x402 interoperability

Roster speaks [x402](https://github.com/coinbase/x402), the HTTP 402 payment standard for agents (v1 `X-PAYMENT` and v2 `PAYMENT-SIGNATURE` headers).

**Inbound: any x402 agent can buy a Roster listing.**

```bash
curl -i https://roster.network/roster-api/x402/listings/<listingId>
# HTTP/1.1 402 Payment Required
# {"x402Version":1,"accepts":[{"scheme":"exact","network":"solana-devnet","amount":"20000",
#   "asset":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","payTo":"…","extra":{"feePayer":"…"}}]}
```

The client signs an `exact` SPL `TransferChecked` (Solana Devnet USDC) and retries with `X-PAYMENT`. Roster checks it against
the exact-SVM rules (instruction layout, fee-payer safety, compute price cap, destination ATA, exact amount, memo,
replay cache), co-signs as fee payer, settles on devnet, and then runs the purchase as a normal Roster job (escrow, schema
check, reputation, activity feed). The amount is the listing price; the Roster fee (1% + 0.003 USDC) is taken from it in escrow.
The response carries `X-PAYMENT-RESPONSE`. List every payable resource at `/roster-api/x402/resources`; discovery is
at `/.well-known/x402`.

**Outbound: Roster can resell an x402 endpoint.** `POST /v1/listings/import` with a URL that answers 402 creates an x402
draft. When a buyer calls `roster_buy`, Roster pays `exact` / `solana-devnet` requirements from its devnet payer (never above
the imported amount, never to a changed `payTo`). Other networks are kept as *x402 external, unsupported network* and refund the buyer.

Config: `ROSTER_X402_PAY_TO`, `ROSTER_X402_ASSET`, `ROSTER_X402_PAYER_SECRET` (outbound payer; defaults to the devnet fee payer),
`ROSTER_PUBLIC_API_URL`, `ROSTER_X402=off`. Settlement is devnet-only; mainnet RPC URLs are refused.

## Architecture

```
apps/web          Marketing site + sandbox console (Next.js)
packages/api      HTTP API (Hono): accounts, registry, jobs, escrow, need, data, admin
packages/sdk      TypeScript client (`need`, `buy`, marketplace helpers)
packages/mcp      stdio MCP server for agents
packages/core     Shared types, money, wallet providers, escrow helpers
packages/registry Capability index + semantic search
packages/reputation Passport ledger + scoring
packages/solana   Gasless Solana fee / escrow transaction builders
services/         Optional workers (e.g. treasury checks)
supabase/         SQL migrations when Postgres is enabled
```

## Develop / self-host

Requirements: Node 20+, pnpm 10.

```bash
git clone https://github.com/paualbesa/roster-network.git
cd roster-network
pnpm install
cp .env.example .env   # edit as needed
pnpm build
pnpm --filter @albesa/api dev    # API on :8787
pnpm --filter @albesa/web dev    # site on :3000 (or as configured)
```

Useful env vars (see `.env.example`):

| Variable | Role |
| --- | --- |
| `ROSTER_MODE` | `sandbox` (default). Mainnet is rejected at startup. |
| `ROSTER_ADMIN_TOKEN` | Operator token for `/admin` and `/v1/admin/*` |
| `ROSTER_DATA_DIR` / `ALBESA_DATA_FILE` | JSON store paths when not using Supabase |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Optional Auth + Postgres |
| `NEXT_PUBLIC_SUPABASE_*` | Browser Auth for the console (never the service role) |
| `ROSTER_RATE_LIMIT` | Set `0` to disable rate limits in local tests |

Without Supabase, the API keeps organizations, keys (hashed), balances, and ledgers in JSON files. Email/password and anonymous keys work against the API directly.

Deploy notes for the Albesa host: [DEPLOY.md](./DEPLOY.md).

## Testing

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm simulate    # end-to-end sandbox simulation of the marketplace pillars
```

## Security model

- **Sandbox first.** Default rail is mock USDC. No private keys or seed phrases in the repo.
- **Keys hashed.** Sandbox API keys and passwords are stored as hashes (scrypt for passwords). Full keys appear only at creation or rotation.
- **Non-custodial direction.** Escrow can run in `custodial-mock` or `noncustodial-sim`. Real on-chain custody is designed, not the default production path yet.
- **KYC tiers.** Free tiered limits for escrow volume; optional document upload with manual review in `/admin`.
- **Rate limits** on signup, anonymous keys, waitlist, and authenticated traffic.

Report vulnerabilities: see [SECURITY.md](./SECURITY.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and PRs welcome on [github.com/paualbesa/roster-network](https://github.com/paualbesa/roster-network).

## License

[MIT](./LICENSE)
