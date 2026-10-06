import { CapabilityRegistry } from "@albesa/registry";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { DemandLog } from "./demand.js";
import { bootstrapDataProducts, bootstrapSandboxFleet, fleetBuyOnce } from "./fleet.js";
import { buildDemandBoard, sanitizeNeed } from "./sell/demand-board.js";
import { importSource } from "./sell/import.js";
import { readRpcMessage } from "./sell/mcp-client.js";
import { assertSafeUrl, EgressError, isBlockedAddress, type SafeFetchOptions, type SafeResponse } from "./sell/net.js";
import { buildOpenApiRequest } from "./sell/proxy.js";
import { mcpOutputSchema, openApiOutputSchema } from "./sell/schema.js";
import { SellerDirectory } from "./sell/sellers.js";
import { isSolanaAddress, normalizeEvmAddress, validatePayoutWallet } from "./sell/wallets.js";
import { DataCatalog } from "./data/catalog.js";
import { LocalDataStore } from "./data/store.js";
import { SOURCES } from "./data/sources.js";

const SPEC_URL = "https://api.petshop.example/openapi.json";
const MCP_URL = "https://mcp.tools.example/mcp";

const PET_SPEC = {
  openapi: "3.0.3",
  info: { title: "Petshop", version: "1.2.0" },
  servers: [{ url: "/v1" }],
  paths: {
    "/pet/findByStatus": {
      get: {
        summary: "Finds pets by status",
        operationId: "findPetsByStatus",
        parameters: [{ name: "status", in: "query", required: true, schema: { type: "string", enum: ["available", "sold"], default: "available" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } } } } } },
      },
    },
    "/pet/{petId}": {
      get: {
        operationId: "getPetById",
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } },
      },
    },
    "/pet/upload": {
      post: {
        operationId: "uploadImage",
        requestBody: { content: { "application/octet-stream": { schema: { type: "string" } } } },
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: { id: { type: "integer" }, name: { type: "string" }, category: { $ref: "#/components/schemas/Category" }, "photo-urls": { type: "array", items: { type: "string" } } },
      },
      Category: { type: "object", properties: { id: { type: "integer" }, parent: { $ref: "#/components/schemas/Category" } } },
    },
  },
};

function response(body: string, status = 200, headers: Record<string, string> = { "content-type": "application/json" }, url = ""): SafeResponse {
  return { status, headers, body, url, elapsedMs: 1 };
}

/** In-process fake upstreams: an OpenAPI pet shop and an MCP server answering over SSE. */
function fakeFetcher(log: { url: string; options: SafeFetchOptions }[] = []) {
  return async (url: string, options: SafeFetchOptions = {}): Promise<SafeResponse> => {
    log.push({ url, options });
    if (url === SPEC_URL) return response(JSON.stringify(PET_SPEC), 200, { "content-type": "application/json" }, SPEC_URL);
    if (url.startsWith("https://api.petshop.example/v1/pet/findByStatus")) {
      return response(JSON.stringify([{ id: 1, name: "Rex", category: { id: 2 } }]));
    }
    if (url === MCP_URL && options.method === "POST") {
      const rpc = JSON.parse(options.body ?? "{}") as { id?: number; method: string; params?: { name?: string; arguments?: { repo?: string } } };
      if (rpc.id === undefined) return response("", 202);
      const sse = (result: unknown) =>
        response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`, 200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
      if (rpc.method === "initialize") return sse({ protocolVersion: "2025-06-18", serverInfo: { name: "RepoDocs", version: "0.3" }, capabilities: { tools: {} } });
      if (rpc.method === "tools/list") {
        return sse({
          tools: [
            { name: "ask_question", description: "Answer a question about a GitHub repository", inputSchema: { type: "object", properties: { repo: { type: "string" }, question: { type: "string" } }, required: ["repo", "question"] } },
            { name: "fail_tool", description: "Always fails", inputSchema: { type: "object", properties: {} } },
          ],
        });
      }
      if (rpc.method === "tools/call" && rpc.params?.name === "ask_question") {
        return sse({ content: [{ type: "text", text: `Docs for ${rpc.params.arguments?.repo ?? "?"}` }] });
      }
      if (rpc.method === "tools/call") return sse({ isError: true, content: [{ type: "text", text: "boom" }] });
    }
    return response("not found", 404);
  };
}

async function signup(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/v1/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `seller-${Math.random().toString(36).slice(2)}@example.com`, password: "password-123456" }),
  });
  return ((await res.json()) as { apiKey: string }).apiKey;
}

function post(app: ReturnType<typeof createApp>, path: string, key: string, body: unknown) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
}

describe("egress guard", () => {
  it("blocks private, loopback, link-local, metadata and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "224.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("accepts only public https URLs", () => {
    expect(() => assertSafeUrl("https://example.com/mcp")).not.toThrow();
    for (const bad of ["http://example.com", "https://localhost/x", "https://127.0.0.1/", "https://[::1]/", "https://user:pw@example.com/", "https://metadata.internal/", "https://intranet/", "ftp://example.com", "https://example.com:22/"]) {
      expect(() => assertSafeUrl(bad), bad).toThrow(EgressError);
    }
  });
});

describe("payout wallets", () => {
  it("validates Solana and Base addresses without custody", () => {
    expect(isSolanaAddress("So11111111111111111111111111111111111111112")).toBe(true);
    expect(isSolanaAddress("So1111111111111111111111111111111111111111O")).toBe(false);
    expect(normalizeEvmAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(normalizeEvmAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(normalizeEvmAddress("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBeNull();
    expect(validatePayoutWallet({ chain: "base", address: "0x123" }).ok).toBe(false);
    expect(validatePayoutWallet({ chain: "eth", address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" }).ok).toBe(false);
  });
});

describe("importer", () => {
  it("turns an OpenAPI document into priced drafts with escrow-safe output schemas", async () => {
    const registry = new CapabilityRegistry();
    const result = await importSource(SPEC_URL, { fetcher: fakeFetcher(), registry });
    expect(result.source).toMatchObject({ type: "openapi", title: "Petshop", version: "1.2.0" });
    expect(result.drafts.map((draft) => draft.name)).toEqual(["Petshop: Finds pets by status", "Petshop: Get Pet By Id"]);
    expect(result.skipped).toEqual([{ item: "POST /pet/upload", reason: "Request body is not JSON." }]);
    const [find, byId] = result.drafts;
    expect(find!.endpoint).toEqual({ type: "openapi", url: "https://api.petshop.example/v1/pet/findByStatus", method: "GET", params: [{ name: "status", in: "query" }], hasBody: false });
    expect(find!.example).toEqual({ status: "available" });
    expect(find!.inputSchema.required).toEqual(["status"]);
    expect(find!.outputSchema).toEqual({
      type: "object",
      required: ["status", "data"],
      properties: { status: { type: "integer" }, data: { type: "array", items: { type: "object" } } },
    });
    expect(byId!.outputSchema.properties).toMatchObject({ data: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, category: { type: "object" } } } });
    expect(find!.suggestedPriceUsdc).toBe("0.010");
    expect(find!.p95Ms).toBe(8000);
  });

  it("lists MCP tools over Streamable HTTP (SSE answers)", async () => {
    const result = await importSource(MCP_URL, { fetcher: fakeFetcher(), registry: new CapabilityRegistry() });
    expect(result.source).toMatchObject({ type: "mcp", title: "RepoDocs" });
    expect(result.drafts[0]).toMatchObject({
      name: "RepoDocs: Ask question",
      endpoint: { type: "mcp", url: MCP_URL, toolName: "ask_question", structured: false },
      outputSchema: mcpOutputSchema(undefined),
    });
  });

  it("refuses private targets before any request", async () => {
    const log: { url: string; options: SafeFetchOptions }[] = [];
    await expect(importSource("https://10.0.0.5/openapi.json", { fetcher: fakeFetcher(log), registry: new CapabilityRegistry() })).rejects.toMatchObject({ code: "blocked_destination" });
  });

  it("builds proxied OpenAPI requests and parses SSE JSON-RPC", () => {
    expect(
      buildOpenApiRequest({ type: "openapi", url: "https://x.example/pet/{petId}", method: "GET", params: [{ name: "petId", in: "path" }, { name: "tags", in: "query" }], hasBody: false }, { petId: "a/b", tags: ["x", "y"] }).url,
    ).toBe("https://x.example/pet/a%2Fb?tags=x&tags=y");
    expect(() => buildOpenApiRequest({ type: "openapi", url: "https://x.example/pet/{petId}", method: "GET", params: [{ name: "petId", in: "path" }], hasBody: false }, {})).toThrow();
    expect(readRpcMessage('data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n', "text/event-stream", 7)).toMatchObject({ result: { ok: true } });
    expect(openApiOutputSchema(null)).toEqual({ type: "object", required: ["status"], properties: { status: { type: "integer" } } });
  });
});

describe("sell → hire → release", () => {
  function sellApp() {
    return createApp({ mode: "sandbox", autofill: "sync", egressFetcher: fakeFetcher(), dataCatalog: null, dataStore: null });
  }

  it("imports, publishes with a payout wallet, and settles a proxied hire through escrow at 0% take for founding sellers", async () => {
    const app = sellApp();
    await bootstrapSandboxFleet(app);
    const seller = await signup(app);
    const imported = (await (await post(app, "/v1/listings/import", seller, { url: SPEC_URL })).json()) as { drafts: Record<string, unknown>[]; founding: { eligible: boolean } };
    expect(imported.founding.eligible).toBe(true);
    const draft = imported.drafts[0]!;
    const noWallet = await post(app, "/v1/listings/publish", seller, { listings: [{ ...draft, priceUsdc: "0.02" }] });
    expect(noWallet.status).toBe(400);
    const publish = await post(app, "/v1/listings/publish", seller, {
      listings: [{ ...draft, priceUsdc: "0.02", inputSchema: { ...(draft.inputSchema as object), examples: [draft.example] } }],
      payout: { chain: "solana", address: "So11111111111111111111111111111111111111112" },
    });
    expect(publish.status).toBe(201);
    const published = (await publish.json()) as { listings: { id: string }[]; founding: { number: number }; takeRateBps: number };
    expect(published.founding.number).toBe(1);
    expect(published.takeRateBps).toBe(0);
    const listingId = published.listings[0]!.id;

    const publicListing = (await (await app.request(`/v1/registry/listings/${listingId}`)).json()) as Record<string, unknown>;
    expect(publicListing.founding).toMatchObject({ number: 1, active: true });
    expect(JSON.stringify(publicListing)).not.toContain("api.petshop.example/v1/pet");

    const buyer = await signup(app);
    const bought = (await (await post(app, "/v1/need/buy", buyer, { listingId, input: { status: "available" } })).json()) as {
      status: string;
      result: { status: number; data: unknown[] };
      receipt: { takeRateUsdc: string; sellerNetUsdc: string };
    };
    expect(bought.status).toBe("released");
    expect(bought.result.data).toHaveLength(1);
    expect(bought.receipt.takeRateUsdc).toBe("0.000000");
    expect(bought.receipt.sellerNetUsdc).toBe("0.020000");

    const me = (await (await app.request("/v1/sellers/me", { headers: { authorization: `Bearer ${seller}` } })).json()) as {
      totals: { calls: number; released: number; earningsUsdc: string };
      listings: { endpoint: { host: string } }[];
    };
    expect(me.totals).toMatchObject({ calls: 1, released: 1, earningsUsdc: "0.020000" });
    expect(me.listings[0]!.endpoint.host).toBe("api.petshop.example");

    const activity = (await (await app.request("/v1/activity")).json()) as { sandbox: boolean; items: Record<string, unknown>[]; leaderboard: Record<string, unknown>[] };
    expect(activity.sandbox).toBe(true);
    expect(activity.items[0]).toMatchObject({ sandbox: true, seller: "Founding seller #1", sellerKind: "independent", buyerKind: "sandbox_user", status: "released" });
    expect(String(activity.items[0]!.buyer)).toMatch(/^Sandbox buyer [0-9a-f]{6}$/);
    expect(JSON.stringify(activity)).not.toContain("@example.com");
    expect(activity.leaderboard[0]).toMatchObject({ seller: "Founding seller #1", releasedJobs: 1 });

    const founding = (await (await app.request("/v1/founding")).json()) as { taken: number; remaining: number };
    expect(founding).toMatchObject({ taken: 1, remaining: 99 });
  }, 30_000);

  it("refunds the buyer when the seller tool errors", async () => {
    const app = sellApp();
    const seller = await signup(app);
    const imported = (await (await post(app, "/v1/listings/import", seller, { url: MCP_URL })).json()) as { drafts: Record<string, unknown>[] };
    const failing = imported.drafts.find((draft) => (draft.endpoint as { toolName: string }).toolName === "fail_tool")!;
    const publish = (await (await post(app, "/v1/listings/publish", seller, { listings: [{ ...failing, priceUsdc: "0.01" }], payout: { chain: "base", address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" } })).json()) as {
      listings: { id: string }[];
      payout: { address: string };
    };
    expect(publish.payout.address).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    const buyer = await signup(app);
    const bought = (await (await post(app, "/v1/need/buy", buyer, { listingId: publish.listings[0]!.id, input: {} })).json()) as { status: string };
    expect(bought.status).toBe("refunded");
  }, 30_000);

  it("rejects endpoints that point at private networks", async () => {
    const app = sellApp();
    const seller = await signup(app);
    const res = await post(app, "/v1/listings/publish", seller, {
      listings: [{ name: "x", description: "y", inputSchema: { type: "object" }, outputSchema: { type: "object" }, priceUsdc: "0.01", p95Ms: 5000, endpoint: { type: "mcp", url: "https://169.254.169.254/mcp", toolName: "t" } }],
      payout: { chain: "solana", address: "So11111111111111111111111111111111111111112" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("blocked_destination");
  });
});

describe("founding program", () => {
  it("stops at the configured limit and expires", async () => {
    let now = new Date("2026-10-06T00:00:00Z");
    const sellers = new SellerDirectory(null, { limit: 1, days: 90 }, (org) => org === "org_labs", () => now);
    expect((await sellers.upsertProfile("org_labs", { enrolFounding: true })).foundingNumber).toBeNull();
    expect((await sellers.upsertProfile("org_a", { enrolFounding: true })).foundingNumber).toBe(1);
    expect((await sellers.upsertProfile("org_b", { enrolFounding: true })).foundingNumber).toBeNull();
    expect(sellers.takeRateBpsFor("org_a")).toBe(0);
    expect(sellers.takeRateBpsFor("org_b")).toBeNull();
    now = new Date("2027-01-05T00:00:01Z");
    expect(sellers.takeRateBpsFor("org_a")).toBeNull();
  });

  it("releases a founding seat when the seller profile is removed", async () => {
    const sellers = new SellerDirectory(null, { limit: 2, days: 90 });
    expect((await sellers.upsertProfile("org_a", { enrolFounding: true })).foundingNumber).toBe(1);
    expect(sellers.foundingTaken()).toBe(1);
    const removed = await sellers.removeProfile("org_a");
    expect(removed?.foundingNumber).toBe(1);
    expect(sellers.foundingTaken()).toBe(0);
    expect((await sellers.upsertProfile("org_b", { enrolFounding: true })).foundingNumber).toBe(1);
  });
});

describe("demand board", () => {
  it("strips personal data and secrets", () => {
    const text = sanitizeNeed("Email me at jane.doe@corp.com or +34 600 123 456, key sk-live_abcdefghijklmnop1234, wallet 0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed: need EU VAT validation");
    expect(text).not.toMatch(/jane|600 123|sk-live|0x5aae/);
    expect(text).toContain("need EU VAT validation");
  });

  it("clusters similar needs, counts this week, and labels earnings as an estimate", async () => {
    let now = new Date("2026-09-20T10:00:00Z");
    const demand = new DemandLog(null, () => now);
    const base = { bestScore: 0, bestListingName: null, budgetUsdc: null, kind: null, organizationId: "org_secret" };
    await demand.record({ ...base, need: "EU VAT number validation" });
    now = new Date("2026-10-05T10:00:00Z");
    await demand.record({ ...base, need: "EU VAT number validation" });
    await demand.record({ ...base, need: "validate EU VAT numbers" });
    await demand.record({ ...base, need: "satellite imagery of wildfires" });
    const board = buildDemandBoard(await demand.list(), { registry: new CapabilityRegistry(), now: new Date("2026-10-06T00:00:00Z") });
    const vat = board.clusters.find((cluster) => /vat/i.test(cluster.title))!;
    expect(vat.requests).toBe(3);
    expect(vat.requestsThisWeek).toBe(2);
    expect(vat.variants.length).toBe(1);
    expect(vat.estimatedEarningsUsdc).toBe("0.030");
    expect(vat.publishUrl).toBe(`/sell?need=${encodeURIComponent(vat.title)}`);
    expect(board.clusters).toHaveLength(2);
    expect(JSON.stringify(board)).not.toContain("org_secret");
  });
});

describe("Roster Fleet buyer", () => {
  it("makes a genuine first-party purchase attributed to Roster Fleet", async () => {
    const store = new LocalDataStore();
    const catalog = new DataCatalog(store, {
      specs: [
        {
          slug: "fleet-fixture",
          name: "Fleet fixture table",
          kind: "dataset",
          description: "Fixture dataset bought by the fleet buyer.",
          tags: ["fixture"],
          sources: [SOURCES.ecbFrankfurter],
          cadence: "daily",
          intervalS: 86_400,
          priceUsdc: "0.01",
          p95Ms: 5000,
          columns: [{ name: "k", type: "string", description: "Key" }],
          ingest: async () => [{ k: "v" }],
        },
      ],
    });
    const app = createApp({ mode: "sandbox", autofill: "sync", dataCatalog: catalog, dataStore: store, egressFetcher: fakeFetcher() });
    await bootstrapSandboxFleet(app);
    await bootstrapDataProducts(app);
    await catalog.refresh("fleet-fixture");
    const bought = await fleetBuyOnce(app, () => 0);
    expect(bought).toMatchObject({ listingName: "Fleet fixture table", status: "released" });
    const activity = (await (await app.request("/v1/activity")).json()) as { items: Record<string, unknown>[]; totals: { firstPartyJobs24h: number } };
    expect(activity.items[0]).toMatchObject({ buyer: "Roster Fleet", buyerKind: "roster_fleet", seller: "Roster Data", sellerKind: "first_party", sandbox: true });
    expect(activity.totals.firstPartyJobs24h).toBe(1);
  }, 30_000);
});
