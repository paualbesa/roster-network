export class AdminClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AdminClientError";
    this.status = status;
    this.code = code;
  }
}

export interface AdminOverview {
  health: {
    ok: boolean;
    product: string;
    mode: string;
    rail: string;
    asset: string;
    /** Commit the API runs. Older APIs omit it. */
    version?: string;
    uptimeS?: number;
  };
  /** Developer waitlist counts. Older APIs omit it. */
  waitlist?: { total: number; last7d: number };
  counts: {
    accounts: number;
    organizations: number;
    agents: number;
    /** Agents whose status is `active`. */
    agentsOnline: number;
    listings: number;
    jobs: { locked: number; released: number; timedOut: number; failed: number };
  };
  gmv: { lockedUsdc: string; releasedUsdc: string; takeRateCollectedUsdc: string };
}

export interface AdminAccount {
  email: string | null;
  displayName: string | null;
  organizationId: string;
  organizationName: string;
  organizationCreatedAt: string;
  userCreatedAt: string | null;
  treasuryBalanceUsdc: string;
  agentCount: number;
}

export interface AdminListing {
  id: string;
  name: string;
  organizationName: string;
  party: "first_party" | "third_party";
  autofill: boolean;
  sellerAgentId: string | null;
  sellerAgentName: string | null;
  priceUsdc: string;
  pricingModel: string;
  p95Ms: number;
  status: string;
}

export interface AdminJob {
  id: string;
  status: string;
  escrowState: string;
  buyerOrganizationName: string;
  sellerOrganizationName: string;
  listingName: string;
  amountUsdc: string;
  takeRateCollectedUsdc: string;
  createdAt: string;
  settledAt: string | null;
  deadlineAt: string | null;
}

export interface AdminJobDetail {
  job: AdminJob & {
    buyerAgentId: string;
    sellerAgentId: string;
    listingId: string;
    escrowId: string;
    sellerNetUsdc: string;
    takeRateUsdc: string;
    validationErrors: string[] | null;
    result: unknown;
  };
  escrow: {
    id: string;
    state: string;
    jobStatus: string;
    amountUsdc: string;
    takeRateQuotedUsdc: string;
    takeRateCollectedUsdc: string;
    sellerNetUsdc: string;
    holdAddress: string;
    result: unknown;
    validationErrors: string[] | null;
    settledAt: string | null;
  };
}

export interface AdminReputation {
  agents: {
    agentId: string;
    agentName: string;
    organizationName: string;
    score: string;
    eventCount: number;
    successCount: number;
    failureCount: number;
    updatedAt: string | null;
  }[];
  recentFailures: {
    id: string;
    agentName: string;
    organizationId: string;
    createdAt: string;
    latencyMs: number;
    error: boolean;
    sourceRef: string | null;
  }[];
}

export interface AdminWaitlistEntry {
  email: string;
  source: string | null;
  createdAt: string;
}

/** CSV for the waitlist export. Quotes every field and neutralises spreadsheet formulas. */
export function waitlistCsv(entries: readonly AdminWaitlistEntry[]): string {
  const cell = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = [["email", "source", "created_at"].map(cell).join(",")];
  for (const entry of entries) lines.push([entry.email, entry.source ?? "", entry.createdAt].map(cell).join(","));
  return `${lines.join("\n")}\n`;
}

/** `93784` → `1d 2h`. */
export function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days.toString()}d ${hours.toString()}h`;
  if (hours > 0) return `${hours.toString()}h ${minutes.toString()}m`;
  return `${minutes.toString()}m`;
}

export type JobFilter = "all" | "locked" | "released" | "timed_out" | "failed";

export function jobFilterPath(filter: JobFilter): string {
  if (filter === "all") return "/v1/admin/jobs";
  return `/v1/admin/jobs?status=${filter}`;
}

export function jobStatusLabel(status: string): string {
  if (status === "held" || status === "locked") return "Locked";
  if (status === "released") return "Released";
  if (status === "timed_out") return "Timed out";
  if (status === "refunded" || status === "failed") return "Failed";
  return status;
}

export async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    response = await fetch(`/roster-api${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new AdminClientError(502, "unavailable", "Roster API is unreachable from this site.");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 401) {
    await fetch("/api/admin/session", { method: "DELETE" }).catch(() => undefined);
    throw new AdminClientError(401, "unauthorized", "The operator token was rejected.");
  }
  if (!response.ok) {
    const message = readMessage(payload) ?? `Roster API returned ${response.status.toString()}.`;
    const code = readCode(payload) ?? "request_failed";
    throw new AdminClientError(response.status, code, message);
  }
  return payload as T;
}

function readMessage(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  return typeof payload.error.message === "string" ? payload.error.message : null;
}

function readCode(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  return typeof payload.error.code === "string" ? payload.error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
