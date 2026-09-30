import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deserializeSemanticVector, serializeSemanticVector } from "./text.js";
import type {
  CapabilityListing,
  CapabilityManifest,
  JsonSchema,
  LatencySla,
  ListingStatus,
  PricingHint,
  PricingModel,
} from "./types.js";

interface IndexFile {
  version: 2;
  listings: CapabilityListing[];
  /** Sparse semantic vectors keyed by listing id. Omitted pairs are zeros. */
  vectors: Record<string, number[]>;
}

export interface LoadedIndex {
  listings: CapabilityListing[];
  vectors: Map<string, Float64Array>;
}

/** Index files written before seller binding omit `agentId`. Files written before manifests omit `manifest`. */
type StoredListing = Omit<CapabilityListing, "agentId" | "manifest"> & {
  agentId?: string | null;
  manifest?: CapabilityManifest | null;
};

export function readIndex(filePath: string): LoadedIndex {
  if (!existsSync(filePath)) return { listings: [], vectors: new Map() };
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Capability registry index is not valid JSON: ${filePath}`);
  }
  if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.listings)) {
    throw new Error(`Capability registry index has an unsupported shape: ${filePath}`);
  }
  const listings: CapabilityListing[] = [];
  for (const entry of parsed.listings) {
    if (!isStoredListing(entry)) {
      throw new Error(`Capability registry index contains an invalid listing: ${filePath}`);
    }
    listings.push({ ...entry, agentId: entry.agentId ?? null, manifest: entry.manifest ?? null });
  }
  return { listings, vectors: readVectors(parsed.vectors, filePath) };
}

export function writeIndex(
  filePath: string,
  listings: readonly CapabilityListing[],
  vectors: ReadonlyMap<string, Float64Array>,
): void {
  const ordered = [...listings].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const stored: Record<string, number[]> = {};
  for (const listing of ordered) {
    const vector = vectors.get(listing.id);
    if (!vector) continue;
    stored[listing.id] = serializeSemanticVector(vector);
  }
  const payload: IndexFile = { version: 2, listings: ordered, vectors: stored };
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid.toString()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, filePath);
}

function readVectors(value: unknown, filePath: string): Map<string, Float64Array> {
  const vectors = new Map<string, Float64Array>();
  if (value === undefined) return vectors;
  if (!isRecord(value)) {
    throw new Error(`Capability registry index has an unsupported shape: ${filePath}`);
  }
  for (const [id, encoded] of Object.entries(value)) {
    const vector = deserializeSemanticVector(encoded);
    if (vector) vectors.set(id, vector);
  }
  return vectors;
}

function isStoredListing(value: unknown): value is StoredListing {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.organizationId === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.version === "string" &&
    isSchema(value.inputSchema) &&
    isSchema(value.outputSchema) &&
    isPricing(value.pricing) &&
    isLatency(value.latency) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    isStatus(value.status) &&
    isAgentId(value.agentId) &&
    isManifest(value.manifest) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isAgentId(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isManifest(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || !isRecord(value.mcp) || !isRecord(value.openapi)) return false;
  return typeof value.mcp.name === "string" && typeof value.openapi.operationId === "string";
}

function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}

function isPricing(value: unknown): value is PricingHint {
  if (!isRecord(value)) return false;
  return isPricingModel(value.model) && typeof value.amountUsdc === "string";
}

function isLatency(value: unknown): value is LatencySla {
  if (!isRecord(value) || typeof value.p95Ms !== "number") return false;
  return value.p50Ms === null || typeof value.p50Ms === "number";
}

function isPricingModel(value: unknown): value is PricingModel {
  return value === "per_call" || value === "per_1k_tokens" || value === "free";
}

function isStatus(value: unknown): value is ListingStatus {
  return value === "active" || value === "paused";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
