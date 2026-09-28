import { createId, formatUsdc, MoneyError, parseUsdc } from "@albesa/core";
import { RegistryError } from "./errors.js";
import { writeIndex, readIndex } from "./persist.js";
import { rankListings } from "./rank.js";
import type {
  CapabilityListing,
  CapabilitySearchHit,
  CapabilitySearchQuery,
  JsonSchema,
  LatencySla,
  ListingStatus,
  PricingHint,
  PricingModel,
  RawSearchParams,
} from "./types.js";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 4000;
const QUERY_MAX = 500;
const SCHEMA_MAX_CHARS = 16_000;
const SCHEMA_MAX_DEPTH = 12;
const SCHEMA_MAX_KEYS = 200;
const MAX_TAGS = 16;
const MAX_LISTINGS_PER_ORG = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_P95_MS = 120_000;
const MAX_USDC_MICROS = 1_000_000n * 1_000_000n;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CapabilityRegistryOptions {
  filePath?: string;
  now?: () => Date;
}

interface ListingDraft {
  name: string;
  description: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  pricing: PricingHint;
  latency: LatencySla;
  tags: string[];
  status: ListingStatus;
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityListing>();
  private readonly filePath: string | null;
  private readonly now: () => Date;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.filePath = options.filePath ?? null;
    this.now = options.now ?? (() => new Date());
    if (this.filePath) {
      for (const listing of readIndex(this.filePath)) {
        if (this.entries.has(listing.id)) {
          throw new Error(`Duplicate capability id ${listing.id} in ${this.filePath}`);
        }
        this.entries.set(listing.id, listing);
      }
    }
  }

  register(organizationId: string, input: unknown): CapabilityListing {
    const draft = parseRegisterBody(input);
    if (this.countForOrg(organizationId) >= MAX_LISTINGS_PER_ORG) {
      throw new RegistryError(403, "listing_limit", "Sandbox organizations can publish at most 100 capabilities.");
    }
    const timestamp = this.now().toISOString();
    const listing: CapabilityListing = {
      id: createId("cap"),
      organizationId,
      name: draft.name,
      description: draft.description,
      version: draft.version,
      inputSchema: draft.inputSchema,
      outputSchema: draft.outputSchema,
      pricing: draft.pricing,
      latency: draft.latency,
      tags: draft.tags,
      status: draft.status,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.entries.set(listing.id, listing);
    try {
      this.persist();
    } catch (error) {
      this.entries.delete(listing.id);
      throw error;
    }
    return structuredClone(listing);
  }

  update(organizationId: string, id: string, input: unknown): CapabilityListing {
    const previous = this.entries.get(id);
    if (!previous) throw new RegistryError(404, "not_found", "Capability listing not found.");
    if (previous.organizationId !== organizationId) {
      throw new RegistryError(403, "forbidden", "Listing belongs to another organization.");
    }
    const draft = parseUpdateBody(input, previous);
    const listing: CapabilityListing = {
      id: previous.id,
      organizationId: previous.organizationId,
      name: draft.name,
      description: draft.description,
      version: draft.version,
      inputSchema: draft.inputSchema,
      outputSchema: draft.outputSchema,
      pricing: draft.pricing,
      latency: draft.latency,
      tags: draft.tags,
      status: draft.status,
      createdAt: previous.createdAt,
      updatedAt: this.now().toISOString(),
    };
    this.entries.set(id, listing);
    try {
      this.persist();
    } catch (error) {
      this.entries.set(id, previous);
      throw error;
    }
    return structuredClone(listing);
  }

  get(id: string): CapabilityListing | null {
    const listing = this.entries.get(id);
    return listing ? structuredClone(listing) : null;
  }

  search(query: Partial<CapabilitySearchQuery> = {}): CapabilitySearchHit[] {
    const normalized = normalizeSearchQuery(query);
    return rankListings([...this.entries.values()], normalized).map((hit) => ({
      listing: structuredClone(hit.listing),
      score: hit.score,
      relevance: hit.relevance,
      priceHint: hit.priceHint,
      latencyHint: hit.latencyHint,
    }));
  }

  private countForOrg(organizationId: string): number {
    let count = 0;
    for (const listing of this.entries.values()) {
      if (listing.organizationId === organizationId) count += 1;
    }
    return count;
  }

  private persist(): void {
    if (!this.filePath) return;
    writeIndex(this.filePath, [...this.entries.values()]);
  }
}

export function parseSearchQuery(raw: RawSearchParams): CapabilitySearchQuery {
  const limit = raw.limit === undefined || raw.limit.trim() === "" ? DEFAULT_LIMIT : parseLimit(raw.limit);
  const maxP95Ms =
    raw.maxP95Ms === undefined || raw.maxP95Ms.trim() === "" ? null : parseBoundedP95(raw.maxP95Ms, "maxP95Ms");
  const maxPriceUsdc =
    raw.maxPriceUsdc === undefined || raw.maxPriceUsdc.trim() === "" ? null : raw.maxPriceUsdc.trim();
  const tags =
    raw.tags === undefined || raw.tags.trim() === ""
      ? []
      : raw.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
  return normalizeSearchQuery({
    q: raw.q ?? "",
    tags,
    maxPriceUsdc,
    maxP95Ms,
    limit,
  });
}

function normalizeSearchQuery(query: Partial<CapabilitySearchQuery>): CapabilitySearchQuery {
  const q = query.q ?? "";
  if (q.length > QUERY_MAX) {
    throw new RegistryError(400, "invalid_request", `q must be at most ${QUERY_MAX.toString()} characters.`);
  }
  const tags = (query.tags ?? []).map((tag) => normalizeTag(tag));
  const maxPriceUsdc = query.maxPriceUsdc ?? null;
  if (maxPriceUsdc !== null) readAmount(maxPriceUsdc, "maxPriceUsdc");
  const maxP95Ms = query.maxP95Ms ?? null;
  if (maxP95Ms !== null) assertP95(maxP95Ms, "maxP95Ms");
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RegistryError(400, "invalid_request", `limit must be an integer from 1 to ${MAX_LIMIT.toString()}.`);
  }
  return { q, tags, maxPriceUsdc, maxP95Ms, limit };
}

function parseRegisterBody(input: unknown): ListingDraft {
  const body = readBody(input);
  return {
    name: readName(body.name),
    description: readDescription(body.description),
    version: body.version === undefined ? "1.0.0" : readVersion(body.version),
    inputSchema: readSchema(body.inputSchema, "inputSchema"),
    outputSchema: readSchema(body.outputSchema, "outputSchema"),
    pricing: readPricing(body.pricing),
    latency: readLatency(body.latency),
    tags: body.tags === undefined ? [] : readTags(body.tags),
    status: body.status === undefined ? "active" : readStatus(body.status),
  };
}

function parseUpdateBody(input: unknown, current: CapabilityListing): ListingDraft {
  const body = readBody(input);
  const mutable = ["name", "description", "version", "inputSchema", "outputSchema", "pricing", "latency", "tags", "status"];
  if (!mutable.some((key) => key in body)) {
    throw new RegistryError(400, "invalid_request", "Update must change at least one listing field.");
  }
  return {
    name: body.name === undefined ? current.name : readName(body.name),
    description: body.description === undefined ? current.description : readDescription(body.description),
    version: body.version === undefined ? current.version : readVersion(body.version),
    inputSchema: body.inputSchema === undefined ? current.inputSchema : readSchema(body.inputSchema, "inputSchema"),
    outputSchema:
      body.outputSchema === undefined ? current.outputSchema : readSchema(body.outputSchema, "outputSchema"),
    pricing: body.pricing === undefined ? current.pricing : readPricing(body.pricing),
    latency: body.latency === undefined ? current.latency : readLatency(body.latency),
    tags: body.tags === undefined ? current.tags : readTags(body.tags),
    status: body.status === undefined ? current.status : readStatus(body.status),
  };
}

function readBody(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new RegistryError(400, "invalid_request", "Expected a JSON object.");
  return input;
}

function readName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > NAME_MAX) {
    throw new RegistryError(400, "invalid_request", `name must be 1-${NAME_MAX.toString()} characters.`);
  }
  return value.trim();
}

function readDescription(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > DESCRIPTION_MAX) {
    throw new RegistryError(
      400,
      "invalid_request",
      `description must be 1-${DESCRIPTION_MAX.toString()} characters.`,
    );
  }
  return value.trim();
}

function readVersion(value: unknown): string {
  if (typeof value !== "string" || !VERSION_RE.test(value)) {
    throw new RegistryError(400, "invalid_request", "version must look like 1.0.0.");
  }
  return value;
}

function readStatus(value: unknown): ListingStatus {
  if (value === "active" || value === "paused") return value;
  throw new RegistryError(400, "invalid_request", 'status must be "active" or "paused".');
}

function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new RegistryError(400, "invalid_request", "tags must be an array of strings.");
  const tags = [...new Set(value.map((tag) => normalizeTag(tag)))];
  if (tags.length > MAX_TAGS) {
    throw new RegistryError(400, "invalid_request", `At most ${MAX_TAGS.toString()} tags are allowed.`);
  }
  tags.sort();
  return tags;
}

function normalizeTag(value: unknown): string {
  if (typeof value !== "string") throw new RegistryError(400, "invalid_request", "tags must be strings.");
  const tag = value.trim().toLowerCase();
  if (!TAG_RE.test(tag) || tag.length > 32) {
    throw new RegistryError(
      400,
      "invalid_request",
      "tags must be lowercase words or hyphenated words, up to 32 characters.",
    );
  }
  return tag;
}

function readSchema(value: unknown, field: string): JsonSchema {
  assertJsonValue(value, field, 0);
  if (!isRecord(value)) throw new RegistryError(400, "invalid_request", `${field} must be a JSON object.`);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RegistryError(400, "invalid_request", `${field} must be JSON-serializable.`);
  }
  if (encoded.length > SCHEMA_MAX_CHARS) {
    throw new RegistryError(400, "invalid_request", `${field} is too large.`);
  }
  return JSON.parse(encoded) as JsonSchema;
}

function assertJsonValue(value: unknown, field: string, depth: number): void {
  if (depth > SCHEMA_MAX_DEPTH) {
    throw new RegistryError(400, "invalid_request", `${field} is too deep.`);
  }
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RegistryError(400, "invalid_request", `${field} must be JSON-serializable.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > SCHEMA_MAX_KEYS) throw new RegistryError(400, "invalid_request", `${field} is too large.`);
    for (const entry of value) assertJsonValue(entry, field, depth + 1);
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > SCHEMA_MAX_KEYS) throw new RegistryError(400, "invalid_request", `${field} is too large.`);
    for (const key of keys) assertJsonValue(value[key], field, depth + 1);
    return;
  }
  throw new RegistryError(400, "invalid_request", `${field} must be JSON-serializable.`);
}

function readPricing(value: unknown): PricingHint {
  if (!isRecord(value)) throw new RegistryError(400, "invalid_request", "pricing must be an object.");
  const model = value.model;
  if (model !== "per_call" && model !== "per_1k_tokens" && model !== "free") {
    throw new RegistryError(400, "invalid_request", 'pricing.model must be "per_call", "per_1k_tokens", or "free".');
  }
  const amount = readAmount(value.amountUsdc, "pricing.amountUsdc");
  if (model === "free" && amount !== "0.000000") {
    throw new RegistryError(400, "invalid_request", 'pricing.amountUsdc must be 0 when model is "free".');
  }
  if (model !== "free" && amount === "0.000000") {
    throw new RegistryError(400, "invalid_request", "pricing.amountUsdc must be greater than 0 for paid models.");
  }
  return { model: model satisfies PricingModel, amountUsdc: amount };
}

function readAmount(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RegistryError(400, "invalid_request", `${field} must be a USDC decimal string.`);
  }
  try {
    const micros = parseUsdc(value);
    if (micros > MAX_USDC_MICROS) {
      throw new RegistryError(400, "invalid_request", `${field} is too large.`);
    }
    return formatUsdc(micros);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    if (error instanceof MoneyError) {
      throw new RegistryError(400, "invalid_request", `${field} must be a USDC decimal string.`);
    }
    throw error;
  }
}

function readLatency(value: unknown): LatencySla {
  if (!isRecord(value)) throw new RegistryError(400, "invalid_request", "latency must be an object.");
  const p95Ms = parseBoundedP95(value.p95Ms, "latency.p95Ms");
  if (value.p50Ms === undefined || value.p50Ms === null) return { p95Ms, p50Ms: null };
  const p50Ms = parseBoundedP95(value.p50Ms, "latency.p50Ms");
  if (p50Ms > p95Ms) {
    throw new RegistryError(400, "invalid_request", "latency.p50Ms cannot exceed latency.p95Ms.");
  }
  return { p95Ms, p50Ms };
}

function parseBoundedP95(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (typeof value === "string" && value.trim() === "") {
    throw new RegistryError(400, "invalid_request", `${field} must be an integer number of milliseconds.`);
  }
  assertP95(parsed, field);
  return parsed;
}

function assertP95(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_P95_MS) {
    throw new RegistryError(
      400,
      "invalid_request",
      `${field} must be an integer from 1 to ${MAX_P95_MS.toString()} milliseconds.`,
    );
  }
}

function parseLimit(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new RegistryError(400, "invalid_request", `limit must be an integer from 1 to ${MAX_LIMIT.toString()}.`);
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
