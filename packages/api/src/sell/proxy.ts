import type { ExternalFulfiller, ExternalListingRef } from "../jobs.js";
import { openMcpSession } from "./mcp-client.js";
import type { SafeFetcher } from "./net.js";
import type { SellerEndpoint } from "./import.js";
import type { SellerDirectory } from "./sellers.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;

/**
 * Fulfils imported listings by calling the seller's endpoint. Any throw is
 * turned into `{ error }` by the orchestrator, which fails the output schema and
 * refunds the buyer through escrow.
 */
export class SellerProxy implements ExternalFulfiller {
  constructor(
    private readonly sellers: SellerDirectory,
    private readonly fetcher: SafeFetcher,
    private readonly timeoutFor: (listingId: string) => number = () => MAX_TIMEOUT_MS,
  ) {}

  handles(listing: ExternalListingRef): boolean {
    const record = this.sellers.endpointFor(listing.id);
    return record !== null && record.organizationId === listing.organizationId;
  }

  async fulfill(listing: ExternalListingRef, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const record = this.sellers.endpointFor(listing.id);
    if (!record || record.organizationId !== listing.organizationId) throw new Error("Seller endpoint not found.");
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, this.timeoutFor(listing.id)));
    return callSellerEndpoint(this.fetcher, record.endpoint, input, timeoutMs);
  }
}

export async function callSellerEndpoint(
  fetcher: SafeFetcher,
  endpoint: SellerEndpoint,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  if (endpoint.type === "mcp") {
    const args = JSON.stringify(input);
    if (args.length > MAX_REQUEST_BYTES) throw new Error("Input is too large to forward.");
    const session = await openMcpSession(fetcher, endpoint.url, { timeoutMs });
    const result = await session.request("tools/call", { name: endpoint.toolName, arguments: input });
    if (result.isError === true) throw new Error(`Seller tool reported an error: ${firstText(result.content)}`.slice(0, 300));
    const content = Array.isArray(result.content) ? result.content : [];
    return {
      content,
      ...(typeof result.structuredContent === "object" && result.structuredContent !== null ? { structuredContent: result.structuredContent } : {}),
    };
  }
  const { url, body } = buildOpenApiRequest(endpoint, input);
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetcher(url, { method: endpoint.method, headers, ...(body !== undefined ? { body } : {}), timeoutMs, maxBytes: MAX_RESPONSE_BYTES, maxRedirects: 1 });
  if (response.status < 200 || response.status >= 300) throw new Error(`Seller endpoint answered HTTP ${response.status.toString()}.`);
  let data: unknown = null;
  if (response.body.trim() !== "") {
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new Error("Seller endpoint did not return JSON.");
    }
  }
  return { status: response.status, data };
}

export function buildOpenApiRequest(endpoint: Extract<SellerEndpoint, { type: "openapi" }>, input: Record<string, unknown>): { url: string; body?: string } {
  let path = endpoint.url;
  const query = new URLSearchParams();
  for (const param of endpoint.params) {
    const value = input[param.name];
    if (param.in === "path") {
      if (value === undefined || value === null || value === "") throw new Error(`Missing path parameter ${param.name}.`);
      path = path.split(`{${param.name}}`).join(encodeURIComponent(scalar(value)));
    } else if (value !== undefined && value !== null) {
      if (Array.isArray(value)) for (const item of value) query.append(param.name, scalar(item));
      else query.append(param.name, scalar(value));
    }
  }
  if (/\{[^}]+\}/.test(new URL(path).pathname)) throw new Error("Unresolved path parameter.");
  const target = new URL(path);
  for (const [key, value] of query) target.searchParams.append(key, value);
  if (!endpoint.hasBody || input.body === undefined) return { url: target.toString() };
  const body = JSON.stringify(input.body);
  if (body.length > MAX_REQUEST_BYTES) throw new Error("Request body is too large to forward.");
  return { url: target.toString(), body };
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "error";
  const text = content.find((item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
  return typeof text?.text === "string" ? text.text.slice(0, 200) : "error";
}
