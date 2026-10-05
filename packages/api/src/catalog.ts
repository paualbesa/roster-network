import { formatUsdc, parseUsdc } from "@albesa/core";
import { findFleetTool, fleetDraft, fleetTools, runFleetTool } from "./fleet/index.js";

/**
 * First-party sandbox catalog.
 * Each draft is an MCP tool plus an OpenAPI 3.0.3 operation. `outputSchema`
 * is the result schema a buyer can pass to `POST /v1/jobs`; escrow accepts it.
 * `sandboxExecute` returns a fixture for that schema. Nothing here calls a
 * model, a chain, or a paid API.
 */
export interface SandboxCapabilityDraft {
  name: string;
  description: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  pricing: { model: "per_call"; amountUsdc: string };
  latency: { p95Ms: number; p50Ms?: number };
  tags: string[];
  manifest: {
    mcp: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    };
    openapi: {
      openapi: "3.0.3";
      operationId: string;
      method: "post";
      path: string;
      requestSchema: Record<string, unknown>;
      responseSchema: Record<string, unknown>;
    };
  };
}

export interface SandboxSellerBindRequest {
  listingId: string;
  name: string;
  sellerAgentId: string;
}

interface ToolSpec {
  name: string;
  description: string;
  mcpName: string;
  operationId: string;
  path: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  amountUsdc: string;
  p95Ms: number;
  p50Ms: number;
  tags: string[];
}

/** Receipt parser used by the original marketplace demo. Register it, then bind a seller. */
export function sandboxReceiptListing(): SandboxCapabilityDraft {
  return tool({
    name: "Receipt parser",
    description: "Parse receipts and invoices into a structured total.",
    mcpName: "receipt_parser",
    operationId: "parseReceipt",
    path: "/sandbox/receipt-parser",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["documentUrl"],
      properties: { documentUrl: { type: "string", minLength: 1 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["total"],
      properties: { total: { type: "string", minLength: 1 } },
    },
    amountUsdc: "0.02",
    p95Ms: 400,
    p50Ms: 180,
    tags: ["receipt", "invoice", "extract"],
  });
}

export function sandboxDocSummarizerListing(): SandboxCapabilityDraft {
  return tool({
    name: "Doc summarizer",
    description: "Summarize a short document into one brief. Sandbox fixture, no external model.",
    mcpName: "doc_summarizer",
    operationId: "summarizeDoc",
    path: "/sandbox/doc-summarizer",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["documentUrl"],
      properties: { documentUrl: { type: "string", minLength: 1 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string", minLength: 1, maxLength: 280 } },
    },
    amountUsdc: "0.03",
    p95Ms: 700,
    p50Ms: 320,
    tags: ["docs", "summarize"],
  });
}

export function sandboxUnitConverterListing(): SandboxCapabilityDraft {
  return tool({
    name: "Unit converter",
    description: "Convert an integer amount between a few sandbox units.",
    mcpName: "unit_converter",
    operationId: "convertUnit",
    path: "/sandbox/unit-converter",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value", "unit"],
      properties: {
        value: { type: "string", minLength: 1 },
        unit: { type: "string", minLength: 1 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string", minLength: 1 } },
    },
    amountUsdc: "0.01",
    p95Ms: 120,
    p50Ms: 40,
    tags: ["compute", "convert"],
  });
}

/** Named-field extract. Distinct from the receipt parser, which only returns a total. */
export function sandboxStructuredExtractListing(): SandboxCapabilityDraft {
  return tool({
    name: "Structured data extract",
    description: "Extract named fields from a text blob into a structured list. Sandbox fixture, no external parser.",
    mcpName: "structured_extract",
    operationId: "extractStructuredData",
    path: "/sandbox/structured-extract",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text", "fields"],
      properties: {
        text: { type: "string", minLength: 1 },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 32 },
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fields"],
      properties: {
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "value"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 32 },
              value: { type: "string", minLength: 1, maxLength: 120 },
            },
          },
        },
      },
    },
    amountUsdc: "0.015",
    p95Ms: 250,
    p50Ms: 90,
    tags: ["extract", "structured", "data"],
  });
}

/** Short-document question answering. The summarizer stays a separate listing. */
export function sandboxDocQaListing(): SandboxCapabilityDraft {
  return tool({
    name: "Doc Q&A",
    description: "Answer one question about a short document. Sandbox fixture, no external model.",
    mcpName: "doc_qa",
    operationId: "answerDocQuestion",
    path: "/sandbox/doc-qa",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document", "question"],
      properties: {
        document: { type: "string", minLength: 1, maxLength: 2000 },
        question: { type: "string", minLength: 1, maxLength: 280 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["answer", "citations"],
      properties: {
        answer: { type: "string", minLength: 1, maxLength: 280 },
        citations: { type: "integer", minimum: 0, maximum: 5 },
      },
    },
    amountUsdc: "0.025",
    p95Ms: 480,
    p50Ms: 180,
    tags: ["docs", "qa"],
  });
}

/** Cheap compute quote picker. Compares sandbox numbers only. */
export function sandboxComputeArbListing(): SandboxCapabilityDraft {
  return tool({
    name: "Compute arb",
    description: "Pick the cheaper of two sandbox compute quotes. Stub only: no GPU and no external market.",
    mcpName: "compute_arb",
    operationId: "arbitrageCompute",
    path: "/sandbox/compute-arb",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["quotes"],
      properties: {
        quotes: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "priceUsdc"],
            properties: {
              provider: { type: "string", minLength: 1, maxLength: 32 },
              priceUsdc: { type: "string", minLength: 1, maxLength: 16 },
            },
          },
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "priceUsdc", "savedUsdc"],
      properties: {
        provider: { type: "string", minLength: 1, maxLength: 32 },
        priceUsdc: { type: "string", minLength: 1, maxLength: 16 },
        savedUsdc: { type: "string", minLength: 1, maxLength: 16 },
      },
    },
    amountUsdc: "0.005",
    p95Ms: 60,
    p50Ms: 20,
    tags: ["compute", "arb"],
  });
}

/**
 * Catalog published by `POST /v1/registry/seed`.
 * Names are stable so a second call does not create duplicates.
 * Receipt parser stays first.
 */
export function sandboxMarketplaceListings(): SandboxCapabilityDraft[] {
  return [
    sandboxReceiptListing(),
    sandboxDocSummarizerListing(),
    sandboxUnitConverterListing(),
    sandboxStructuredExtractListing(),
    sandboxDocQaListing(),
    sandboxComputeArbListing(),
  ];
}

/**
 * Everything Roster Fleet publishes: the six classic demo listings plus the
 * first-party catalog in `./fleet`. Only the fleet bootstrap uses this list.
 * `POST /v1/registry/seed` keeps publishing the six classic drafts so a
 * developer org does not inherit dozens of first-party listings.
 */
export function rosterFleetListings(): SandboxCapabilityDraft[] {
  return [...sandboxMarketplaceListings(), ...fleetTools().map((tool) => fleetDraft(tool))];
}

/** True for every listing name Roster Fleet can deliver with `sandboxExecute`. */
export function isRosterFleetName(name: string): boolean {
  return CLASSIC_NAMES.has(name) || findFleetTool(name) !== undefined;
}

const CLASSIC_NAMES = new Set([
  "Receipt parser",
  "Doc summarizer",
  "Unit converter",
  "Structured data extract",
  "Doc Q&A",
  "Compute arb",
]);

/** Escrow result schema for a fleet listing. Pass it as `schema` on `POST /v1/jobs`. */
export function sandboxJobSchema(name: string): Record<string, unknown> {
  return structuredClone(requireDraft(name).outputSchema);
}

/**
 * Bind every seeded first-party name that appears in `listings` to one seller agent.
 * The caller still PUTs each request. Unknown names are left alone.
 */
export function sandboxSellerBindRequests(
  listings: readonly { id: string; name: string }[],
  sellerAgentId: string,
): SandboxSellerBindRequest[] {
  const wanted = new Set(sandboxMarketplaceListings().map((draft) => draft.name));
  return listings
    .filter((listing) => wanted.has(listing.name))
    .map((listing) => ({ listingId: listing.id, name: listing.name, sellerAgentId }));
}

/**
 * Local fixture for a first-party listing. The seller submits this as the job result.
 * Invalid input falls back to a schema-valid sample. No network.
 */
export function sandboxExecute(name: string, input: unknown): Record<string, unknown> {
  switch (name) {
    case "Receipt parser":
      return executeReceipt(input);
    case "Doc summarizer":
      return executeSummarizer(input);
    case "Unit converter":
      return executeConverter(input);
    case "Structured data extract":
      return executeExtract(input);
    case "Doc Q&A":
      return executeDocQa(input);
    case "Compute arb":
      return executeComputeArb(input);
    default: {
      const tool = findFleetTool(name);
      if (!tool) throw new Error(`Unknown sandbox listing "${name}".`);
      return runFleetTool(tool, input);
    }
  }
}

function tool(spec: ToolSpec): SandboxCapabilityDraft {
  return {
    name: spec.name,
    description: spec.description,
    version: "1.0.0",
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    pricing: { model: "per_call", amountUsdc: spec.amountUsdc },
    latency: { p95Ms: spec.p95Ms, p50Ms: spec.p50Ms },
    tags: spec.tags,
    manifest: {
      mcp: {
        name: spec.mcpName,
        description: spec.description,
        inputSchema: spec.inputSchema,
      },
      openapi: {
        openapi: "3.0.3",
        operationId: spec.operationId,
        method: "post",
        path: spec.path,
        requestSchema: spec.inputSchema,
        responseSchema: spec.outputSchema,
      },
    },
  };
}

function requireDraft(name: string): SandboxCapabilityDraft {
  const fleet = findFleetTool(name);
  if (fleet) return fleetDraft(fleet);
  const draft = sandboxMarketplaceListings().find((listing) => listing.name === name);
  if (!draft) throw new Error(`Unknown sandbox listing "${name}".`);
  return draft;
}

function executeReceipt(input: unknown): Record<string, unknown> {
  if (isRecord(input) && typeof input.total === "string" && input.total.trim().length > 0) {
    return { total: input.total.trim().slice(0, 32) };
  }
  return { total: "12.50" };
}

function executeSummarizer(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || typeof input.documentUrl !== "string" || input.documentUrl.trim().length === 0) {
    return { summary: "Short brief." };
  }
  return { summary: `Brief for ${input.documentUrl.trim()}`.slice(0, 280) };
}

const UNIT_TO_BASE: Record<string, { unit: string; factor: number }> = {
  kg: { unit: "g", factor: 1000 },
  m: { unit: "cm", factor: 100 },
};

function executeConverter(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || typeof input.value !== "string" || typeof input.unit !== "string") {
    return { value: "1" };
  }
  if (!/^\d{1,6}$/.test(input.value)) return { value: input.value };
  const rule = UNIT_TO_BASE[input.unit.trim().toLowerCase()];
  if (!rule) return { value: input.value };
  return { value: `${(Number(input.value) * rule.factor).toString()} ${rule.unit}` };
}

function executeExtract(input: unknown): Record<string, unknown> {
  const fallback = { fields: [{ name: "vendor", value: "Harbor Supply" }] };
  if (!isRecord(input) || typeof input.text !== "string" || !Array.isArray(input.fields)) return fallback;
  if (input.fields.length === 0 || input.fields.length > 8) return fallback;
  const fields: { name: string; value: string }[] = [];
  for (const field of input.fields) {
    if (typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(field)) return fallback;
    fields.push({ name: field, value: readLabeledValue(input.text, field) });
  }
  return { fields };
}

function readLabeledValue(text: string, name: string): string {
  const pattern = new RegExp(`(?:^|\\n)\\s*${name}\\s*[:=]\\s*([^\\n]{1,120})`, "i");
  const match = pattern.exec(text);
  const value = match?.[1]?.trim() ?? "";
  return value.length > 0 ? value.slice(0, 120) : "unknown";
}

function executeDocQa(input: unknown): Record<string, unknown> {
  const fallback = { answer: "Net 30.", citations: 1 };
  if (!isRecord(input) || typeof input.document !== "string" || typeof input.question !== "string") return fallback;
  if (input.document.trim().length === 0 || input.question.trim().length === 0) return fallback;
  const sentence = input.document.trim().split(/(?<=[.!?])\s/u)[0] ?? input.document.trim();
  const answer = sentence.slice(0, 280);
  if (answer.length === 0) return fallback;
  return { answer, citations: 1 };
}

function executeComputeArb(input: unknown): Record<string, unknown> {
  const fallback = { provider: "spot-a", priceUsdc: "0.004000", savedUsdc: "0.002000" };
  const quotes = readQuotes(input);
  if (!quotes) return fallback;
  const sorted = [...quotes].sort((left, right) => compareMicros(left.priceMicros, right.priceMicros));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (!best || !worst) return fallback;
  return {
    provider: best.provider,
    priceUsdc: formatUsdc(best.priceMicros),
    savedUsdc: formatUsdc(worst.priceMicros - best.priceMicros),
  };
}

interface Quote {
  provider: string;
  priceMicros: bigint;
}

function readQuotes(input: unknown): Quote[] | null {
  if (!isRecord(input) || !Array.isArray(input.quotes)) return null;
  if (input.quotes.length < 2 || input.quotes.length > 4) return null;
  const quotes: Quote[] = [];
  for (const entry of input.quotes) {
    if (!isRecord(entry) || typeof entry.provider !== "string" || typeof entry.priceUsdc !== "string") return null;
    if (entry.provider.length === 0 || entry.provider.length > 32) return null;
    try {
      const priceMicros = parseUsdc(entry.priceUsdc);
      if (priceMicros < 0n) return null;
      quotes.push({ provider: entry.provider, priceMicros });
    } catch {
      return null;
    }
  }
  return quotes;
}

function compareMicros(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
