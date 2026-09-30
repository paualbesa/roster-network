import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  version: 1;
  listings: CapabilityListing[];
}

/** Index files written before seller binding omit `agentId`. Files written before manifests omit `manifest`. */
type StoredListing = Omit<CapabilityListing, "agentId" | "manifest"> & {
  agentId?: string | null;
  manifest?: CapabilityManifest | null;
};

export function readIndex(filePath: string): CapabilityListing[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Capability registry index is not valid JSON: ${filePath}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.listings)) {
    throw new Error(`Capability registry index has an unsupported shape: ${filePath}`);
  }
  const listings: CapabilityListing[] = [];
  for (const entry of parsed.listings) {
    if (!isStoredListing(entry)) {
      throw new Error(`Capability registry index contains an invalid listing: ${filePath}`);
    }
    listings.push({ ...entry, agentId: entry.agentId ?? null, manifest: entry.manifest ?? null });
  }
  return listings;
}

export function writeIndex(filePath: string, listings: readonly CapabilityListing[]): void {
  const payload: IndexFile = {
    version: 1,
    listings: [...listings].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  };
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid.toString()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, filePath);
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
