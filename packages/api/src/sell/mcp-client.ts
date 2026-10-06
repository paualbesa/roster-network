import { EgressError, type SafeFetcher } from "./net.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface McpSession {
  serverName: string;
  serverVersion: string;
  instructions: string | null;
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export async function openMcpSession(fetcher: SafeFetcher, url: string, options: { timeoutMs?: number } = {}): Promise<McpSession> {
  let sessionId: string | null = null;
  let nextId = 1;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const post = async (payload: Record<string, unknown>) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetcher(url, { method: "POST", headers, body: JSON.stringify(payload), timeoutMs, maxBytes: 2 * 1024 * 1024, maxRedirects: 1 });
    if (response.headers["mcp-session-id"]) sessionId = response.headers["mcp-session-id"];
    return response;
  };
  const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    const response = await post({ jsonrpc: "2.0", id, method, params });
    if (response.status === 401 || response.status === 403) throw new McpError("The MCP server requires authentication. Roster can only proxy public servers today.");
    if (response.status < 200 || response.status >= 300) throw new McpError(`MCP server answered HTTP ${response.status.toString()} to ${method}.`);
    const message = readRpcMessage(response.body, response.headers["content-type"] ?? "", id);
    if (!message) throw new McpError(`MCP server sent no JSON-RPC answer to ${method}.`);
    if (isRecord(message.error)) {
      throw new McpError(`MCP ${method} failed: ${String(message.error.message ?? "error").slice(0, 200)}`);
    }
    if (!isRecord(message.result)) throw new McpError(`MCP ${method} returned no result.`);
    return message.result;
  };
  const init = await request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "roster-network", version: "1.0.0" },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch((error: unknown) => {
    if (!(error instanceof EgressError)) throw error;
  });
  const info = isRecord(init.serverInfo) ? init.serverInfo : {};
  return {
    serverName: typeof info.name === "string" ? info.name.slice(0, 60) : new URL(url).hostname,
    serverVersion: typeof info.version === "string" ? info.version.slice(0, 30) : "",
    instructions: typeof init.instructions === "string" ? init.instructions.slice(0, 1000) : null,
    request,
  };
}

export async function listMcpTools(session: McpSession, max = 40): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4 && tools.length < max; page += 1) {
    const result = await session.request("tools/list", cursor ? { cursor } : {});
    const list = Array.isArray(result.tools) ? result.tools : [];
    for (const raw of list) {
      if (!isRecord(raw) || typeof raw.name !== "string") continue;
      tools.push({
        name: raw.name,
        ...(typeof raw.title === "string" ? { title: raw.title } : {}),
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        ...(isRecord(raw.inputSchema) ? { inputSchema: raw.inputSchema } : {}),
        ...(isRecord(raw.outputSchema) ? { outputSchema: raw.outputSchema } : {}),
      });
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools.slice(0, max);
}

/** Pull the JSON-RPC message with `id` out of a JSON body or an SSE stream. */
export function readRpcMessage(body: string, contentType: string, id: number): Record<string, unknown> | null {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // Ignore keep-alive or non-JSON events.
      }
    }
  } else {
    try {
      candidates.push(JSON.parse(body));
    } catch {
      return null;
    }
  }
  for (const candidate of candidates.flatMap((value) => (Array.isArray(value) ? value : [value]))) {
    if (isRecord(candidate) && candidate.id === id) return candidate;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
