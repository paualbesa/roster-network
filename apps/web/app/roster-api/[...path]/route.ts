import { NextResponse } from "next/server";
import { resolveRosterApiOrigin, rosterProxyTarget } from "@/lib/api-base";
import { buildProxyHeaders } from "@/lib/admin-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

const FORWARD_RESPONSE = [
  "content-type",
  "x-request-id",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "idempotent-replayed",
  "cache-control",
  "content-disposition",
] as const;

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  let target: string;
  try {
    const url = new URL(request.url);
    target = rosterProxyTarget(resolveRosterApiOrigin(), path, url.search);
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "Roster API path is not allowed." } },
      { status: 400 },
    );
  }

  const headers = buildProxyHeaders(request.headers, path);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    cache: "no-store",
  };
  if (hasBody) init.body = await request.arrayBuffer();
  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return NextResponse.json(
      { error: { code: "unavailable", message: "Roster API is unreachable from this site." } },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
