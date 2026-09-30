import { NextResponse } from "next/server";
import { resolveRosterApiOrigin, rosterProxyTarget } from "@/lib/api-base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

const FORWARD_REQUEST = ["authorization", "content-type", "accept"] as const;
const FORWARD_RESPONSE = ["content-type"] as const;

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

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

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
