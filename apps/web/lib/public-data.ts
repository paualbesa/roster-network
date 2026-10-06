import { resolveRosterApiOrigin } from "./api-base";
import { readDataProduct, type DataProductView, type ListingKind } from "./need";

export interface ListingDetail {
  id: string;
  name: string;
  description: string;
  kind: ListingKind;
  priceUsdc: string;
  pricingModel: string;
  p95Ms: number;
  tags: string[];
  inputSchema: unknown;
  outputSchema: unknown;
  agentId: string | null;
  dataProduct: DataProductView | null;
  founding: { number: number; until: string; active: boolean } | null;
  proxied: { type: string } | null;
}

/** Parse `GET /v1/registry/listings/:id` (listing + optional dataProduct). */
export function parseListingDetail(payload: unknown): ListingDetail | null {
  if (!isRecord(payload) || !isRecord(payload.listing)) return null;
  const listing = payload.listing;
  if (typeof listing.id !== "string" || typeof listing.name !== "string") return null;
  const pricing = isRecord(listing.pricing) ? listing.pricing : {};
  const latency = isRecord(listing.latency) ? listing.latency : {};
  const kind = listing.kind === "dataset" || listing.kind === "feed" || listing.kind === "lookup" ? listing.kind : "service";
  return {
    id: listing.id,
    name: listing.name,
    description: typeof listing.description === "string" ? listing.description : "",
    kind,
    priceUsdc: typeof pricing.amountUsdc === "string" ? pricing.amountUsdc : "0",
    pricingModel: typeof pricing.model === "string" ? pricing.model : "per_call",
    p95Ms: typeof latency.p95Ms === "number" ? latency.p95Ms : 0,
    tags: Array.isArray(listing.tags) ? listing.tags.filter((tag): tag is string => typeof tag === "string") : [],
    inputSchema: listing.inputSchema ?? {},
    outputSchema: listing.outputSchema ?? {},
    agentId: typeof listing.agentId === "string" ? listing.agentId : null,
    dataProduct: readDataProduct(payload.dataProduct),
    founding:
      isRecord(payload.founding) && typeof payload.founding.number === "number" && typeof payload.founding.until === "string"
        ? { number: payload.founding.number, until: payload.founding.until, active: payload.founding.active === true }
        : null,
    proxied: isRecord(payload.proxied) && typeof payload.proxied.type === "string" ? { type: payload.proxied.type } : null,
  };
}

export async function fetchListingDetail(id: string): Promise<ListingDetail | null> {
  try {
    const response = await fetch(`${resolveRosterApiOrigin()}/v1/registry/listings/${encodeURIComponent(id)}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    return parseListingDetail(await response.json());
  } catch {
    return null;
  }
}

export async function fetchDataProducts(): Promise<DataProductView[]> {
  try {
    const response = await fetch(`${resolveRosterApiOrigin()}/v1/data/products`, {
      headers: { accept: "application/json" },
      next: { revalidate: 120 },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.products)) return [];
    return payload.products.map(readDataProduct).filter((product): product is DataProductView => product !== null);
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
