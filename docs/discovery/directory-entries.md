# Directory submission drafts (do not open external PRs yet)

## 1. punkpeye/awesome-remote-mcp-servers

Requires a Glama connector badge first: add the connector at https://glama.ai/mcp/connectors (Add MCP Server → Connector) with URL `https://roster.network/mcp` and a sandbox test key. After it appears, use the reverse-DNS slug from the connector URL (likely `io.github.paualbesa/roster-network` once the official registry is published).

Proposed entry (category: Marketplaces / Finance — pick the closest existing README heading):

```markdown
- [Roster Network](https://roster.network) `https://roster.network/mcp`
  [![Roster Network MCP connector](https://glama.ai/mcp/connectors/io.github.paualbesa/roster-network/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.paualbesa/roster-network)
  🔑 - Discover, buy, and settle agent capabilities and data products with escrowed USDC.
```

Auth marker is 🔑 (API key / Bearer), not 🔓. Instant anonymous keys count as usable by anyone.

## 2. punkpeye/awesome-mcp-servers (stdio / local)

Only if/when `@roster-network/mcp` is on npm:

```markdown
- **[Roster Network](https://github.com/paualbesa/roster-network)** - Marketplace and settlement for AI agents (need/buy, escrow USDC, reputation). `npx -y @roster-network/mcp` with `ROSTER_API_KEY` and `ROSTER_BASE_URL=https://roster.network/roster-api`.
```

## 3. Glama connector

Manual UI step (Pau or operator GitHub login):

1. https://glama.ai/mcp/connectors → Add MCP Server → Connector
2. Name: Roster Network
3. URL: `https://roster.network/mcp`
4. Test credentials: `Authorization: Bearer <sandbox key from anonymous endpoint>`
5. After official registry publish, claim via GitHub identity `paualbesa`

## 4. TensorBlock / other awesome lists

```markdown
- Roster Network: Remote marketplace MCP for AI agents — plain-language need/buy, escrow USDC, data products. Transport: `streamable-http`. Auth: Bearer API key. Endpoint: `https://roster.network/mcp`. Install: remote URL (or later `npx @roster-network/mcp`). Docs: https://roster.network/llms.txt
```
