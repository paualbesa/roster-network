import { timingSafeEqual } from "node:crypto";
import { addUsdc, type RuntimeMode, type WalletRail } from "@albesa/core";
import type { CapabilityListing, CapabilityRegistry } from "@albesa/registry";
import type { Context, Env, Hono } from "hono";
import { bootstrapSandboxFleet, SANDBOX_FLEET_ORG_NAME } from "./fleet.js";
import type { JobOrchestrator, JobStatus, JobView, ListingSellerBinding } from "./jobs.js";
import {
  AgentFinanceService,
  ServiceError,
  type OperatorAccount,
  type OperatorAgentRef,
} from "./service.js";

export const ADMIN_TOKEN_HEADER = "x-roster-admin-token";
export const ADMIN_COOKIE_NAME = "roster_admin_token";
/** Presented tokens longer than this are rejected before the comparison. */
const MAX_PRESENTED_TOKEN = 1024;

export type AdminEscrowState = "locked" | "released" | "refunded";

export interface AdminGateFailure {
  ok: false;
  status: 401 | 503;
  code: "unauthorized" | "admin_disabled";
  message: string;
}

export type AdminGate = { ok: true } | AdminGateFailure;

export interface AdminJobCounts {
  locked: number;
  released: number;
  timedOut: number;
  failed: number;
}

export interface AdminGmv {
  lockedUsdc: string;
  releasedUsdc: string;
  takeRateCollectedUsdc: string;
}

export interface AdminListingView {
  id: string;
  name: string;
  organizationId: string;
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

export interface AdminJobRecord {
  id: string;
  status: JobStatus;
  escrowState: AdminEscrowState;
  buyerOrganizationId: string;
  buyerOrganizationName: string;
  sellerOrganizationId: string;
  sellerOrganizationName: string;
  buyerAgentId: string;
  sellerAgentId: string;
  listingId: string;
  listingName: string;
  amountUsdc: string;
  takeRateUsdc: string;
  takeRateCollectedUsdc: string;
  sellerNetUsdc: string;
  createdAt: string;
  settledAt: string | null;
  deadlineAt: string | null;
  result: unknown;
  validationErrors: string[] | null;
  escrowId: string;
  holdAddress: string;
}

export interface AdminDeps {
  mode: RuntimeMode;
  rail: WalletRail;
  service: AgentFinanceService;
  registry: CapabilityRegistry;
  orchestrator: JobOrchestrator;
  /** The Hono app `bootstrapSandboxFleet` was attached to. */
  appHandle: object;
  /**
   * `undefined` reads `ROSTER_ADMIN_TOKEN` on each request.
   * A string sets the token. `null` or a blank string keeps the admin API disabled.
   */
  adminToken?: string | null;
}

export function isAdminPath(path: string): boolean {
  return path === "/v1/admin" || path.startsWith("/v1/admin/");
}

export function resolveConfiguredAdminToken(
  configured: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = configured !== undefined ? configured : env.ROSTER_ADMIN_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readPresentedAdminToken(headers: Headers): string | null {
  const header = headers.get(ADMIN_TOKEN_HEADER)?.trim() ?? "";
  if (header) return header;
  const authorization = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/.exec(authorization);
  if (match?.[1]) return match[1];
  return readCookie(headers.get("cookie"), ADMIN_COOKIE_NAME);
}

export function gateAdminAccess(presented: string | null, expected: string | null): AdminGate {
  if (!expected) {
    return {
      ok: false,
      status: 503,
      code: "admin_disabled",
      message: "Admin API is disabled. Set ROSTER_ADMIN_TOKEN on the API process.",
    };
  }
  if (!presented || !adminTokensMatch(presented, expected)) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "Admin token is missing or incorrect.",
    };
  }
  return { ok: true };
}

export function adminTokensMatch(presented: string, expected: string): boolean {
  if (presented.length === 0 || presented.length > MAX_PRESENTED_TOKEN) return false;
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const raw = trimmed.slice(eq + 1);
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** `null` means every status. Throws `ServiceError` when the filter is unknown. */
export function parseAdminJobStatus(raw: string | undefined): JobStatus | null {
  if (raw === undefined || raw.trim() === "" || raw.trim().toLowerCase() === "all") return null;
  const value = raw.trim().toLowerCase();
  if (value === "held" || value === "locked" || value === "open") return "held";
  if (value === "released") return "released";
  if (value === "timed_out" || value === "timedout" || value === "timed-out") return "timed_out";
  if (value === "failed" || value === "refunded") return "refunded";
  throw new ServiceError(
    400,
    "invalid_request",
    "status must be locked, released, timed_out, failed, or all.",
  );
}

export function summarizeJobs(jobs: readonly JobView[]): { counts: AdminJobCounts; gmv: AdminGmv } {
  const counts: AdminJobCounts = { locked: 0, released: 0, timedOut: 0, failed: 0 };
  const locked: string[] = [];
  const released: string[] = [];
  const collected: string[] = [];
  for (const job of jobs) {
    if (job.status === "held") {
      counts.locked += 1;
      locked.push(job.amountUsdc);
    } else if (job.status === "released") {
      counts.released += 1;
      released.push(job.amountUsdc);
      collected.push(job.takeRateUsdc);
    } else if (job.status === "timed_out") {
      counts.timedOut += 1;
    } else {
      counts.failed += 1;
    }
  }
  return {
    counts,
    gmv: {
      lockedUsdc: sumUsdc(locked),
      releasedUsdc: sumUsdc(released),
      takeRateCollectedUsdc: sumUsdc(collected),
    },
  };
}

/** Agents with status `active`. Suspended agents stay in the total count. */
export function countOnlineAgents(agents: readonly { status: string }[]): number {
  return agents.reduce((total, agent) => total + (agent.status === "active" ? 1 : 0), 0);
}

export function escrowStateForJob(status: JobStatus): AdminEscrowState {
  if (status === "held") return "locked";
  if (status === "released") return "released";
  return "refunded";
}

export function toAdminJob(job: JobView, names: ReadonlyMap<string, string>): AdminJobRecord {
  const collected = job.status === "released" ? job.takeRateUsdc : "0.000000";
  return {
    id: job.id,
    status: job.status,
    escrowState: escrowStateForJob(job.status),
    buyerOrganizationId: job.organizationId,
    buyerOrganizationName: names.get(job.organizationId) ?? job.organizationId,
    sellerOrganizationId: job.sellerOrganizationId,
    sellerOrganizationName: names.get(job.sellerOrganizationId) ?? job.sellerOrganizationId,
    buyerAgentId: job.buyerAgentId,
    sellerAgentId: job.sellerAgentId,
    listingId: job.listingId,
    listingName: job.listingName,
    amountUsdc: job.amountUsdc,
    takeRateUsdc: job.takeRateUsdc,
    takeRateCollectedUsdc: collected,
    sellerNetUsdc: job.sellerNetUsdc,
    createdAt: job.createdAt,
    settledAt: job.settledAt,
    deadlineAt: job.deadlineAt,
    result: job.result,
    validationErrors: job.validationErrors,
    escrowId: job.escrowId,
    holdAddress: job.holdAddress,
  };
}

export function describeListings(
  listings: readonly CapabilityListing[],
  bindings: readonly ListingSellerBinding[],
  accounts: readonly OperatorAccount[],
  agents: readonly OperatorAgentRef[],
): AdminListingView[] {
  const orgNames = new Map(accounts.map((account) => [account.organizationId, account.organizationName]));
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const bindingByListing = new Map(bindings.map((binding) => [binding.listingId, binding]));
  return listings
    .map((listing) => {
      const binding = bindingByListing.get(listing.id) ?? null;
      const sellerAgentId = binding?.sellerAgentId ?? listing.agentId;
      const organizationName = orgNames.get(listing.organizationId) ?? listing.organizationId;
      return {
        id: listing.id,
        name: listing.name,
        organizationId: listing.organizationId,
        organizationName,
        party: organizationName === SANDBOX_FLEET_ORG_NAME ? ("first_party" as const) : ("third_party" as const),
        autofill: binding?.autofill === true,
        sellerAgentId,
        sellerAgentName: sellerAgentId ? (agentNames.get(sellerAgentId) ?? null) : null,
        priceUsdc: listing.pricing.amountUsdc,
        pricingModel: listing.pricing.model,
        p95Ms: listing.latency.p95Ms,
        status: listing.status,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function registerAdminRoutes<E extends Env>(app: Hono<E>, deps: AdminDeps): void {
  app.get("/v1/admin/overview", async (c) => {
    const directory = await deps.service.listOperatorDirectory();
    const listed = deps.registry.list();
    const jobs = await deps.orchestrator.listAllJobs();
    const summary = summarizeJobs(jobs.jobs);
    return c.json({
      health: { ok: true, product: "Roster", mode: deps.mode, rail: deps.rail, asset: "USDC" },
      counts: {
        accounts: directory.accounts.filter((account) => account.userId !== null).length,
        organizations: directory.accounts.length,
        agents: directory.agents.length,
        agentsOnline: countOnlineAgents(directory.agents),
        listings: listed.length,
        jobs: summary.counts,
      },
      gmv: summary.gmv,
    });
  });

  app.get("/v1/admin/accounts", async (c) => {
    const directory = await deps.service.listOperatorDirectory();
    return c.json({ accounts: directory.accounts });
  });

  app.get("/v1/admin/listings", async (c) => {
    const directory = await deps.service.listOperatorDirectory();
    const bindings = await deps.orchestrator.listSellerBindings();
    return c.json({
      listings: describeListings(deps.registry.list(), bindings, directory.accounts, directory.agents),
    });
  });

  app.get("/v1/admin/jobs", async (c) => {
    const status = parseAdminJobStatus(c.req.query("status"));
    const names = await organizationNames(deps.service);
    const listed = await deps.orchestrator.listAllJobs();
    const jobs = listed.jobs
      .filter((job) => status === null || job.status === status)
      .map((job) => toAdminJob(job, names));
    return c.json({ jobs });
  });

  app.get("/v1/admin/jobs/:jobId", async (c) => {
    const names = await organizationNames(deps.service);
    const result = await deps.orchestrator.getAnyJob(c.req.param("jobId"));
    const job = toAdminJob(result.job, names);
    return c.json({
      job,
      escrow: {
        id: job.escrowId,
        state: job.escrowState,
        jobStatus: job.status,
        amountUsdc: job.amountUsdc,
        takeRateQuotedUsdc: job.takeRateUsdc,
        takeRateCollectedUsdc: job.takeRateCollectedUsdc,
        sellerNetUsdc: job.sellerNetUsdc,
        holdAddress: job.holdAddress,
        result: job.result,
        validationErrors: job.validationErrors,
        settledAt: job.settledAt,
      },
    });
  });

  app.get("/v1/admin/reputation", async (c) => {
    const reputation = await deps.service.listOperatorReputation();
    return c.json(reputation);
  });

  app.post("/v1/admin/jobs/expire", async (c) => {
    assertSandboxOps(deps.mode);
    const names = await organizationNames(deps.service);
    const expired = await deps.orchestrator.expireAllDue();
    const jobs = expired.jobs.map((job) => toAdminJob(job, names));
    return c.json({ jobs, swept: jobs.length });
  });

  app.post("/v1/admin/fleet/bootstrap", async (c) => {
    assertSandboxOps(deps.mode);
    const fleet = await bootstrapSandboxFleet(deps.appHandle);
    return c.json({ fleet });
  });
}

export function adminGateFor(headers: Headers, deps: Pick<AdminDeps, "adminToken">): AdminGate {
  return gateAdminAccess(readPresentedAdminToken(headers), resolveConfiguredAdminToken(deps.adminToken));
}

export function adminGateResponse(c: Context, gate: AdminGateFailure): Response {
  return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
}

function assertSandboxOps(mode: RuntimeMode): void {
  if (mode !== "sandbox") {
    throw new ServiceError(403, "forbidden", "Admin operations run only when the API mode is sandbox.");
  }
}

async function organizationNames(service: AgentFinanceService): Promise<Map<string, string>> {
  const organizations = await service.listOrganizations();
  return new Map(organizations.map((organization) => [organization.id, organization.name]));
}

function sumUsdc(amounts: readonly string[]): string {
  return amounts.reduce((total, amount) => addUsdc(total, amount), "0.000000");
}
