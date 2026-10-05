import { compareUsdc, type RuntimeMode } from "@albesa/core";
import type { CapabilityRegistry } from "@albesa/registry";
import type { SandboxCapabilityDraft } from "./catalog.js";
import type { DataCatalog } from "./data/catalog.js";
import { rosterFleetListings, type JobOrchestrator, type JobStore } from "./jobs.js";
import type { AgentFinanceService } from "./service.js";

/** System seller that publishes the first-party sandbox catalog. */
export const SANDBOX_FLEET_ORG_NAME = "Roster Labs";
/** Agent that receives escrow for every autofill listing. */
export const SANDBOX_FLEET_AGENT_NAME = "Roster Fleet";
/**
 * Moved from the Roster Labs treasury onto the fleet agent once, while its
 * balance is still zero. Escrow release pays this wallet from the buyer lock.
 */
export const SANDBOX_FLEET_FUND_USDC = "1.00";

/** First-party organization that sells data products Roster collects itself. */
export const DATA_ORG_NAME = "Roster Data";
/** Seller agent that receives escrow for every data product. */
export const DATA_AGENT_NAME = "Roster Data";

export interface SandboxFleetListing {
  id: string;
  name: string;
}

export interface SandboxFleetSnapshot {
  organizationId: string;
  organizationName: string;
  sellerAgentId: string;
  sellerAgentName: string;
  listings: SandboxFleetListing[];
  /** True when this call created the Roster Labs organization. */
  createdOrganization: boolean;
}

interface AppRuntime {
  mode: RuntimeMode;
  service: AgentFinanceService;
  registry: CapabilityRegistry;
  jobs: JobStore;
  orchestrator: JobOrchestrator;
  data: DataCatalog | null;
  inflight: Promise<SandboxFleetSnapshot> | null;
  dataInflight: Promise<SandboxFleetSnapshot> | null;
}

const runtimes = new WeakMap<object, AppRuntime>();

export function attachAppRuntime(app: object, runtime: Omit<AppRuntime, "inflight" | "dataInflight">): void {
  runtimes.set(app, { ...runtime, inflight: null, dataInflight: null });
}

/** The data catalog behind an app, or null when data products are off. */
export function appDataCatalog(app: object): DataCatalog | null {
  return runtimes.get(app)?.data ?? null;
}

/**
 * Idempotent: the Roster Data organization, a funded seller agent, one listing
 * per data product (kind dataset/feed/lookup), and autofill bindings that
 * deliver through the data catalog. Sandbox only.
 */
export function bootstrapDataProducts(app: object): Promise<SandboxFleetSnapshot> {
  const runtime = runtimes.get(app);
  if (!runtime) throw new Error("bootstrapDataProducts requires the Hono app returned by createApp.");
  if (runtime.mode !== "sandbox") throw new Error("Data product bootstrap only runs when the API mode is sandbox.");
  const data = runtime.data;
  if (!data) throw new Error("This app has no data catalog.");
  if (runtime.dataInflight) return runtime.dataInflight;
  const run = ensureFirstPartySeller(runtime, DATA_ORG_NAME, DATA_AGENT_NAME, data.drafts(), { syncDrafts: true }).finally(() => {
    runtime.dataInflight = null;
  });
  runtime.dataInflight = run;
  return run;
}

/**
 * Refund every held job whose listing SLA has passed, across organizations.
 * server.ts calls it on a timer so a buyer never has to poll `POST /v1/jobs/expire`.
 */
export async function sweepExpiredJobs(app: object): Promise<number> {
  const runtime = runtimes.get(app);
  if (!runtime) throw new Error("sweepExpiredJobs requires the Hono app returned by createApp.");
  const expired = await runtime.orchestrator.expireAllDue();
  return expired.jobs.length;
}

/**
 * Idempotent sandbox boot: Roster Labs, the Roster Fleet catalog, a bound
 * seller agent, and a treasury transfer so that agent can be paid.
 * A second call keeps the same organization, agent, and listing ids.
 * Refuses every mode except sandbox.
 */
export function bootstrapSandboxFleet(app: object): Promise<SandboxFleetSnapshot> {
  const runtime = runtimes.get(app);
  if (!runtime) {
    throw new Error("bootstrapSandboxFleet requires the Hono app returned by createApp.");
  }
  if (runtime.mode !== "sandbox") {
    throw new Error("Sandbox fleet bootstrap only runs when the API mode is sandbox.");
  }
  if (runtime.inflight) return runtime.inflight;
  const run = ensureFirstPartySeller(runtime, SANDBOX_FLEET_ORG_NAME, SANDBOX_FLEET_AGENT_NAME, rosterFleetListings()).finally(() => {
    runtime.inflight = null;
  });
  runtime.inflight = run;
  return run;
}

async function ensureFirstPartySeller(
  runtime: AppRuntime,
  orgName: string,
  agentName: string,
  drafts: SandboxCapabilityDraft[],
  options: { syncDrafts?: boolean } = {},
): Promise<SandboxFleetSnapshot> {
  const organizations = await runtime.service.listOrganizations();
  let organization = oldest(organizations.filter((candidate) => candidate.name === orgName));
  let createdOrganization = false;
  if (!organization) {
    const created = await runtime.service.createOrganization(orgName);
    organization = created.organization;
    createdOrganization = true;
  }
  const organizationId = organization.id;

  const agents = await runtime.service.listAgents(organizationId);
  let seller = oldest(
    agents.filter((agent) => agent.name === agentName && agent.status === "active"),
  );
  if (!seller) {
    const created = await runtime.service.createAgent(organizationId, {
      name: agentName,
      dailySpendLimitUsdc: "1000.00",
      vendorAllowlist: [],
    });
    seller = created.agent;
  }
  const sellerAgentId = seller.id;
  const balance = await runtime.service.getAgentBalance(organizationId, sellerAgentId);
  if (compareUsdc(balance.balanceUsdc, "0.000000") === 0) {
    await runtime.service.fundAgent(organizationId, sellerAgentId, SANDBOX_FLEET_FUND_USDC);
  }

  for (const draft of drafts) {
    const existing = runtime.registry
      .list()
      .find((listing) => listing.organizationId === organizationId && listing.name === draft.name);
    if (!existing) {
      runtime.registry.register(organizationId, draft);
    } else if (options.syncDrafts && listingDrifted(existing as unknown as Record<string, unknown>, draft)) {
      // Data product descriptions, schemas and prices evolve with the code: keep the listing in step.
      runtime.registry.update(organizationId, existing.id, draft);
    }
  }
  const listings = drafts.map((draft) => {
    const match = runtime.registry
      .list()
      .find((listing) => listing.organizationId === organizationId && listing.name === draft.name);
    if (!match) throw new Error(`First-party listing "${draft.name}" was not published.`);
    return match;
  });

  for (const listing of listings) {
    const binding = runtime.jobs.readSeller(listing.id);
    if (
      binding?.autofill === true &&
      binding.organizationId === organizationId &&
      binding.sellerAgentId === sellerAgentId &&
      listing.agentId === sellerAgentId
    ) {
      continue;
    }
    await runtime.orchestrator.bindSeller(organizationId, listing.id, sellerAgentId, { autofill: true });
  }

  return {
    organizationId,
    organizationName: orgName,
    sellerAgentId,
    sellerAgentName: agentName,
    listings: listings.map((listing) => ({ id: listing.id, name: listing.name })),
    createdOrganization,
  };
}

function listingDrifted(listing: Record<string, unknown>, draft: SandboxCapabilityDraft): boolean {
  const record = draft as unknown as Record<string, unknown>;
  const pricing = listing.pricing as { model?: string; amountUsdc?: string } | undefined;
  if (pricing?.model !== draft.pricing.model || compareUsdc(pricing.amountUsdc ?? "0", draft.pricing.amountUsdc) !== 0) return true;
  for (const key of ["description", "inputSchema", "outputSchema", "latency", "tags", "kind", "data"]) {
    if (!(key in record)) continue;
    const want = key === "tags" ? [...(record.tags as string[])].sort() : record[key];
    const have = key === "tags" ? [...((listing.tags as string[] | undefined) ?? [])].sort() : listing[key];
    if (stableJson(want) !== stableJson(have)) return true;
  }
  return false;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : inner,
  );
}

function oldest<T extends { createdAt: string }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
}
