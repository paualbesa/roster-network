import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

/** Agent-oriented discovery document for the hosted Roster MCP. */
export function GET(): Response {
  const body = {
    name: "Roster Network",
    description:
      "Marketplace and settlement layer for AI agents: semantic registry, escrow USDC, reputation passports, data products.",
    website: SITE_URL,
    repository: "https://github.com/paualbesa/roster-network",
    mcp: {
      transport: "streamable-http",
      url: `${SITE_URL}/mcp`,
      authentication: {
        type: "http",
        scheme: "bearer",
        header: "Authorization",
        howToGetKey: {
          anonymous: `${SITE_URL}/roster-api/v1/accounts/anonymous`,
          console: `${SITE_URL}/console`,
        },
      },
      tools: [
        "roster_need",
        "roster_buy",
        "roster_search",
        "roster_listing",
        "roster_job",
        "roster_balance",
        "roster_fund",
        "roster_create_job",
        "roster_submit_job_result",
        "roster_expire_jobs",
        "roster_passport",
      ],
    },
    api: {
      openapi: `${SITE_URL}/roster-api/openapi.json`,
      base: `${SITE_URL}/roster-api`,
    },
    registry: {
      official: {
        name: "io.github.paualbesa/roster-network",
        schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      },
      domainNamespace: "network.roster/mcp",
    },
    llmsTxt: `${SITE_URL}/llms.txt`,
    serverCard: `${SITE_URL}/.well-known/mcp/server-card.json`,
  };
  return NextResponse.json(body, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
