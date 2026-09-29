import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp, sandboxReceiptListing } from "@albesa/api";
import { createSandboxAccount } from "@albesa/sdk";
import { describe, expect, it } from "vitest";
import { createRosterMcpServer, readRosterClientOptions } from "./index.js";

const PASSWORD = "sandbox-passphrase-9";

function fetchFor(app: ReturnType<typeof createApp>): typeof fetch {
  return (input, init) => Promise.resolve(app.request(input, init));
}

async function withClient(server: McpServer, run: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ name: "roster-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function toolText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected a text tool result.");
  }
  const block: unknown = result.content[0];
  if (typeof block !== "object" || block === null || !("type" in block) || !("text" in block)) {
    throw new Error("Expected a text tool result.");
  }
  if (block.type !== "text" || typeof block.text !== "string") {
    throw new Error("Expected a text tool result.");
  }
  return block.text;
}

describe("Roster MCP server", () => {
  it("reads the account treasury and funds an agent through roster_balance and roster_fund", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl = fetchFor(app);
    const { apiKey, client } = await createSandboxAccount({
      email: "ada@example.com",
      password: PASSWORD,
      name: "Ada",
      baseUrl: "http://roster.test",
      fetch: fetchImpl,
    });
    const agent = await client.agents.create({
      name: "buyer",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    const server = createRosterMcpServer({
      apiKey,
      baseUrl: "http://roster.test",
      fetch: fetchImpl,
      env: { ROSTER_MODE: "sandbox" },
    });

    await withClient(server, async (mcp) => {
      const treasury = await mcp.callTool({ name: "roster_balance", arguments: {} });
      expect(treasury.isError).toBeUndefined();
      expect(toolText(treasury)).toContain("1000.000000");

      const funded = await mcp.callTool({
        name: "roster_fund",
        arguments: { agentId: agent.id, amountUsdc: "5.00" },
      });
      expect(funded.isError).toBeUndefined();
      expect(toolText(funded)).toContain("5.000000");

      const balance = await mcp.callTool({
        name: "roster_balance",
        arguments: { agentId: agent.id },
      });
      expect(balance.isError).toBeUndefined();
      const parsed = JSON.parse(toolText(balance)) as { balanceUsdc: string; agentId: string };
      expect(parsed.agentId).toBe(agent.id);
      expect(parsed.balanceUsdc).toBe("5.000000");
    });
  });

  it("searches the registry, opens a job, and reads the seller passport", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl = fetchFor(app);
    const { apiKey, client } = await createSandboxAccount({
      email: "ada@example.com",
      password: PASSWORD,
      name: "Ada",
      baseUrl: "http://roster.test",
      fetch: fetchImpl,
    });
    const buyer = await client.agents.create({
      name: "buyer",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    const seller = await client.agents.create({
      name: "seller",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    await client.agents.fund(buyer.id, "5.00");
    const listing = await client.registry.register(sandboxReceiptListing());
    await client.jobs.bindSeller(listing.id, seller.id);
    const server = createRosterMcpServer({
      apiKey,
      baseUrl: "http://roster.test",
      fetch: fetchImpl,
      env: { ROSTER_MODE: "sandbox" },
    });
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["total"],
      properties: { total: { type: "string", minLength: 1 } },
    };

    await withClient(server, async (mcp) => {
      const hits = await mcp.callTool({
        name: "roster_search",
        arguments: { q: "parse receipts", tags: ["receipt"] },
      });
      expect(hits.isError).toBeUndefined();
      expect(toolText(hits)).toContain("Receipt parser");

      const opened = await mcp.callTool({
        name: "roster_create_job",
        arguments: {
          buyerAgentId: buyer.id,
          query: "parse receipts",
          amountUsdc: "1.00",
          schema,
        },
      });
      expect(opened.isError).toBeUndefined();
      const job = JSON.parse(toolText(opened)) as { id: string; status: string; listingId: string };
      expect(job.status).toBe("held");
      expect(job.listingId).toBe(listing.id);

      const settled = await mcp.callTool({
        name: "roster_submit_job_result",
        arguments: { jobId: job.id, result: { total: "12.50" } },
      });
      expect(settled.isError).toBeUndefined();
      expect(JSON.parse(toolText(settled)).status).toBe("released");

      const passport = await mcp.callTool({
        name: "roster_passport",
        arguments: { agentId: seller.id },
      });
      expect(passport.isError).toBeUndefined();
      expect(JSON.parse(toolText(passport)).score).toBe("85.0100");
    });
  });

  it("keeps an account key from reading another account's agent wallet", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl = fetchFor(app);
    const ada = await createSandboxAccount({
      email: "ada@example.com",
      password: PASSWORD,
      name: "Ada",
      baseUrl: "http://roster.test",
      fetch: fetchImpl,
    });
    const bob = await createSandboxAccount({
      email: "bob@example.com",
      password: PASSWORD,
      name: "Bob",
      baseUrl: "http://roster.test",
      fetch: fetchImpl,
    });
    const secret = await bob.client.agents.create({
      name: "secret",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    await bob.client.agents.fund(secret.id, "3.00");
    const server = createRosterMcpServer({
      apiKey: ada.apiKey,
      baseUrl: "http://roster.test",
      fetch: fetchImpl,
      env: { ROSTER_MODE: "sandbox" },
    });

    await withClient(server, async (mcp) => {
      const peek = await mcp.callTool({
        name: "roster_balance",
        arguments: { agentId: secret.id },
      });
      expect(peek.isError).toBe(true);
      expect(toolText(peek)).toContain("not_found");

      const fund = await mcp.callTool({
        name: "roster_fund",
        arguments: { agentId: secret.id, amountUsdc: "1.00" },
      });
      expect(fund.isError).toBe(true);
      expect(toolText(fund)).toContain("not_found");
    });

    expect((await bob.client.agents.balance(secret.id)).balanceUsdc).toBe("3.000000");
    expect((await ada.client.treasury.get()).balanceUsdc).toBe("1000.000000");
  });

  it("reports an unknown API key as a tool error", async () => {
    const app = createApp({ mode: "sandbox" });
    const server = createRosterMcpServer({
      apiKey: "sk_sandbox_not_a_real_key",
      baseUrl: "http://roster.test",
      fetch: fetchFor(app),
      env: { ROSTER_MODE: "sandbox" },
    });
    await withClient(server, async (mcp) => {
      const result = await mcp.callTool({ name: "roster_balance", arguments: {} });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("unauthorized");
    });
  });

  it("refuses mainnet and a missing account key before the server starts", () => {
    expect(() =>
      createRosterMcpServer({ apiKey: "sk_sandbox_x", env: { ROSTER_MODE: "mainnet" } }),
    ).toThrow(/mainnet is disabled/);
    expect(() =>
      createRosterMcpServer({ apiKey: "sk_sandbox_x", env: { ALBESA_MODE: "mainnet" } }),
    ).toThrow(/mainnet is disabled/);
    expect(() => readRosterClientOptions({ ROSTER_MODE: "mainnet" })).toThrow(/mainnet is disabled/);
    expect(() => readRosterClientOptions({ ALBESA_MODE: "mainnet" })).toThrow(/mainnet is disabled/);
    expect(() => readRosterClientOptions({})).toThrow(/ROSTER_API_KEY is required/);
    expect(() =>
      readRosterClientOptions({ ROSTER_API_KEY: "sk_sandbox_a", ALBESA_API_KEY: "sk_sandbox_b" }),
    ).toThrow(/disagree/);
    expect(readRosterClientOptions({ ALBESA_API_KEY: "sk_sandbox_a", ROSTER_MODE: "sandbox" })).toEqual({
      apiKey: "sk_sandbox_a",
      baseUrl: "http://127.0.0.1:8787",
    });
  });
});
