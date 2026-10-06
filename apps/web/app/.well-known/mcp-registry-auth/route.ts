import { NextResponse } from "next/server";

/** Public Ed25519 proof for MCP Registry HTTP authentication (namespace network.roster/*). */
const PROOF = 'v=MCPv1; k=ed25519; p=/fewnKgTy6iCIZpM9VVp9LWM1/Lue51zyz2lMVHutho=';

export const dynamic = "force-static";

export function GET(): Response {
  return new NextResponse(`${PROOF}\n`, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
