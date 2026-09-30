import { compareUsdc, type RuntimeMode } from "@albesa/core";
import type { CapabilityRegistry } from "@albesa/registry";
import { sandboxMarketplaceListings, type JobOrchestrator, type JobStore } from "./jobs.js";
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
  inflight: Promise<SandboxFleetSnapshot> | null;
}

const runtimes = new WeakMap<object, AppRuntime>();

export function attachAppRuntime(app: object, runtime: Omit<AppRuntime, "inflight">): void {
  runtimes.set(app, { ...runtime, inflight: null });
}

/**
 * Idempotent sandbox boot: Roster Labs, the six first-party listings, a bound
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
  const run = ensureSandboxFleet(runtime).finally(() => {
    runtime.inflight = null;
  });
  runtime.inflight = run;
  return run;
}

async function ensureSandboxFleet(runtime: AppRuntime): Promise<SandboxFleetSnapshot> {
  const organizations = await runtime.service.listOrganizations();
  let organization = oldest(
    organizations.filter((candidate) => candidate.name === SANDBOX_FLEET_ORG_NAME),
  );
  let createdOrganization = false;
  if (!organization) {
    const created = await runtime.service.createOrganization(SANDBOX_FLEET_ORG_NAME);
    organization = created.organization;
    createdOrganization = true;
  }
  const organizationId = organization.id;

  const agents = await runtime.service.listAgents(organizationId);
  let seller = oldest(
    agents.filter((agent) => agent.name === SANDBOX_FLEET_AGENT_NAME && agent.status === "active"),
  );
  if (!seller) {
    const created = await runtime.service.createAgent(organizationId, {
      name: SANDBOX_FLEET_AGENT_NAME,
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

  const drafts = sandboxMarketplaceListings();
  for (const draft of drafts) {
    const exists = runtime.registry
      .list()
      .some((listing) => listing.organizationId === organizationId && listing.name === draft.name);
    if (!exists) runtime.registry.register(organizationId, draft);
  }
  const listings = drafts.map((draft) => {
    const match = runtime.registry
      .list()
      .find((listing) => listing.organizationId === organizationId && listing.name === draft.name);
    if (!match) throw new Error(`Sandbox fleet listing "${draft.name}" was not published.`);
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
    organizationName: SANDBOX_FLEET_ORG_NAME,
    sellerAgentId,
    sellerAgentName: SANDBOX_FLEET_AGENT_NAME,
    listings: listings.map((listing) => ({ id: listing.id, name: listing.name })),
    createdOrganization,
  };
}

function oldest<T extends { createdAt: string }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
}
