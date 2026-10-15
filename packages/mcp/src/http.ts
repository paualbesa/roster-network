import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRosterMcpServer, type RosterMcpOptions } from "./server.js";

export interface RemoteMcpHandlerOptions {
  /** Origin the MCP tools use when calling Roster HTTP (usually the same API). */
  apiBaseUrl: string;
  /** Injected fetch for tests (e.g. app.request). */
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Hosted Streamable HTTP MCP endpoint.
 * Authenticate with `Authorization: Bearer <sandbox API key>` (same key as the REST API).
 * Stateless JSON responses (`enableJsonResponse`) so each request carries its own auth.
 */
/** Largest JSON-RPC body accepted on the hosted endpoint. */
export const MCP_MAX_BODY_BYTES = 256 * 1024;

/** Client-address headers forwarded to the API so per-address limits apply per caller, not per MCP process. */
const CLIENT_ADDRESS_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"] as const;

function withClientAddress(base: typeof fetch, incoming: Headers): typeof fetch {
  const forwarded: [string, string][] = [];
  for (const name of CLIENT_ADDRESS_HEADERS) {
    const value = incoming.get(name);
    if (value) forwarded.push([name, value.slice(0, 256)]);
  }
  if (forwarded.length === 0) return base;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of forwarded) headers.set(name, value);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

export function createRemoteMcpFetchHandler(options: RemoteMcpHandlerOptions): (request: Request) => Promise<Response> {
  const baseUrl = options.apiBaseUrl.replace(/\/$/, "");

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    const apiKey = readBearer(request.headers.get("authorization"));
    if (!apiKey) {
      return jsonResponse(
        401,
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Send Authorization: Bearer <Roster API key>." },
          id: null,
        },
        request,
      );
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_BODY_BYTES) {
      return payloadTooLarge(request);
    }

    const server = createRosterMcpServer({
      apiKey,
      baseUrl,
      fetch: withClientAddress(options.fetch ?? globalThis.fetch.bind(globalThis), request.headers),
      ...(options.env ? { env: options.env } : {}),
    } satisfies RosterMcpOptions);

    // Stateless (no session id): a fresh server + transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);

    try {
      let parsedBody: unknown;
      if (request.method !== "GET" && request.method !== "HEAD") {
        const bodyBuf = Buffer.from(await request.arrayBuffer());
        if (bodyBuf.length > MCP_MAX_BODY_BYTES) return payloadTooLarge(request);
        const text = bodyBuf.toString("utf8").trim();
        parsedBody = text ? JSON.parse(text) : undefined;
      }
      const response = await transport.handleRequest(request, { parsedBody });
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(request))) {
        headers.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : "MCP request failed.";
      return jsonResponse(400, { jsonrpc: "2.0", error: { code: -32700, message }, id: null }, request);
    } finally {
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  };
}

function payloadTooLarge(request: Request): Response {
  return jsonResponse(
    413,
    {
      jsonrpc: "2.0",
      error: { code: -32600, message: `Request body must be at most ${(MCP_MAX_BODY_BYTES / 1024).toString()} KB.` },
      id: null,
    },
    request,
  );
}

export function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-expose-headers": "mcp-session-id, content-type",
    vary: "Origin",
  };
}

function jsonResponse(status: number, body: unknown, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(request),
    },
  });
}

export const ROSTER_REMOTE_MCP_URL = "https://roster.network/mcp";

export function remoteMcpConfigCard(apiKey: string): { url: string; header: string; value: string } {
  return {
    url: ROSTER_REMOTE_MCP_URL,
    header: "Authorization",
    value: `Bearer ${apiKey.trim() || "sk_sandbox_YOUR_KEY"}`,
  };
}

export function remoteMcpClientJson(apiKey: string, host: "claude-desktop" | "cursor" | "generic" = "cursor"): string {
  const key = apiKey.trim() || "sk_sandbox_YOUR_KEY";
  const server = {
    url: ROSTER_REMOTE_MCP_URL,
    headers: {
      Authorization: `Bearer ${key}`,
    },
  };
  if (host === "generic") return JSON.stringify({ roster: server }, null, 2);
  return JSON.stringify({ mcpServers: { roster: server } }, null, 2);
}

/** Test helper: unused UUID keeps lint quiet when bridging. */
export function newMcpRequestId(): string {
  return randomUUID();
}

/** Mount Streamable HTTP MCP on a Hono (or compatible) app at `/mcp`. */
export function attachRosterMcp(
  app: {
    on: (...args: never[]) => unknown;
    request: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;
  },
  options: { mode?: string; env?: Record<string, string | undefined> } = {},
): void {
  const mode = options.mode ?? "sandbox";
  const mcpFetch = createRemoteMcpFetchHandler({
    apiBaseUrl: "http://roster.internal",
    fetch: (input, init) => Promise.resolve(app.request(input as string | URL | Request, init)),
    env: { ROSTER_MODE: mode, ...(options.env ?? {}) },
  });
  const route = async (c: { req: { raw: Request } }) => mcpFetch(c.req.raw);
  (app.on as (methods: string[], path: string, handler: typeof route) => unknown)(
    ["GET", "POST", "DELETE", "OPTIONS"],
    "/mcp",
    route,
  );
  (app.on as (methods: string[], path: string, handler: typeof route) => unknown)(
    ["GET", "POST", "DELETE", "OPTIONS"],
    "/mcp/",
    route,
  );
}
