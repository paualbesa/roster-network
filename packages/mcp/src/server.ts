import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveRuntimeMode } from "@albesa/core";
import {
  Albesa,
  AlbesaError,
  type BuyInput,
  type CreateJobInput,
  type NeedInput,
  type RegistrySearchQuery,
} from "@albesa/sdk";
import { z } from "zod";

export interface RosterMcpOptions {
  /** Sandbox API key for one Roster account. Sent as Authorization: Bearer. */
  apiKey: string;
  /** Roster API origin. Defaults to http://127.0.0.1:8787. */
  baseUrl?: string;
  /** Injected fetch for tests. Production uses the global fetch. */
  fetch?: typeof fetch;
  /**
   * Runtime env for the sandbox/mainnet switch.
   * Omit it to read `process.env`. `mainnet` refuses to construct the server.
   */
  env?: Record<string, string | undefined>;
}

export interface RosterClientOptions {
  apiKey: string;
  baseUrl: string;
}

const jsonObject = z.record(z.string(), z.unknown());

/**
 * Reads `ROSTER_API_KEY` (or `ALBESA_API_KEY`) and the API origin.
 * `ROSTER_MODE=mainnet` and `ALBESA_MODE=mainnet` throw before a server starts.
 */
export function readRosterClientOptions(env: Record<string, string | undefined>): RosterClientOptions {
  resolveRuntimeMode(env);
  const rosterKey = env.ROSTER_API_KEY?.trim();
  const albesaKey = env.ALBESA_API_KEY?.trim();
  if (rosterKey && albesaKey && rosterKey !== albesaKey) {
    throw new Error("ROSTER_API_KEY and ALBESA_API_KEY disagree. Set only one, or set them to the same value.");
  }
  const apiKey = rosterKey || albesaKey;
  if (!apiKey) {
    throw new Error("ROSTER_API_KEY is required. Create a Roster account and pass that sandbox API key.");
  }
  const rosterUrl = env.ROSTER_API_URL?.trim();
  const albesaUrl = env.ALBESA_API_URL?.trim();
  if (rosterUrl && albesaUrl && rosterUrl !== albesaUrl) {
    throw new Error("ROSTER_API_URL and ALBESA_API_URL disagree. Set only one, or set them to the same value.");
  }
  const baseUrl = (rosterUrl || albesaUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  return { apiKey, baseUrl };
}

/** Stdio MCP server whose tools call the Roster HTTP API with one account's API key. */
export function createRosterMcpServer(options: RosterMcpOptions): McpServer {
  resolveRuntimeMode(options.env ?? process.env);
  const client = new Albesa({
    apiKey: options.apiKey,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  const server = new McpServer({ name: "roster", version: "0.0.0" });

  server.registerTool(
    "roster_balance",
    {
      title: "Roster balance",
      description:
        "Read the sandbox USDC balance for this account. Omit agentId to read the treasury wallet created at signup. Pass agentId to read that agent's wallet. The API key can only see wallets in its own account.",
      inputSchema: {
        agentId: z.string().optional().describe("Agent id. Omit to read the account treasury."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId }) =>
      runTool(() => {
        const id = agentId?.trim();
        if (agentId !== undefined && !id) {
          throw new AlbesaError(400, "invalid_request", "agentId is empty.");
        }
        return id ? client.agents.balance(id) : client.treasury.get();
      }),
  );

  server.registerTool(
    "roster_fund",
    {
      title: "Fund a Roster agent",
      description:
        "Move sandbox USDC from this account's treasury wallet to an agent in the same account.",
      inputSchema: {
        agentId: z.string().describe("Agent id in this account."),
        amountUsdc: z.string().describe("USDC amount to move, for example 5.00."),
      },
    },
    async ({ agentId, amountUsdc }) => runTool(() => client.agents.fund(agentId, amountUsdc)),
  );

  server.registerTool(
    "roster_need",
    {
      title: "Tell Roster what you need",
      description:
        "Describe what you need in plain language (any language), e.g. 'EUR/USD daily rates since 2020 as CSV' or 'is CVE-2024-3094 exploited?'. Returns ranked Roster listings (data products: dataset, feed, lookup; and services) with price in USDC, freshness, source and license, a sample, and a ready buy body. Often cheaper than finding and cleaning the data yourself. Set buy=true to buy the top match in the same call. Unmatched needs are logged so Roster can build them.",
      inputSchema: {
        need: z.string().min(2).max(500).describe("What you need, in plain language."),
        budgetUsdc: z.string().optional().describe("Max price per call in USDC, for example 0.05."),
        kinds: z
          .array(z.enum(["service", "dataset", "feed", "lookup", "data"]))
          .optional()
          .describe("Restrict to listing kinds. 'data' means any data product."),
        limit: z.number().int().positive().max(20).optional(),
        buy: z.boolean().optional().describe("Buy the top match now through escrow."),
        input: jsonObject.optional().describe("Input for the bought listing. Defaults to its example."),
      },
    },
    async (args) =>
      runTool(() => {
        const input: NeedInput = { need: args.need };
        if (args.budgetUsdc !== undefined) input.budgetUsdc = args.budgetUsdc;
        if (args.kinds !== undefined) input.kinds = args.kinds;
        if (args.limit !== undefined) input.limit = args.limit;
        if (args.buy !== undefined) input.buy = args.buy;
        if (args.input !== undefined) input.input = args.input;
        return client.need(input);
      }),
  );

  server.registerTool(
    "roster_buy",
    {
      title: "Buy a Roster listing",
      description:
        "Buy one listing (usually a listingId from roster_need) through escrow and wait for delivery. You pay only when the result validates; otherwise you are refunded. Datasets return signed JSON/CSV download links valid for one hour; lookups and feeds return rows inline. Omit buyerAgentId to pay from the account's 'Roster buyer' agent, topped up from the treasury.",
      inputSchema: {
        listingId: z.string().describe("Listing id, e.g. from roster_need."),
        input: jsonObject.optional().describe("Listing input, e.g. {\"base\":\"EUR\",\"symbols\":[\"USD\"]}."),
        buyerAgentId: z.string().optional().describe("Pay from this agent instead of the default buyer."),
      },
    },
    async ({ listingId, input, buyerAgentId }) =>
      runTool(async () => {
        const body: BuyInput = { listingId };
        if (input !== undefined) body.input = input;
        if (buyerAgentId !== undefined) body.buyerAgentId = buyerAgentId;
        return summarizeBuyResult(await client.buy(body));
      }),
  );

  server.registerTool(
    "roster_search",
    {
      title: "Search the Roster capability registry",
      description:
        "Search active capability manifests by query, price, latency, and optional passport score. Listings from every organization are visible. Ranking matches GET /v1/registry/search.",
      inputSchema: {
        q: z.string().optional().describe("Natural-language query, for example parse receipts."),
        tags: z.array(z.string()).optional().describe("Tags the listing must include."),
        maxPriceUsdc: z.string().optional().describe("Maximum pricing hint in USDC."),
        maxP95Ms: z.number().int().optional().describe("Maximum p95 latency in milliseconds."),
        limit: z.number().int().positive().optional().describe("Maximum number of hits."),
        minScore: z.number().optional().describe("Passport floor from 0 to 100. Also blends reputation."),
        withReputation: z.boolean().optional().describe("Blend passport scores into the rank."),
        semantic: z
          .boolean()
          .optional()
          .describe("Rank by stored semantic similarity (cosine). Omit for keyword search."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool(() => client.registry.search(searchQuery(args))),
  );

  server.registerTool(
    "roster_create_job",
    {
      title: "Open a Roster marketplace job",
      description:
        "Search the registry with the reputation blend, take the top listing, and lock escrow from the buyer agent. The seller may belong to another organization. The listing must already be bound to a seller agent.",
      inputSchema: {
        buyerAgentId: z.string().describe("Buyer agent in this account."),
        query: z.string().describe("Capability search query."),
        amountUsdc: z.string().describe("USDC to lock in escrow."),
        schema: jsonObject.describe("JSON Schema the seller result must match."),
        tags: z.array(z.string()).optional(),
        maxP95Ms: z.number().int().optional(),
        memo: z.string().optional(),
        input: z
          .unknown()
          .optional()
          .describe("Buyer payload for a first-party sandbox fixture. Omit it for the schema-valid sample."),
      },
    },
    async (args) => runTool(async () => summarizeJobResult(await client.jobs.create(jobInput(args)))),
  );

  server.registerTool(
    "roster_submit_job_result",
    {
      title: "Submit a Roster job result",
      description:
        "Deliver the seller payload. The API key must belong to the seller organization. Escrow releases when the payload matches the schema, or refunds the buyer when it does not. The seller passport updates either way.",
      inputSchema: {
        jobId: z.string().describe("Job id returned by roster_create_job."),
        result: jsonObject.describe("Seller result object."),
        latencyMs: z.number().int().nonnegative().optional().describe("Observed latency. Defaults to the listing p95."),
      },
    },
    async ({ jobId, result, latencyMs }) =>
      runTool(() =>
        latencyMs === undefined
          ? client.jobs.submit(jobId, result)
          : client.jobs.submit(jobId, result, { latencyMs }),
      ),
  );

  server.registerTool(
    "roster_expire_jobs",
    {
      title: "Expire Roster jobs past their SLA",
      description:
        "Refund every held marketplace job visible to this account whose listing SLA has passed. The buyer is refunded in full, the job becomes timed_out, and the seller passport records a failure. No take-rate is collected. Jobs still inside the window stay locked. Returns the jobs that just timed out.",
      inputSchema: {},
    },
    async () => runTool(() => client.jobs.expire()),
  );

  server.registerTool(
    "roster_listing",
    {
      title: "Roster listing details",
      description: "Fetch one capability listing by id (schemas, price, tags, data product metadata).",
      inputSchema: {
        listingId: z.string().describe("Listing id from roster_need or roster_search."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ listingId }) => runTool(() => client.registry.get(listingId)),
  );

  server.registerTool(
    "roster_job",
    {
      title: "Roster job status",
      description: "Read one marketplace job by id: status, amounts, escrow, validation errors.",
      inputSchema: {
        jobId: z.string().describe("Job id from roster_buy or roster_create_job."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => runTool(async () => summarizeJobResult(await client.jobs.get(jobId))),
  );

  server.registerTool(
    "roster_passport",
    {
      title: "Read a Roster passport",
      description:
        "Read the public reputation passport for an agent. Any authenticated Roster account can read it. The score uses formula roster.passport.v1.",
      inputSchema: {
        agentId: z.string().describe("Agent id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId }) => runTool(() => client.reputation.passport(agentId)),
  );

  return server;
}

async function runTool(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await work();
    if (value === null || value === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: "empty_tool_result: Roster tool returned no payload." }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    const message = error instanceof AlbesaError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Roster tool failed.";
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/** Compact hire/settlement summary for MCP (avoids huge result payloads / null text). */
export function summarizeBuyResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AlbesaError(502, "empty_tool_result", "Roster buy returned an empty response.");
  }
  const job = isRecord(value.job) ? value.job : {};
  const receipt = isRecord(value.receipt) ? value.receipt : null;
  return {
    status: value.status ?? job.status ?? null,
    delivered: value.delivered ?? (value.status === "released" || job.status === "released"),
    jobId: typeof job.id === "string" ? job.id : null,
    escrowId: typeof job.escrowId === "string" ? job.escrowId : receipt && typeof receipt.escrowId === "string" ? receipt.escrowId : null,
    amountUsdc: typeof job.amountUsdc === "string" ? job.amountUsdc : receipt && typeof receipt.amountUsdc === "string" ? receipt.amountUsdc : null,
    escrowMode: typeof job.escrowMode === "string" ? job.escrowMode : null,
    vaultAddress: typeof job.vaultAddress === "string" ? job.vaultAddress : null,
    vaultExplorerUrl: typeof job.vaultExplorerUrl === "string" ? job.vaultExplorerUrl : null,
    programId: typeof job.programId === "string" ? job.programId : null,
    programExplorerUrl: typeof job.programExplorerUrl === "string" ? job.programExplorerUrl : null,
    lockProviderRef: typeof job.lockProviderRef === "string" ? job.lockProviderRef : null,
    settlementProviderRef: typeof job.settlementProviderRef === "string" ? job.settlementProviderRef : null,
    lockExplorerUrl: typeof job.lockExplorerUrl === "string" ? job.lockExplorerUrl : null,
    settlementExplorerUrl: typeof job.settlementExplorerUrl === "string" ? job.settlementExplorerUrl : null,
    receipt,
    resultPreview: previewUnknown(value.result ?? job.result),
  };
}

export function summarizeJobResult(value: unknown): Record<string, unknown> {
  const job = isRecord(value) && isRecord(value.job) ? value.job : isRecord(value) ? value : null;
  if (!job) {
    throw new AlbesaError(502, "empty_tool_result", "Roster job tool returned an empty response.");
  }
  return {
    id: typeof job.id === "string" ? job.id : null,
    status: typeof job.status === "string" ? job.status : null,
    listingId: typeof job.listingId === "string" ? job.listingId : null,
    amountUsdc: typeof job.amountUsdc === "string" ? job.amountUsdc : null,
    escrowId: typeof job.escrowId === "string" ? job.escrowId : null,
    escrowMode: typeof job.escrowMode === "string" ? job.escrowMode : null,
    vaultAddress: typeof job.vaultAddress === "string" ? job.vaultAddress : null,
    vaultExplorerUrl: typeof job.vaultExplorerUrl === "string" ? job.vaultExplorerUrl : null,
    programId: typeof job.programId === "string" ? job.programId : null,
    programExplorerUrl: typeof job.programExplorerUrl === "string" ? job.programExplorerUrl : null,
    lockProviderRef: typeof job.lockProviderRef === "string" ? job.lockProviderRef : null,
    settlementProviderRef: typeof job.settlementProviderRef === "string" ? job.settlementProviderRef : null,
    lockExplorerUrl: typeof job.lockExplorerUrl === "string" ? job.lockExplorerUrl : null,
    settlementExplorerUrl: typeof job.settlementExplorerUrl === "string" ? job.settlementExplorerUrl : null,
    resultPreview: previewUnknown(job.result),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewUnknown(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined) return null;
    if (raw.length <= 500) return value;
    return { truncated: true, bytes: raw.length, preview: `${raw.slice(0, 400)}…` };
  } catch {
    return { unserializable: true };
  }
}

function searchQuery(args: {
  q?: string | undefined;
  tags?: string[] | undefined;
  maxPriceUsdc?: string | undefined;
  maxP95Ms?: number | undefined;
  limit?: number | undefined;
  minScore?: number | undefined;
  withReputation?: boolean | undefined;
  semantic?: boolean | undefined;
}): RegistrySearchQuery {
  const query: RegistrySearchQuery = {};
  if (args.q !== undefined) query.q = args.q;
  if (args.tags !== undefined) query.tags = args.tags;
  if (args.maxPriceUsdc !== undefined) query.maxPriceUsdc = args.maxPriceUsdc;
  if (args.maxP95Ms !== undefined) query.maxP95Ms = args.maxP95Ms;
  if (args.limit !== undefined) query.limit = args.limit;
  if (args.minScore !== undefined) query.minScore = args.minScore;
  if (args.withReputation !== undefined) query.withReputation = args.withReputation;
  if (args.semantic !== undefined) query.semantic = args.semantic;
  return query;
}

function jobInput(args: {
  buyerAgentId: string;
  query: string;
  amountUsdc: string;
  schema: Record<string, unknown>;
  tags?: string[] | undefined;
  maxP95Ms?: number | undefined;
  memo?: string | undefined;
  input?: unknown;
}): CreateJobInput {
  const input: CreateJobInput = {
    buyerAgentId: args.buyerAgentId,
    query: args.query,
    amountUsdc: args.amountUsdc,
    schema: args.schema,
  };
  if (args.tags !== undefined) input.tags = args.tags;
  if (args.maxP95Ms !== undefined) input.maxP95Ms = args.maxP95Ms;
  if (args.memo !== undefined) input.memo = args.memo;
  if (args.input !== undefined) input.input = args.input;
  return input;
}
