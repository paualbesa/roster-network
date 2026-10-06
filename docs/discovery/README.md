# Agent discovery for Roster MCP

How agents and directories find the hosted Roster MCP at `https://roster.network/mcp`.

## Official MCP Registry

- Metadata file: [`/server.json`](../../server.json) (namespace `io.github.paualbesa/roster-network`)
- Domain namespace draft: [`server.network.roster.json`](./server.network.roster.json) (`network.roster/mcp`)
- Schema: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
- Validate: `mcp-publisher validate`
- Publish auth:
  1. **GitHub (ready now):** `mcp-publisher login github` → device code at https://github.com/login/device → `mcp-publisher publish`
  2. **HTTP domain (preferred long-term):** after deploy, `https://roster.network/.well-known/mcp-registry-auth` serves the public proof. Private key lives only on the operator machine (not in git). Then:
     ```bash
     PRIVATE_KEY="$(openssl pkey -in mcp-registry-roster.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
     mcp-publisher login http --domain roster.network --private-key "$PRIVATE_KEY"
     mcp-publisher publish docs/discovery/server.network.roster.json
     ```
  3. **DNS TXT alternative:** apex TXT `v=MCPv1; k=ed25519; p=<base64>` on `roster.network`, then `mcp-publisher login dns …`.

Remote-only entries do **not** require an npm package. Publishing under `io.github.paualbesa/*` only needs GitHub OAuth for the `paualbesa` account.

## Smithery

- Config: [`/smithery.yaml`](../../smithery.yaml)
- Config schema for CLI: [`smithery-config.schema.json`](./smithery-config.schema.json)
- Account step: sign in at [smithery.ai/new](https://smithery.ai/new) (GitHub), paste `https://roster.network/mcp`, complete the scan (use a sandbox Bearer key when prompted), or publish via CLI after `npx @smithery/cli login`.
- Note: Smithery reserves the `Authorization` header for its OAuth. Clients send `x-roster-key`; the gateway rewrites to `Authorization`. Paste the **full** `Bearer sk_sandbox_…` value.
- Fallback: static card at `https://roster.network/.well-known/mcp/server-card.json`

## npm (not published yet)

See [`npm.md`](./npm.md).

## Directory submissions (drafts only)

See [`directory-entries.md`](./directory-entries.md). Do not open external PRs until Pau approves.

## On-site discovery

| Path | Purpose |
| --- | --- |
| `/llms.txt` | llmstxt.org map for agents |
| `/.well-known/mcp` | JSON discovery index |
| `/.well-known/mcp/server-card.json` | Smithery / SEP-1649 server card |
| `/.well-known/mcp-registry-auth` | MCP Registry HTTP auth proof |

## Operator notes (HTTP auth key)

The Ed25519 private key for `network.roster/*` HTTP auth is generated on the operator machine and must never be committed. After the proof is live at `/.well-known/mcp-registry-auth`, run `mcp-publisher login http --domain roster.network --private-key …` then publish `docs/discovery/server.network.roster.json`.
