import { resolveRosterApiOrigin } from "./api-base";

export interface PublicListing {
  id: string;
  name: string;
  description: string;
  priceUsdc: string;
  pricingModel: string;
  p95Ms: number;
  tags: string[];
}

/** Parse `GET /v1/registry/listings`. Bad rows are skipped, not fatal. */
export function parsePublicListings(payload: unknown, limit = 6): PublicListing[] {
  if (!isRecord(payload) || !Array.isArray(payload.listings)) return [];
  const listings: PublicListing[] = [];
  for (const item of payload.listings) {
    if (!isRecord(item) || item.status !== "active") continue;
    const pricing = isRecord(item.pricing) ? item.pricing : null;
    const latency = isRecord(item.latency) ? item.latency : null;
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      !pricing ||
      typeof pricing.amountUsdc !== "string" ||
      !latency ||
      typeof latency.p95Ms !== "number"
    ) {
      continue;
    }
    listings.push({
      id: item.id,
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      priceUsdc: pricing.amountUsdc,
      pricingModel: typeof pricing.model === "string" ? pricing.model : "per_call",
      p95Ms: latency.p95Ms,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 3) : [],
    });
  }
  return listings.slice(0, limit);
}

/** Server-side read for the landing page. Revalidates every minute and never throws. */
export async function fetchPublicListings(limit = 6): Promise<PublicListing[]> {
  try {
    const response = await fetch(`${resolveRosterApiOrigin()}/v1/registry/listings`, {
      headers: { accept: "application/json" },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return [];
    return parsePublicListings(await response.json(), limit);
  } catch {
    return [];
  }
}

/** `0.010000` → `0.01`. Keeps at least two decimals. */
export function formatListingPrice(amountUsdc: string): string {
  const [whole = "0", fraction = ""] = amountUsdc.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}.${trimmed.length >= 2 ? trimmed : trimmed.padEnd(2, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
