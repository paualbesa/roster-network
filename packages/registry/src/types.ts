export type PricingModel = "per_call" | "per_1k_tokens" | "free";

export type ListingStatus = "active" | "paused";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON Schema document stored with the listing. Validated as JSON, not executed. */
export type JsonSchema = { [key: string]: JsonValue };

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
  createdAt: string;
  updatedAt: string;
}

export interface CapabilitySearchQuery {
  q: string;
  tags: string[];
  maxPriceUsdc: string | null;
  maxP95Ms: number | null;
  limit: number;
}

export interface CapabilitySearchHit {
  listing: CapabilityListing;
  /** Combined relevance and price/latency hint score. Higher is better. */
  score: number;
  relevance: number;
  priceHint: number;
  latencyHint: number;
}

export interface RawSearchParams {
  q: string | undefined;
  tags: string | undefined;
  maxPriceUsdc: string | undefined;
  maxP95Ms: string | undefined;
  limit: string | undefined;
}
