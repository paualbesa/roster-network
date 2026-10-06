import { resolveRosterApiOrigin, ROSTER_BROWSER_API_BASE } from "./api-base";

export interface FoundingSummary {
  limit: number;
  taken: number;
  remaining: number;
  days: number;
  takeRateBps: number;
  defaultTakeRateBps: number;
}

export type SellerEndpoint =
  | { type: "openapi"; url: string; method: string; params: { name: string; in: string }[]; hasBody: boolean }
  | { type: "mcp"; url: string; toolName: string; structured: boolean };

export interface ImportedDraft {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  suggestedPriceUsdc: string;
  priceBasis: string;
  similar: { id: string; name: string; priceUsdc: string; relevance: number }[];
  p95Ms: number;
  tags: string[];
  endpoint: SellerEndpoint;
  warnings: string[];
  example: Record<string, unknown>;
}

export interface ImportResponse {
  source: { type: "openapi" | "mcp"; url: string; title: string; version: string };
  drafts: ImportedDraft[];
  skipped: { item: string; reason: string }[];
  founding: FoundingSummary & { eligible: boolean; badge: FoundingBadge | null };
}

export interface FoundingBadge {
  number: number;
  until: string;
  active: boolean;
}

export interface PublishResponse {
  listings: { id: string; name: string }[];
  founding: FoundingBadge | null;
  takeRateBps: number;
}

export interface SellerDashboard {
  sandbox: true;
  profile: { payout: { chain: string; address: string; masked: string } | null; createdAt: string } | null;
  founding: FoundingBadge | null;
  takeRateBps: number;
  totals: { listings: number; calls: number; released: number; earningsUsdc: string; pendingPayoutUsdc: string };
  payoutNote: string;
  listings: {
    id: string;
    name: string;
    status: string;
    priceUsdc: string;
    p95Ms: number;
    endpoint: { type: string; host: string } | null;
    calls: number;
    released: number;
    refunded: number;
    held: number;
    earningsUsdc: string;
    avgLatencyMs: number | null;
  }[];
  recent: { id: string; listingName: string; status: string; amountUsdc: string; sellerNetUsdc: string; takeRateUsdc: string; latencyMs: number | null; at: string }[];
}

export interface DemandCluster {
  id: string;
  title: string;
  variants: string[];
  requests: number;
  requestsThisWeek: number;
  firstSeenAt: string;
  lastSeenAt: string;
  kind: string | null;
  suggestedPriceUsdc: string;
  estimatedEarningsUsdc: string;
  publishUrl: string;
}

export interface DemandBoard {
  notice: string;
  clusters: DemandCluster[];
  totals: { needs: number; requests: number; requestsThisWeek: number };
}

export interface ActivityItem {
  id: string;
  sandbox: true;
  product: string;
  listingId: string;
  seller: string;
  sellerKind: "first_party" | "independent";
  buyer: string;
  buyerKind: "roster_fleet" | "first_party" | "sandbox_user";
  amountUsdc: string;
  latencyMs: number | null;
  status: string;
  at: string;
}

export interface ActivityFeed {
  sandbox: true;
  notice: string;
  items: ActivityItem[];
  totals: { jobs24h: number; released24h: number; volume24hUsdc: string; independentSellers: number; firstPartyJobs24h: number };
  leaderboard: {
    sellerAgentId: string;
    seller: string;
    sellerKind: "first_party" | "independent";
    founding: FoundingBadge | null;
    listings: number;
    releasedJobs: number;
    volumeUsdc: string;
    passportScore: string | null;
    successRate: string | null;
  }[];
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Format check only; the API verifies the Solana length and the EIP-55 checksum. */
export function payoutHint(chain: "solana" | "base", address: string): string | null {
  const value = address.trim();
  if (!value) return "Paste the address that should receive your earnings.";
  if (chain === "solana") return BASE58_RE.test(value) ? null : "Solana addresses are 32–44 base58 characters.";
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? null : "Base addresses start with 0x followed by 40 hex characters.";
}

export function takeRateLabel(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds.toString()}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes.toString()}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours.toString()}h ago`;
  return `${Math.round(hours / 24).toString()}d ago`;
}

export function trimUsdc(amount: string): string {
  const [whole = "0", frac = ""] = amount.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed.length < 2 ? `${whole}.${trimmed.padEnd(2, "0")}` : `${whole}.${trimmed}`;
}

async function publicGet<T>(path: string, revalidate: number): Promise<T | null> {
  try {
    const response = await fetch(`${resolveRosterApiOrigin()}${path}`, {
      headers: { accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export const fetchFounding = () => publicGet<FoundingSummary>("/v1/founding", 30);
export const fetchDemand = () => publicGet<DemandBoard>("/v1/demand?limit=100", 60);
export const fetchActivity = () => publicGet<ActivityFeed>("/v1/activity?limit=50", 10);

export class SellApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function sellRequest<T>(method: string, path: string, apiKey: string | null, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${ROSTER_BROWSER_API_BASE}${path}`, { method, headers, cache: "no-store", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new SellApiError(502, "unavailable", "The Roster API could not be reached.");
  }
  const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    throw new SellApiError(response.status, payload?.error?.code ?? "error", payload?.error?.message ?? `Request failed (${response.status.toString()}).`);
  }
  return payload as T;
}
