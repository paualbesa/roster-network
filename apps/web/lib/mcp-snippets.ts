/** Console helpers for the hosted remote MCP endpoint. */

export const ROSTER_MCP_URL = "https://roster.network/mcp";

export type McpHost = "claude-desktop" | "cursor" | "generic";

export function mcpBearerValue(apiKey: string): string {
  return `Bearer ${apiKey.trim() || "sk_sandbox_YOUR_KEY"}`;
}

export function mcpRemoteCard(apiKey: string): { url: string; header: string; value: string } {
  return {
    url: ROSTER_MCP_URL,
    header: "Authorization",
    value: mcpBearerValue(apiKey),
  };
}

/** Hosted remote MCP config (URL + Authorization header). Prefer this over stdio. */
export function mcpConfigJson(apiKey: string, host: McpHost): string {
  const key = apiKey.trim() || "sk_sandbox_YOUR_KEY";
  const server = {
    url: ROSTER_MCP_URL,
    headers: { Authorization: `Bearer ${key}` },
  };
  if (host === "generic") return JSON.stringify({ roster: server }, null, 2);
  return JSON.stringify({ mcpServers: { roster: server } }, null, 2);
}

export function mcpPlainBlock(apiKey: string): string {
  const card = mcpRemoteCard(apiKey);
  return `## MCP
URL: ${card.url}
Header: ${card.header}
Value: ${card.value}
`;
}

export function sdkSnippetTs(apiKey: string, apiUrl = "https://api.roster.network"): string {
  const key = apiKey.trim() || "sk_sandbox_YOUR_KEY";
  return `import { RosterClient } from "@albesa/sdk";

const roster = new RosterClient({
  apiKey: "${key}",
  baseUrl: "${apiUrl}",
});

const found = await roster.need("EUR to USD exchange rate history");
console.log(found.matches[0]?.listing.name);
`;
}

export function sdkSnippetCurl(apiKey: string, apiUrl = "https://api.roster.network"): string {
  const key = apiKey.trim() || "sk_sandbox_YOUR_KEY";
  return `curl -sS -X POST ${apiUrl}/v1/need \\
  -H "authorization: Bearer ${key}" \\
  -H "content-type: application/json" \\
  -d '{"need":"EUR to USD exchange rate history"}'
`;
}

export function sdkSnippetPython(apiKey: string, apiUrl = "https://api.roster.network"): string {
  const key = apiKey.trim() || "sk_sandbox_YOUR_KEY";
  return `import json, urllib.request

req = urllib.request.Request(
    "${apiUrl}/v1/need",
    data=json.dumps({"need": "EUR to USD exchange rate history"}).encode(),
    headers={"authorization": "Bearer ${key}", "content-type": "application/json"},
    method="POST",
)
print(json.load(urllib.request.urlopen(req)))
`;
}
