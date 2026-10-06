import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

    const server = createRosterMcpServer({
      apiKey,
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.env ? { env: options.env } : {}),
    } satisfies RosterMcpOptions);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    try {
      let parsedBody: unknown;
      let bodyBuf = Buffer.alloc(0);
      if (request.method !== "GET" && request.method !== "HEAD") {
        bodyBuf = Buffer.from(await request.arrayBuffer());
        const text = bodyBuf.toString("utf8").trim();
        parsedBody = text ? JSON.parse(text) : undefined;
      }
      const { req, res, done } = bridgeBuffersToNode(request, bodyBuf);
      await transport.handleRequest(req, res, parsedBody);
      const response = await done;
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

/**
 * Minimal IncomingMessage / ServerResponse bridge so StreamableHTTPServerTransport
 * can run inside Hono / Next fetch handlers.
 */
function bridgeBuffersToNode(request: Request, bodyBuf: Buffer): {
  req: IncomingMessage;
  res: ServerResponse;
  done: Promise<Response>;
} {
  const url = new URL(request.url);
  const req = Readable.from(bodyBuf) as IncomingMessage;
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  req.headers = {};
  request.headers.forEach((value, key) => {
    req.headers[key.toLowerCase()] = value;
  });
  if (!req.headers["content-length"]) {
    req.headers["content-length"] = String(bodyBuf.length);
  }

  let statusCode = 200;
  const responseHeaders = new Headers();
  const chunks: Buffer[] = [];
  let resolveDone!: (response: Response) => void;
  const done = new Promise<Response>((resolve) => {
    resolveDone = resolve;
  });

  const resState = {
    statusCode,
    headersSent: false,
    writableEnded: false,
  };
  const res = {
    get statusCode() {
      return resState.statusCode;
    },
    set statusCode(code: number) {
      resState.statusCode = code;
      statusCode = code;
    },
    get headersSent() {
      return resState.headersSent;
    },
    get writableEnded() {
      return resState.writableEnded;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    },
    getHeader(name: string) {
      return responseHeaders.get(name) ?? undefined;
    },
    getHeaders() {
      const out: Record<string, string> = {};
      responseHeaders.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    },
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      statusCode = code;
      resState.statusCode = code;
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
        }
      }
      resState.headersSent = true;
      return this;
    },
    write(chunk: unknown) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buf);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) { const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); chunks.push(buf); }
      resState.writableEnded = true;
      resState.headersSent = true;
      resolveDone(
        new Response(Buffer.concat(chunks), {
          status: statusCode,
          headers: responseHeaders,
        }),
      );
      return this;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
    removeListener() {
      return this;
    },
    flushHeaders() {
      resState.headersSent = true;
    },
  } as unknown as ServerResponse;


  // Ensure a response even if transport never calls end (e.g. early return writing directly).
  queueMicrotask(() => {
    if (!resState.writableEnded && resState.headersSent && chunks.length > 0) {
      (res as unknown as { end: (chunk?: unknown) => unknown }).end();
    }
  });

  return { req, res, done };
}

/** Stable public MCP URL for docs and the console. */
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
