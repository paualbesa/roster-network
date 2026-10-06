import { ADMIN_TOKEN, ROSTER_API_BASE } from "./config.js";

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (ADMIN_TOKEN && !headers.has("x-roster-admin-token")) {
    headers.set("x-roster-admin-token", ADMIN_TOKEN);
  }
  const res = await fetch(`${ROSTER_API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface HealthBody {
  ok: boolean;
  version?: string;
  product?: string;
  uptimeS?: number;
}

export interface ActivityItem {
  id: string;
  sandbox?: boolean;
  product?: string;
  listingId?: string;
  seller?: string;
  buyer?: string;
  buyerKind?: string;
  amountUsdc?: string;
  latencyMs?: number | null;
  status?: string;
}

export interface ActivityBody {
  items: ActivityItem[];
  leaderboard?: { seller: string; amountUsdc: string; jobs: number }[];
}

export interface DemandRow {
  need?: string;
  label?: string;
  count?: number;
  requests?: number;
  estimateUsdc?: string;
  estimatedEarningsUsdc?: string;
}

export interface DemandBody {
  top?: DemandRow[];
  clusters?: DemandRow[];
  items?: DemandRow[];
}

export interface AdminListing {
  id: string;
  name: string;
  organizationName?: string;
  priceUsdc?: string;
  status?: string;
  party?: string;
}

export async function fetchHealth(): Promise<HealthBody> {
  return getJson<HealthBody>("/health");
}

export async function fetchActivity(limit = 40): Promise<ActivityBody> {
  return getJson<ActivityBody>(`/v1/activity?limit=${limit}`);
}

export async function fetchDemand(limit = 60): Promise<DemandBody> {
  return getJson<DemandBody>(`/v1/demand?limit=${limit}`);
}

export async function fetchAdminListings(): Promise<AdminListing[]> {
  if (!ADMIN_TOKEN) return [];
  const body = await getJson<{ listings: AdminListing[] }>("/v1/admin/listings");
  return body.listings ?? [];
}

export async function postNeed(text: string): Promise<{
  matches?: { listing?: { id: string; name: string; pricing?: { amountUsdc?: string } }; score?: number }[];
  hits?: { listing: { id: string; name: string; pricing?: { amountUsdc?: string } }; score?: number }[];
}> {
  const res = await fetch(`${ROSTER_API_BASE}/v1/need`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ need: text }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`/v1/need → ${res.status} ${err.slice(0, 200)}`);
  }
  return (await res.json()) as {
    matches?: { listing?: { id: string; name: string; pricing?: { amountUsdc?: string } }; score?: number }[];
    hits?: { listing: { id: string; name: string; pricing?: { amountUsdc?: string } }; score?: number }[];
  };
}

export async function fetchOverviewStats(): Promise<{
  counts?: { listings?: number; jobs?: { released?: number }; accounts?: number };
  gmv?: { releasedUsdc?: string };
  health?: { version?: string; ok?: boolean };
}> {
  if (!ADMIN_TOKEN) {
    const health = await fetchHealth();
    return { health: { version: health.version, ok: health.ok }, counts: {}, gmv: undefined };
  }
  return getJson("/v1/admin/overview");
}
