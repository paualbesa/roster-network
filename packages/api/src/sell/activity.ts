import { createHash } from "node:crypto";
import { looksLikeSolanaSignature, solanaExplorerTxUrl } from "@albesa/solana";
import type { CapabilityRegistry } from "@albesa/registry";
import type { JobStore, StoredJob } from "../jobs.js";
import type { AgentFinanceService } from "../service.js";
import type { SellerDirectory } from "./sellers.js";

/** Who the first-party organizations are. Filled at boot by the fleet bootstrap. */
export interface FirstPartyOrgs {
  labs: string | null;
  data: string | null;
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
  chain?: string;
  settlementProviderRef?: string | null;
  explorerUrl?: string | null;
  railLabel?: string | null;
}

export interface LeaderboardEntry {
  sellerAgentId: string;
  seller: string;
  sellerKind: "first_party" | "independent";
  founding: { number: number; until: string; active: boolean } | null;
  listings: number;
  releasedJobs: number;
  volumeUsdc: string;
  passportScore: string | null;
  successRate: string | null;
}

/** Only real jobs from the job store (mock USDC). Never add synthetic rows here. */
export async function buildActivity(deps: {
  jobs: JobStore;
  registry: CapabilityRegistry;
  service: AgentFinanceService;
  sellers: SellerDirectory;
  firstParty: FirstPartyOrgs;
  orgNames: Map<string, string>;
  now?: Date;
  limit?: number;
}): Promise<{
  sandbox: true;
  notice: string;
  items: ActivityItem[];
  totals: { jobs24h: number; released24h: number; volume24hUsdc: string; independentSellers: number; firstPartyJobs24h: number };
  leaderboard: LeaderboardEntry[];
}> {
  const now = (deps.now ?? new Date()).getTime();
  const all = deps.jobs.listAllJobs().sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const items = all.slice(0, deps.limit ?? 50).map((job) => toItem(job, deps));
  const day = all.filter((job) => now - Date.parse(job.createdAt) <= 86_400_000);
  const released24 = day.filter((job) => job.status === "released");

  const bySeller = new Map<string, { job: StoredJob; released: number; micros: bigint }>();
  for (const job of all) {
    const entry = bySeller.get(job.sellerAgentId) ?? { job, released: 0, micros: 0n };
    if (job.status === "released") {
      entry.released += 1;
      entry.micros += toMicros(job.amountUsdc);
    }
    bySeller.set(job.sellerAgentId, entry);
  }
  const listingCount = new Map<string, number>();
  for (const listing of deps.registry.list()) {
    if (listing.agentId && listing.status === "active") listingCount.set(listing.agentId, (listingCount.get(listing.agentId) ?? 0) + 1);
  }
  const leaderboard: LeaderboardEntry[] = [];
  const ranked = [...bySeller.entries()].filter(([, entry]) => entry.released > 0).sort((left, right) => (right[1].micros > left[1].micros ? 1 : right[1].micros < left[1].micros ? -1 : right[1].released - left[1].released)).slice(0, 20);
  for (const [agentId, entry] of ranked) {
    const org = entry.job.sellerOrganizationId;
    let passportScore: string | null = null;
    let successRate: string | null = null;
    try {
      const passport = (await deps.service.getPassport(agentId)) as unknown as { score?: string; metrics?: { successRate?: string } };
      passportScore = passport.score ?? null;
      successRate = passport.metrics?.successRate ?? null;
    } catch {
      // Agent gone: keep the row without a score.
    }
    leaderboard.push({
      sellerAgentId: agentId,
      seller: sellerLabel(org, deps),
      sellerKind: isFirstParty(org, deps.firstParty) ? "first_party" : "independent",
      founding: deps.sellers.badge(org),
      listings: listingCount.get(agentId) ?? 0,
      releasedJobs: entry.released,
      volumeUsdc: fromMicros(entry.micros),
      passportScore,
      successRate,
    });
  }
  const independent = new Set(deps.registry.list().filter((listing) => listing.status === "active" && !isFirstParty(listing.organizationId, deps.firstParty) && deps.sellers.endpointFor(listing.id)).map((listing) => listing.organizationId));
  return {
    sandbox: true,
    notice: "Sandbox network: every row is a real job. Settlement rail is mock USDC by default, or Solana Devnet test SPL when ROSTER_RAIL=solana-devnet. Roster Fleet is Roster's own scheduled buyer.",
    items,
    totals: {
      jobs24h: day.length,
      released24h: released24.length,
      volume24hUsdc: fromMicros(released24.reduce((sum, job) => sum + toMicros(job.amountUsdc), 0n)),
      independentSellers: independent.size,
      firstPartyJobs24h: day.filter((job) => isFirstParty(job.organizationId, deps.firstParty)).length,
    },
    leaderboard,
  };
}

function toItem(job: StoredJob, deps: { firstParty: FirstPartyOrgs; orgNames: Map<string, string>; sellers: SellerDirectory }): ActivityItem {
  const buyerOrg = job.organizationId;
  const buyerKind: ActivityItem["buyerKind"] =
    buyerOrg === deps.firstParty.labs ? "roster_fleet" : isFirstParty(buyerOrg, deps.firstParty) ? "first_party" : "sandbox_user";
  const settlementRef = job.settlementProviderRef ?? null;
  const chain = job.chain ?? "mock";
  const explorerUrl =
    looksLikeSolanaSignature(settlementRef) && chain === "solana-devnet"
      ? solanaExplorerTxUrl(settlementRef!, "devnet")
      : null;
  return {
    id: job.id,
    sandbox: true,
    product: job.listingName,
    listingId: job.listingId,
    seller: sellerLabel(job.sellerOrganizationId, deps),
    sellerKind: isFirstParty(job.sellerOrganizationId, deps.firstParty) ? "first_party" : "independent",
    buyer: buyerKind === "roster_fleet" ? "Roster Fleet" : buyerKind === "first_party" ? (deps.orgNames.get(buyerOrg) ?? "Roster") : `Sandbox buyer ${shortHash(buyerOrg)}`,
    buyerKind,
    amountUsdc: job.amountUsdc,
    latencyMs: job.latencyMs,
    status: job.status,
    at: job.settledAt ?? job.createdAt,
    chain,
    settlementProviderRef: settlementRef,
    explorerUrl,
    railLabel: chain === "solana-devnet" ? "solana-devnet · test SPL" : null,
  };
}

/** First-party sellers show their org name. Independent sellers stay pseudonymous (org names can be personal). */
function sellerLabel(organizationId: string, deps: { firstParty: FirstPartyOrgs; orgNames: Map<string, string>; sellers: SellerDirectory }): string {
  if (isFirstParty(organizationId, deps.firstParty)) return deps.orgNames.get(organizationId) ?? "Roster";
  const badge = deps.sellers.badge(organizationId);
  return badge ? `Founding seller #${badge.number.toString()}` : `Seller ${shortHash(organizationId)}`;
}

export function isFirstParty(organizationId: string, firstParty: FirstPartyOrgs): boolean {
  return organizationId === firstParty.labs || organizationId === firstParty.data;
}

function shortHash(value: string): string {
  return createHash("sha256").update(`roster-activity:${value}`).digest("hex").slice(0, 6);
}

function toMicros(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

function fromMicros(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${frac}`;
}
