import { parseSearchQuery, type CapabilityRegistry, type RawSearchParams } from "@albesa/registry";
import { load as loadYaml } from "js-yaml";
import { listMcpTools, McpError, openMcpSession } from "./mcp-client.js";
import { assertSafeUrl, EgressError, type SafeFetcher } from "./net.js";
import { isRecord, mcpOutputSchema, openApiOutputSchema, resolveLocalRefs, toInputSchema } from "./schema.js";

type Json = Record<string, unknown>;

export type SellerEndpoint =
  | {
      type: "openapi";
      /** Base URL + path template, e.g. https://api.example.com/v1/pet/{petId}. */
      url: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      params: { name: string; in: "path" | "query" }[];
      hasBody: boolean;
    }
  | { type: "mcp"; url: string; toolName: string; structured: boolean };

export interface ImportedDraft {
  name: string;
  description: string;
  inputSchema: Json;
  outputSchema: Json;
  suggestedPriceUsdc: string;
  priceBasis: string;
  similar: { id: string; name: string; priceUsdc: string; relevance: number }[];
  p95Ms: number;
  tags: string[];
  endpoint: SellerEndpoint;
  warnings: string[];
  example: Json;
}

export interface ImportResult {
  source: { type: "openapi" | "mcp"; url: string; title: string; version: string };
  drafts: ImportedDraft[];
  skipped: { item: string; reason: string }[];
}

export class ImportError extends Error {
  constructor(
    readonly status: 400 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export const DEFAULT_PRICE_USDC = "0.010";
const MAX_DRAFTS = 25;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export async function importSource(
  url: string,
  deps: { fetcher: SafeFetcher; registry: CapabilityRegistry; allowHttp?: boolean },
  kind: "auto" | "mcp" | "openapi" = "auto",
): Promise<ImportResult> {
  try {
    assertSafeUrl(url, { allowHttp: deps.allowHttp === true });
  } catch (error) {
    if (error instanceof EgressError) throw new ImportError(400, error.code, error.message);
    throw error;
  }
  const looksMcp = /\/(mcp|sse)\/?(\?.*)?$/i.test(url);
  const order: ("mcp" | "openapi")[] = kind !== "auto" ? [kind] : looksMcp ? ["mcp", "openapi"] : ["openapi", "mcp"];
  const errors: string[] = [];
  for (const attempt of order) {
    try {
      const result = attempt === "openapi" ? await importOpenApi(url, deps.fetcher) : await importMcp(url, deps.fetcher);
      for (const draft of result.drafts) priceDraft(draft, deps.registry);
      return result;
    } catch (error) {
      if (error instanceof EgressError && (error.code === "invalid_url" || error.code === "blocked_destination")) {
        throw new ImportError(400, error.code, error.message);
      }
      errors.push(`${attempt}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  throw new ImportError(422, "import_failed", `Could not read an MCP server or an OpenAPI document at that URL. ${errors.join(" · ")}`.slice(0, 600));
}

async function importOpenApi(url: string, fetcher: SafeFetcher): Promise<ImportResult> {
  const response = await fetcher(url, { headers: { accept: "application/json, application/yaml, text/yaml, */*" }, timeoutMs: 12_000, maxBytes: 4 * 1024 * 1024 });
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status.toString()}`);
  let doc: unknown;
  try {
    doc = JSON.parse(response.body);
  } catch {
    try {
      doc = loadYaml(response.body, { json: true });
    } catch {
      throw new Error("not JSON or YAML");
    }
  }
  if (!isRecord(doc) || (typeof doc.openapi !== "string" && typeof doc.swagger !== "string")) throw new Error("not an OpenAPI document");
  const info = isRecord(doc.info) ? doc.info : {};
  const title = typeof info.title === "string" ? info.title.trim().slice(0, 60) : new URL(url).hostname;
  const base = baseUrl(doc, response.url || url);
  const drafts: ImportedDraft[] = [];
  const skipped: ImportResult["skipped"] = [];
  const paths = isRecord(doc.paths) ? doc.paths : {};
  const globalSecurity = Array.isArray(doc.security) && doc.security.length > 0;
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (drafts.length >= MAX_DRAFTS) {
        skipped.push({ item: label, reason: `Only the first ${MAX_DRAFTS.toString()} operations are imported.` });
        continue;
      }
      if (op.deprecated === true) {
        skipped.push({ item: label, reason: "Deprecated operation." });
        continue;
      }
      const built = buildOperation(doc, base, path, method, op, shared);
      if ("reason" in built) {
        skipped.push({ item: label, reason: built.reason });
        continue;
      }
      const security = Array.isArray(op.security) ? op.security.length > 0 : globalSecurity;
      const warnings = security ? ["The API declares authentication. Roster calls it without credentials: keep this only if it works anonymously."] : [];
      const summary = typeof op.summary === "string" ? op.summary.trim() : "";
      const opId = typeof op.operationId === "string" ? op.operationId.trim() : "";
      const name = clip(`${title}: ${summary || humanize(opId) || label}`, 80);
      const description = clip(
        [typeof op.description === "string" ? op.description.trim() : summary || label, `Proxied by Roster to ${label} on ${new URL(base).host}.`].filter(Boolean).join(" "),
        3900,
      );
      const opTags = Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === "string") : [];
      drafts.push({
        name,
        description,
        inputSchema: built.inputSchema,
        outputSchema: built.outputSchema,
        suggestedPriceUsdc: DEFAULT_PRICE_USDC,
        priceBasis: "default",
        similar: [],
        p95Ms: 8000,
        tags: sanitizeTags(["openapi", ...opTags, ...title.split(/\s+/)]),
        endpoint: built.endpoint,
        warnings,
        example: built.example,
      });
    }
  }
  if (drafts.length === 0) throw new Error("no usable operations");
  return {
    source: { type: "openapi", url, title, version: typeof info.version === "string" ? info.version.slice(0, 30) : "" },
    drafts,
    skipped,
  };
}

function buildOperation(
  doc: Json,
  base: string,
  path: string,
  method: (typeof METHODS)[number],
  op: Json,
  shared: unknown[],
): { inputSchema: Json; outputSchema: Json; endpoint: SellerEndpoint; example: Json } | { reason: string } {
  const properties: Json = {};
  const required: string[] = [];
  const params: { name: string; in: "path" | "query" }[] = [];
  const example: Json = {};
  const all = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])];
  for (const raw of all) {
    const param = resolveLocalRefs(raw, doc);
    const where = param.in;
    if (typeof param.name !== "string") continue;
    if (where === "header" || where === "cookie") {
      if (param.required === true) return { reason: `Requires the ${String(where)} parameter ${param.name}.` };
      continue;
    }
    if (where !== "path" && where !== "query") continue;
    if (params.some((existing) => existing.name === param.name)) continue;
    params.push({ name: param.name, in: where });
    const schema = isRecord(param.schema) ? param.schema : { type: typeof param.type === "string" ? param.type : "string" };
    properties[param.name] = { ...schema, ...(typeof param.description === "string" ? { description: param.description.slice(0, 300) } : {}) };
    if (param.required === true || where === "path") required.push(param.name);
    const sample = exampleFor(param, schema);
    if (sample !== undefined && (param.required === true || where === "path")) example[param.name] = sample;
  }
  let hasBody = false;
  const requestBody = resolveLocalRefs(op.requestBody, doc);
  const content = isRecord(requestBody.content) ? requestBody.content : null;
  if (content) {
    const json = jsonMedia(content);
    if (!json) return { reason: "Request body is not JSON." };
    properties.body = toInputSchema(json.schema, doc);
    hasBody = true;
    if (requestBody.required === true) required.push("body");
  } else {
    // Swagger 2 body parameter.
    const bodyParam = all.map((raw) => resolveLocalRefs(raw, doc)).find((param) => param.in === "body");
    if (bodyParam) {
      properties.body = toInputSchema(bodyParam.schema, doc);
      hasBody = true;
      if (bodyParam.required === true) required.push("body");
    }
  }
  const responses = isRecord(op.responses) ? op.responses : {};
  const okKey = ["200", "201", "202", "2XX", "default"].find((key) => key in responses);
  const ok = okKey ? resolveLocalRefs(responses[okKey], doc) : {};
  const okContent = isRecord(ok.content) ? jsonMedia(ok.content) : null;
  const responseSchema = okContent ? resolveLocalRefs(okContent.schema, doc) : isRecord(ok.schema) ? resolveLocalRefs(ok.schema, doc) : null;
  if (isRecord(ok.content) && !okContent && Object.keys(ok.content).length > 0) return { reason: "Response is not JSON." };
  const inputSchema: Json = { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
  return {
    inputSchema: JSON.stringify(inputSchema).length > 15_000 ? toInputSchema(inputSchema) : inputSchema,
    outputSchema: openApiOutputSchema(responseSchema),
    endpoint: {
      type: "openapi",
      url: `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
      method: method.toUpperCase() as "GET",
      params,
      hasBody,
    },
    example,
  };
}

function jsonMedia(content: Json): Json | null {
  const key = Object.keys(content).find((type) => type === "application/json" || /\+json$/.test(type) || type === "*/*");
  const media = key ? content[key] : undefined;
  return isRecord(media) ? media : null;
}

function exampleFor(param: Json, schema: Json): unknown {
  if (param.example !== undefined) return param.example;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "array" && isRecord(schema.items) && Array.isArray(schema.items.enum) && schema.items.enum.length > 0) return schema.items.enum[0];
  return undefined;
}

function baseUrl(doc: Json, specUrl: string): string {
  if (Array.isArray(doc.servers) && isRecord(doc.servers[0]) && typeof doc.servers[0].url === "string") {
    const server = doc.servers[0];
    let raw = server.url as string;
    const variables = isRecord(server.variables) ? server.variables : {};
    raw = raw.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const variable = variables[name];
      return isRecord(variable) && typeof variable.default === "string" ? variable.default : "";
    });
    return new URL(raw, specUrl).toString();
  }
  if (typeof doc.host === "string") {
    const schemes = Array.isArray(doc.schemes) ? doc.schemes : [];
    const scheme = schemes.includes("https") || schemes.length === 0 ? "https" : String(schemes[0]);
    return `${scheme}://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}`;
  }
  return new URL("/", specUrl).toString();
}

async function importMcp(url: string, fetcher: SafeFetcher): Promise<ImportResult> {
  let session;
  try {
    session = await openMcpSession(fetcher, url);
  } catch (error) {
    if (error instanceof McpError || error instanceof EgressError) throw error;
    throw new Error("not an MCP Streamable HTTP endpoint");
  }
  const tools = await listMcpTools(session);
  if (tools.length === 0) throw new Error("the MCP server lists no tools");
  const title = session.serverName;
  const drafts: ImportedDraft[] = tools.slice(0, MAX_DRAFTS).map((tool) => {
    const label = tool.title?.trim() || humanize(tool.name);
    return {
      name: clip(`${title}: ${label}`, 80),
      description: clip(`${tool.description?.trim() || label}. MCP tool "${tool.name}" proxied by Roster.`, 3900),
      inputSchema: toInputSchema(tool.inputSchema ?? { type: "object" }),
      outputSchema: mcpOutputSchema(tool.outputSchema),
      suggestedPriceUsdc: DEFAULT_PRICE_USDC,
      priceBasis: "default",
      similar: [],
      p95Ms: 15_000,
      tags: sanitizeTags(["mcp", ...title.split(/[\s_-]+/), ...tool.name.split(/[\s_-]+/)]),
      endpoint: { type: "mcp", url, toolName: tool.name, structured: Boolean(tool.outputSchema) },
      warnings: [],
      example: {},
    };
  });
  const skipped = tools.slice(MAX_DRAFTS).map((tool) => ({ item: tool.name, reason: `Only the first ${MAX_DRAFTS.toString()} tools are imported.` }));
  return { source: { type: "mcp", url, title, version: session.serverVersion }, drafts, skipped };
}

/** Median price of the closest listings; falls back to the default. */
export function priceDraft(draft: ImportedDraft, registry: CapabilityRegistry): void {
  const q = `${draft.name} ${draft.description}`.slice(0, 400);
  let hits;
  try {
    hits = registry.search(parseSearchQuery(rawQuery(q, "8")));
  } catch {
    return;
  }
  const similar = hits.filter((hit) => hit.relevance >= 0.18).slice(0, 5);
  draft.similar = similar.map((hit) => ({
    id: hit.listing.id,
    name: hit.listing.name,
    priceUsdc: hit.listing.pricing.amountUsdc,
    relevance: Math.round(hit.relevance * 100) / 100,
  }));
  const prices = similar.map((hit) => Number(hit.listing.pricing.amountUsdc)).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (prices.length === 0) return;
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 1 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2;
  draft.suggestedPriceUsdc = Math.min(5, Math.max(0.001, median)).toFixed(3);
  draft.priceBasis = `median of ${prices.length.toString()} similar listing${prices.length === 1 ? "" : "s"}`;
}

export function rawQuery(q: string, limit: string): RawSearchParams {
  return {
    q,
    tags: undefined,
    maxPriceUsdc: undefined,
    maxP95Ms: undefined,
    limit,
    minScore: undefined,
    withReputation: undefined,
    semantic: "true",
    kind: undefined,
  };
}

export function sanitizeTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const value of raw) {
    const tag = value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "");
    if (tag.length >= 2 && !out.includes(tag)) out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^./, (first) => first.toUpperCase());
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
