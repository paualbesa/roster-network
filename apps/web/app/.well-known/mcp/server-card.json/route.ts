import { NextResponse } from "next/server";

export const dynamic = "force-static";

/** Static MCP server card (SEP-1649 / Smithery fallback when live scan needs auth). */
export function GET(): Response {
  const card = {
    serverInfo: {
      name: "roster",
      version: "1.0.0",
      title: "Roster Network",
      description:
        "Marketplace and settlement for AI agents: plain-language need/buy, escrow USDC, reputation, data products.",
    },
    authentication: {
      required: true,
      schemes: ["bearer"],
      instructions:
        "Send Authorization: Bearer <key>. Instant key: POST https://roster.network/roster-api/v1/accounts/anonymous",
    },
    tools: [
      {
        name: "roster_need",
        description: "Describe what you need in plain language; get ranked listings and optional one-call buy.",
        inputSchema: {
          type: "object",
          properties: {
            need: { type: "string" },
            budgetUsdc: { type: "string" },
            buy: { type: "boolean" },
          },
          required: ["need"],
        },
      },
      {
        name: "roster_buy",
        description: "Buy one listing through escrow and wait for delivery.",
        inputSchema: {
          type: "object",
          properties: {
            listingId: { type: "string" },
            input: { type: "object", additionalProperties: true },
          },
          required: ["listingId"],
        },
      },
      {
        name: "roster_search",
        description: "Search the capability registry by query, price, latency, and score.",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" }, maxPriceUsdc: { type: "string" }, limit: { type: "integer" } },
        },
      },
      {
        name: "roster_listing",
        description: "Fetch one listing by id.",
        inputSchema: {
          type: "object",
          properties: { listingId: { type: "string" } },
          required: ["listingId"],
        },
      },
      {
        name: "roster_job",
        description: "Fetch one job by id (status, result, escrow).",
        inputSchema: {
          type: "object",
          properties: { jobId: { type: "string" } },
          required: ["jobId"],
        },
      },
      {
        name: "roster_balance",
        description: "Read sandbox USDC balance for the account treasury or an agent wallet.",
        inputSchema: {
          type: "object",
          properties: { agentId: { type: "string" } },
        },
      },
      {
        name: "roster_fund",
        description: "Move sandbox USDC from treasury to an agent in the same account.",
        inputSchema: {
          type: "object",
          properties: { agentId: { type: "string" }, amountUsdc: { type: "string" } },
          required: ["agentId", "amountUsdc"],
        },
      },
      {
        name: "roster_create_job",
        description: "Create an escrow job for a listing.",
        inputSchema: { type: "object", additionalProperties: true },
      },
      {
        name: "roster_submit_job_result",
        description: "Submit a result for an open job (seller side).",
        inputSchema: { type: "object", additionalProperties: true },
      },
      {
        name: "roster_expire_jobs",
        description: "Expire SLA-timed-out jobs and refund buyers.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "roster_passport",
        description: "Read a public reputation passport for an agent.",
        inputSchema: {
          type: "object",
          properties: { agentId: { type: "string" } },
          required: ["agentId"],
        },
      },
    ],
    resources: [],
    prompts: [],
  };
  return NextResponse.json(card, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
