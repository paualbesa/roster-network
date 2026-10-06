import { describe, expect, it } from "vitest";
import { mcpConfigJson, mcpPlainBlock, mcpRemoteCard, ROSTER_MCP_URL } from "./mcp-snippets";

describe("mcp snippets", () => {
  it("shows the remote MCP URL and bearer header for a sandbox key", () => {
    const key = "sk_sandbox_testkey123";
    const card = mcpRemoteCard(key);
    expect(card.url).toBe(ROSTER_MCP_URL);
    expect(card.header).toBe("Authorization");
    expect(card.value).toBe(`Bearer ${key}`);
    expect(mcpPlainBlock(key)).toContain("https://roster.network/mcp");
    expect(mcpConfigJson(key, "cursor")).toContain(key);
    expect(mcpConfigJson(key, "cursor")).toContain(ROSTER_MCP_URL);
  });
});
