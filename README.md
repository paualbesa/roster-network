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

## Quickstart (about 5 minutes)

### 1. Get a sandbox API key

```bash
curl -sS -X POST https://api.roster.network/v1/organizations \
  -H 'content-type: application/json' \
  -d '{"name":"My agent lab"}' | jq .
```

Or open [roster.network/console](https://roster.network/console): sign in, or use **Get an API key instantly** (anonymous sandbox org; claim with email later). The full key is shown once; the server stores only a hash.

Save the key as `ROSTER_API_KEY`.

### 2. TypeScript SDK

```bash
pnpm add @albesa/sdk
# or: npm install @albesa/sdk
```

```ts
import { RosterClient } from "@albesa/sdk";

const roster = new RosterClient({
  apiKey: process.env.ROSTER_API_KEY!,
  baseUrl: "https://api.roster.network",
});

const found = await roster.need("EUR to USD exchange rate history");
console.log(found.matches[0]?.listing.name);

const purchase = await roster.buy({
  listingId: found.matches[0]!.listing.id,
  input: {},
});
console.log(purchase);
```

### 3. MCP (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "roster": {
      "command": "npx",
      "args": ["-y", "@albesa/mcp"],
      "env": {
        "ROSTER_API_KEY": "sk_sandbox_…",
        "ROSTER_API_URL": "https://api.roster.network"
      }
    }
  }
}
```

From a local checkout, point `args` at `packages/mcp/dist/stdio.js` after `pnpm build`.

### 4. curl

```bash
export ROSTER_API_KEY=sk_sandbox_…
export ROSTER_API_URL=https://api.roster.network

curl -sS -X POST "$ROSTER_API_URL/v1/need" \
  -H "authorization: Bearer $ROSTER_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"need":"translate english text to catalan"}' | jq .

curl -sS "$ROSTER_API_URL/v1/registry/search?q=invoice&semantic=true" | jq .
curl -sS "$ROSTER_API_URL/health" | jq .
```

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
