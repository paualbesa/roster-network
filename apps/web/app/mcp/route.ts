import { NextResponse } from "next/server";
import { resolveRosterApiOrigin } from "@/lib/api-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FORWARD = [
  "content-type",
  "mcp-session-id",
  "cache-control",
  "retry-after",
] as const;

async function proxy(request: Request): Promise<Response> {
  const origin = resolveRosterApiOrigin();
  const url = new URL(request.url);
  const target = `${origin.replace(/\/$/, "")}/mcp${url.search}`;

  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const session = request.headers.get("mcp-session-id");
  if (session) headers.set("mcp-session-id", session);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    cache: "no-store",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return NextResponse.json(
      { error: { code: "unavailable", message: "Roster MCP upstream is unreachable." } },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARD) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const originHeader = request.headers.get("origin");
  if (originHeader) {
    responseHeaders.set("access-control-allow-origin", originHeader);
    responseHeaders.set("vary", "Origin");
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin") ?? "*";
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id",
    },
  });
}
