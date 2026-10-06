# npm publish readiness (do not publish without an npm token)

## Name availability (checked 2026-10-06)

| Name | Status |
| --- | --- |
| `roster-network` | available |
| `@roster-network/sdk` | available (needs npm org `roster-network`) |
| `@roster-network/mcp` | available (needs npm org) |
| `@roster/sdk` / `@roster/mcp` | available (needs npm org `roster`) |
| `@albesa/sdk` / `@albesa/mcp` | available (needs npm org `albesa`) |
| `roster-mcp` | **taken then unpublished** (2026-01-12) — avoid; republish rights may be locked to the original publisher |
| `roster-sdk` | available |

Recommended publish names:

- `@roster-network/sdk` — TypeScript client (`packages/sdk`)
- `@roster-network/mcp` — stdio MCP (`packages/mcp`, bin `roster-mcp`) that talks to the hosted API

## What must change before publish

Current packages are `"private": true` and version `0.0.0`, scoped `@albesa/*`, with workspace-only deps.

1. Create npm org `roster-network` (or reuse `albesa` if Pau owns it).
2. Provide an automation token via the secret form (`NPM_TOKEN`).
3. Per package:
   - set `"private": false`, semver (e.g. `0.1.0`), `"license": "MIT"`
   - `"files": ["dist"]`, build before publish (`pnpm build`)
   - `"repository"`, `"homepage": "https://roster.network"`, `"bugs"`
   - `"keywords": ["mcp", "roster", "usdc", "agents", "marketplace"]`
   - for MCP registry package ownership later: `"mcpName": "io.github.paualbesa/roster-network"`
4. `packages/mcp` already has `"bin": { "roster-mcp": "./dist/stdio.js" }` — after publish, clients run:
   ```bash
   ROSTER_API_KEY=sk_sandbox_… ROSTER_BASE_URL=https://roster.network/roster-api npx @roster-network/mcp
   ```
5. Workspace deps (`@albesa/core`, `@albesa/sdk`) must either be published first or bundled — today they are monorepo-only, so publish order is core → sdk → mcp (or switch mcp to call HTTPS only and drop workspace runtime deps).

## Blocked on

- Pau: npm org + `NPM_TOKEN` (secret form). Do not publish from this agent until that token is provided.
- Prefer remote MCP for discovery; npm is optional for clients that only support stdio.
