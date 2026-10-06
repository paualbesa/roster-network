import { createApp } from "@albesa/api";
import { describe, expect, it } from "vitest";
import { attachRosterMcp, createRemoteMcpFetchHandler, readBearer, remoteMcpClientJson, remoteMcpConfigCard } from "./http.js";

function fetchFor(app: ReturnType<typeof createApp>): typeof fetch {
  return (input, init) => Promise.resolve(app.request(input, init));
}

describe("remote MCP HTTP", () => {
  it("rejects missing bearer keys", async () => {
    const app = createApp({ mode: "sandbox" });
    const handler = createRemoteMcpFetchHandler({
      apiBaseUrl: "http://roster.internal",
      fetch: fetchFor(app),
      env: { ROSTER_MODE: "sandbox" },
    });
    const res = await handler(new Request("http://roster.network/mcp", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(readBearer(null)).toBeNull();
    expect(readBearer("Bearer sk_sandbox_abc")).toBe("sk_sandbox_abc");
  });

  it("lists tools and runs roster_need with a sandbox key via /mcp on the API", async () => {
    const app = createApp({ mode: "sandbox" });
    attachRosterMcp(app, { mode: "sandbox" });
    const created = await app.request("/v1/accounts/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(201);
    const { apiKey } = (await created.json()) as { apiKey: string };

    const unauthorized = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      }}),
    });
    expect(unauthorized.status).toBe(401);

    const init = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result?: { serverInfo?: { name: string } } };
    expect(initBody.result?.serverInfo?.name).toBe("roster");

    const tools = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(tools.status).toBe(200);
    const toolBody = (await tools.json()) as { result?: { tools?: { name: string }[] } };
    const names = (toolBody.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "roster_need",
      "roster_buy",
      "roster_search",
      "roster_listing",
      "roster_job",
      "roster_balance",
    ]));

    const need = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "roster_need", arguments: { need: "EUR to USD exchange rate history" } },
      }),
    });
    expect(need.status).toBe(200);
    const needBody = (await need.json()) as { result?: { content?: { text?: string }[] }; error?: unknown };
    expect(needBody.error).toBeUndefined();
    const text = needBody.result?.content?.[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(10);

    const card = remoteMcpConfigCard(apiKey);
    expect(card.url).toBe("https://roster.network/mcp");
    expect(card.value).toBe(`Bearer ${apiKey}`);
    expect(remoteMcpClientJson(apiKey, "cursor")).toContain(apiKey);
  });
});
