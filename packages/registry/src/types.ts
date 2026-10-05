export type PricingModel = "per_call" | "per_1k_tokens" | "free";

export type ListingStatus = "active" | "paused";

/** `service` runs work on the buyer's input. The other kinds sell data Roster gathers. */
export type ListingKind = "service" | "dataset" | "feed" | "lookup";

export const LISTING_KINDS: readonly ListingKind[] = ["service", "dataset", "feed", "lookup"];

/** Where the data comes from and the terms it is resold under. */
export interface DataSourceAttribution {
  name: string;
  url: string;
  /** SPDX-style or plain-text license, e.g. "CC0-1.0", "CC-BY-4.0", "Public domain (US Government)". */
  license: string;
  licenseUrl: string;
  /** Text buyers must carry when they republish the data. */
  attribution: string;
}

/** Static description of a data product. Live freshness and row counts come from the data catalog. */
export interface DataProductInfo {
  slug: string;
  sources: DataSourceAttribution[];
  /** Human cadence, e.g. "hourly", "every 6 hours", "daily", "weekly". */
  refreshCadence: string;
  refreshIntervalS: number;
  /** Delivery formats, e.g. ["json", "csv"]. */
  formats: string[];
  /** `signed_url` for downloads, `inline` for query results. */
  delivery: "signed_url" | "inline";
  /** Column names and types buyers receive. */
  columns: { name: string; type: string; description: string }[];
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON Schema document stored with the listing. Validated as JSON, not executed. */
export type JsonSchema = { [key: string]: JsonValue };

/** MCP tool descriptor stored with a listing. Schemas are JSON, not executed. */
export interface McpToolManifest {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** OpenAPI 3.0.3 operation the same capability exposes. */
export interface OpenApiOperationManifest {
  openapi: "3.0.3";
  operationId: string;
  method: "post";
  path: string;
  requestSchema: JsonSchema;
  responseSchema: JsonSchema;
}

/**
 * Publisher manifest. The registry stores it for discovery.
 * Escrow validates the buyer's job schema, which should match `outputSchema`.
 */
export interface CapabilityManifest {
  mcp: McpToolManifest;
  openapi: OpenApiOperationManifest;
}

export interface PricingHint {
  model: PricingModel;
  /** Six-decimal USDC string. "0.000000" when model is free. */
  amountUsdc: string;
}

export interface LatencySla {
  p95Ms: number;
  p50Ms: number | null;
}

/**
 * MCP/OpenAPI-style capability manifest published by an organization.
 * Pricing and latency are hints for ranking, not a settlement contract.
 */
export interface CapabilityListing {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  pricing: PricingHint;
  latency: LatencySla;
  tags: string[];
  status: ListingStatus;
  /**
   * MCP tool plus the OpenAPI operation for this capability.
   * Null on listings published before manifests existed.
   */
  manifest: CapabilityManifest | null;
  /**
   * Seller agent whose reputation passport ranks this listing.
   * Null when the publisher did not bind one. Search may then use the
   * organization's only agent. It never guesses among several agents.
   */
  agentId: string | null;
  /** Absent on listings published before data products existed; read as "service". */
  kind?: ListingKind;
  /** Data product metadata. Null or absent for services. */
  data?: DataProductInfo | null;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilitySearchQuery {
  q: string;
  tags: string[];
  maxPriceUsdc: string | null;
  maxP95Ms: number | null;
  limit: number;
  /**
   * Drop hits whose effective passport score is below this floor (0–100).
   * Null keeps every hit. Missing passports use the neutral score, not zero.
   * Honored only together with reputation ranking (see rank.ts).
   */
  minScore: number | null;
  /** Opt into blending passport scores. Ignored when no reputation input is active. */
  withReputation: boolean;
  /**
   * When true, relevance is cosine similarity against the stored listing vector.
   * When false, relevance stays on the keyword path.
   */
  semantic: boolean;
  /** Only these kinds. Empty keeps every kind. */
  kinds?: ListingKind[];
}

export interface CapabilitySearchHit {
  listing: CapabilityListing;
  /**
   * Higher is better. Without reputation input this is relevance nudged by
   * price and latency. With reputation input it is the blended score from
   * `RANK_BLEND_WEIGHTS`. Relevance is keyword overlap unless `semantic` is set,
   * in which case it is cosine similarity.
   */
  score: number;
  relevance: number;
  priceHint: number;
  latencyHint: number;
  /**
   * Effective passport score from 0 to 100 used in the blend.
   * Present only when reputation ranking is on. 50 means neutral
   * (no passport, or no events), not a measured fifty.
   */
  reputationScore?: number;
}

/**
 * Observed passport scores for an opt-in blend.
 * Keyed by listing id. A missing key or null is neutral (50), not zero.
 */
export interface ReputationRankInput {
  scoresByListingId: ReadonlyMap<string, number | null>;
}

export interface RawSearchParams {
  q: string | undefined;
  tags: string | undefined;
  maxPriceUsdc: string | undefined;
  maxP95Ms: string | undefined;
  limit: string | undefined;
  /** Minimum passport score, 0–100. Omit to skip the floor. */
  minScore: string | undefined;
  /** "1" or "true" opts into the reputation blend. "0" or "false" leaves the default ranker. */
  withReputation: string | undefined;
  /** "1" or "true" ranks by stored cosine similarity. "0" or "false" keeps keyword search. */
  semantic: string | undefined;
  /** Comma-separated kinds: service, dataset, feed, lookup. */
  kind?: string | undefined;
}
