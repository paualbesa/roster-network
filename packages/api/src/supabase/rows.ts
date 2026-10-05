import type {
  Agent,
  Escrow,
  LedgerEntry,
  MockWalletSnapshot,
  Organization,
  Policy,
  Transaction,
  UserAccount,
  Wallet,
} from "@albesa/core";
import {
  capabilityDocument,
  embedSemantic,
  type CapabilityListing,
  type CapabilityRegistry,
} from "@albesa/registry";
import {
  projectPassport,
  type ReputationEventRecord,
  type ReputationLedger,
  type ReputationTotals,
} from "@albesa/reputation";
import type { ListingSellerBinding, MemoryJobStore, StoredJob } from "../jobs.js";
import type { MemoryStore, WaitlistEntry } from "../store.js";
import { toVectorLiteral } from "./vector.js";

export const ROSTER_TABLES = {
  organizations: "organizations",
  profiles: "profiles",
  passwordHashes: "password_hashes",
  apiKeyHashes: "api_key_hashes",
  wallets: "wallets",
  agents: "agents",
  policies: "policies",
  walletBalances: "wallet_balances",
  walletState: "sandbox_wallet_state",
  escrows: "escrows",
  transactions: "transactions",
  ledger: "ledger_entries",
  listings: "capability_listings",
  jobs: "jobs",
  sellers: "listing_sellers",
  reputationTotals: "reputation_totals",
  reputationEvents: "reputation_events",
  waitlist: "waitlist_entries",
} as const;

const WALLET_STATE_ID = "sandbox";

export interface RosterSnapshot {
  organizations: Organization[];
  users: UserAccount[];
  authLinks: { authUserId: string; userId: string }[];
  passwordHashes: { userId: string; hash: string }[];
  apiKeyHashes: { hash: string; organizationId: string }[];
  agents: Agent[];
  wallets: Wallet[];
  policies: Policy[];
  escrows: Escrow[];
  escrowSellerOrgs: { id: string; sellerOrganizationId: string }[];
  transactions: Transaction[];
  ledger: LedgerEntry[];
  wallet: MockWalletSnapshot;
  listings: CapabilityListing[];
  embeddings: Record<string, string>;
  jobs: StoredJob[];
  sellers: ListingSellerBinding[];
  reputationTotals: ReputationTotals[];
  reputationEvents: ReputationEventRecord[];
  waitlist: WaitlistEntry[];
}

export function emptySnapshot(): RosterSnapshot {
  return {
    organizations: [],
    users: [],
    authLinks: [],
    passwordHashes: [],
    apiKeyHashes: [],
    agents: [],
    wallets: [],
    policies: [],
    escrows: [],
    escrowSellerOrgs: [],
    transactions: [],
    ledger: [],
    wallet: { balances: [], sequence: 0 },
    listings: [],
    embeddings: {},
    jobs: [],
    sellers: [],
    reputationTotals: [],
    reputationEvents: [],
    waitlist: [],
  };
}

export function captureSnapshot(input: {
  store: MemoryStore;
  wallet: MockWalletSnapshot;
  jobs: MemoryJobStore;
  reputation: ReputationLedger;
  registry: CapabilityRegistry;
}): RosterSnapshot {
  const authByUser = new Map<string, string>();
  for (const [authUserId, userId] of input.store.authUsersById) authByUser.set(userId, authUserId);
  const listings = input.registry.list();
  const embeddings: Record<string, string> = {};
  for (const listing of listings) {
    const stored = input.registry.embeddingFor(listing.id);
    embeddings[listing.id] = toVectorLiteral(stored ?? embedSemantic(capabilityDocument(listing)));
  }
  return {
    organizations: [...input.store.organizations.values()].map((organization) => ({ ...organization })),
    users: [...input.store.users.values()].map((user) => ({ ...user })),
    authLinks: [...authByUser.entries()].map(([userId, authUserId]) => ({ authUserId, userId })),
    passwordHashes: [...input.store.passwordHashes.entries()].map(([userId, hash]) => ({ userId, hash })),
    apiKeyHashes: [...input.store.apiKeys.entries()].map(([hash, organizationId]) => ({ hash, organizationId })),
    agents: [...input.store.agents.values()].map((agent) => ({ ...agent })),
    wallets: [...input.store.wallets.values()].map((wallet) => ({ ...wallet })),
    policies: [...input.store.policies.values()].map((policy) => ({
      ...policy,
      vendorAllowlist: policy.vendorAllowlist.slice(),
    })),
    escrows: [...input.store.escrows.values()].map((escrow) => structuredClone(escrow)),
    escrowSellerOrgs: [...input.store.escrows.values()].map((escrow) => ({
      id: escrow.id,
      sellerOrganizationId: input.store.agents.get(escrow.sellerAgentId)?.organizationId ?? escrow.organizationId,
    })),
    transactions: input.store.transactions.map((transaction) => ({ ...transaction })),
    ledger: input.store.ledger.map((entry) => ({ ...entry })),
    wallet: cloneWallet(input.wallet),
    listings,
    embeddings,
    jobs: input.jobs.listAllJobs(),
    sellers: input.jobs.listSellerBindings(),
    reputationTotals: input.reputation.listTotals(),
    reputationEvents: input.reputation.listEvents(),
    waitlist: [...input.store.waitlist.values()].map((entry) => ({ ...entry })),
  };
}

export function snapshotToRows(snapshot: RosterSnapshot): Record<string, Record<string, unknown>[]> {
  const sellerByEscrow = new Map(snapshot.escrowSellerOrgs.map((entry) => [entry.id, entry.sellerOrganizationId]));
  const orgByAddress = new Map(snapshot.wallets.map((wallet) => [wallet.address, wallet.organizationId]));
  const authByUser = new Map(snapshot.authLinks.map((link) => [link.userId, link.authUserId]));
  const balances: Record<string, unknown>[] = [];
  for (const entry of snapshot.wallet.balances) {
    const organizationId = orgByAddress.get(entry.address);
    if (!organizationId) continue;
    balances.push({
      address: entry.address,
      organization_id: organizationId,
      balance_usdc: entry.balanceUsdc,
    });
  }
  return {
    [ROSTER_TABLES.organizations]: snapshot.organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      treasury_wallet_id: organization.treasuryWalletId,
      mode: organization.mode,
      created_at: organization.createdAt,
    })),
    [ROSTER_TABLES.profiles]: snapshot.users.map((user) => ({
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      organization_id: user.organizationId,
      auth_user_id: authByUser.get(user.id) ?? null,
      created_at: user.createdAt,
    })),
    [ROSTER_TABLES.passwordHashes]: snapshot.passwordHashes.map((entry) => ({
      user_id: entry.userId,
      hash: entry.hash,
    })),
    [ROSTER_TABLES.apiKeyHashes]: snapshot.apiKeyHashes.map((entry) => ({
      hash: entry.hash,
      organization_id: entry.organizationId,
    })),
    [ROSTER_TABLES.wallets]: snapshot.wallets.map((wallet) => ({
      id: wallet.id,
      organization_id: wallet.organizationId,
      owner_type: wallet.ownerType,
      owner_id: wallet.ownerId,
      address: wallet.address,
      chain: wallet.chain,
      asset: wallet.asset,
      created_at: wallet.createdAt,
    })),
    [ROSTER_TABLES.agents]: snapshot.agents.map((agent) => ({
      id: agent.id,
      organization_id: agent.organizationId,
      name: agent.name,
      wallet_id: agent.walletId,
      policy_id: agent.policyId,
      status: agent.status,
      created_at: agent.createdAt,
    })),
    [ROSTER_TABLES.policies]: snapshot.policies.map((policy) => ({
      id: policy.id,
      organization_id: policy.organizationId,
      agent_id: policy.agentId,
      daily_spend_limit_usdc: policy.dailySpendLimitUsdc,
      vendor_allowlist: policy.vendorAllowlist.slice(),
      created_at: policy.createdAt,
    })),
    [ROSTER_TABLES.walletBalances]: balances,
    [ROSTER_TABLES.walletState]: [{ id: WALLET_STATE_ID, body: cloneWallet(snapshot.wallet) }],
    [ROSTER_TABLES.escrows]: snapshot.escrows.map((escrow) => ({
      id: escrow.id,
      organization_id: escrow.organizationId,
      seller_organization_id: sellerByEscrow.get(escrow.id) ?? escrow.organizationId,
      status: escrow.status,
      body: escrow,
    })),
    [ROSTER_TABLES.transactions]: snapshot.transactions.map((transaction) => ({
      id: transaction.id,
      organization_id: transaction.organizationId,
      body: transaction,
    })),
    [ROSTER_TABLES.ledger]: snapshot.ledger.map((entry) => ({
      id: entry.id,
      organization_id: entry.organizationId,
      body: entry,
    })),
    [ROSTER_TABLES.listings]: snapshot.listings.map((listing) => ({
      id: listing.id,
      organization_id: listing.organizationId,
      status: listing.status,
      body: listing,
      embedding: snapshot.embeddings[listing.id] ?? toVectorLiteral(embedSemantic(capabilityDocument(listing))),
    })),
    [ROSTER_TABLES.jobs]: snapshot.jobs.map((job) => ({
      id: job.id,
      organization_id: job.organizationId,
      seller_organization_id: job.sellerOrganizationId,
      status: job.status,
      body: job,
    })),
    [ROSTER_TABLES.sellers]: snapshot.sellers.map((seller) => ({
      listing_id: seller.listingId,
      organization_id: seller.organizationId,
      seller_agent_id: seller.sellerAgentId,
      autofill: seller.autofill,
      created_at: seller.createdAt,
    })),
    [ROSTER_TABLES.reputationTotals]: snapshot.reputationTotals.map(reputationTotalsRow),
    [ROSTER_TABLES.reputationEvents]: snapshot.reputationEvents.map(reputationEventRow),
    [ROSTER_TABLES.waitlist]: snapshot.waitlist.map((entry) => ({
      email: entry.email,
      source: entry.source,
      created_at: entry.createdAt,
    })),
  };
}

export function rowsToSnapshot(tables: Record<string, Record<string, unknown>[]>): RosterSnapshot {
  const snapshot = emptySnapshot();
  for (const row of tables[ROSTER_TABLES.organizations] ?? []) {
    snapshot.organizations.push({
      id: requiredString(row, "id", "organizations"),
      name: requiredString(row, "name", "organizations"),
      treasuryWalletId: requiredString(row, "treasury_wallet_id", "organizations"),
      mode: requiredMode(row.mode),
      createdAt: requiredString(row, "created_at", "organizations"),
    });
  }
  for (const row of tables[ROSTER_TABLES.profiles] ?? []) {
    const user: UserAccount = {
      id: requiredString(row, "id", "profiles"),
      email: requiredString(row, "email", "profiles"),
      displayName: requiredString(row, "display_name", "profiles"),
      organizationId: requiredString(row, "organization_id", "profiles"),
      createdAt: requiredString(row, "created_at", "profiles"),
    };
    snapshot.users.push(user);
    const authUserId = row.auth_user_id;
    if (authUserId !== null && authUserId !== undefined) {
      if (typeof authUserId !== "string" || authUserId.length === 0) {
        throw new Error("profiles.auth_user_id must be a uuid or null.");
      }
      snapshot.authLinks.push({ authUserId, userId: user.id });
    }
  }
  for (const row of tables[ROSTER_TABLES.passwordHashes] ?? []) {
    snapshot.passwordHashes.push({
      userId: requiredString(row, "user_id", "password_hashes"),
      hash: requiredString(row, "hash", "password_hashes"),
    });
  }
  for (const row of tables[ROSTER_TABLES.apiKeyHashes] ?? []) {
    snapshot.apiKeyHashes.push({
      hash: requiredString(row, "hash", "api_key_hashes"),
      organizationId: requiredString(row, "organization_id", "api_key_hashes"),
    });
  }
  for (const row of tables[ROSTER_TABLES.wallets] ?? []) {
    const ownerType = row.owner_type;
    if (ownerType !== "organization" && ownerType !== "agent") {
      throw new Error("wallets.owner_type is invalid.");
    }
    const asset = row.asset;
    if (asset !== "USDC") throw new Error("wallets.asset must be USDC.");
    snapshot.wallets.push({
      id: requiredString(row, "id", "wallets"),
      organizationId: requiredString(row, "organization_id", "wallets"),
      ownerType,
      ownerId: requiredString(row, "owner_id", "wallets"),
      address: requiredString(row, "address", "wallets"),
      chain: requiredChain(row.chain),
      asset,
      createdAt: requiredString(row, "created_at", "wallets"),
    });
  }
  for (const row of tables[ROSTER_TABLES.agents] ?? []) {
    const status = row.status;
    if (status !== "active" && status !== "suspended") throw new Error("agents.status is invalid.");
    snapshot.agents.push({
      id: requiredString(row, "id", "agents"),
      organizationId: requiredString(row, "organization_id", "agents"),
      name: requiredString(row, "name", "agents"),
      walletId: requiredString(row, "wallet_id", "agents"),
      policyId: requiredString(row, "policy_id", "agents"),
      status,
      createdAt: requiredString(row, "created_at", "agents"),
    });
  }
  for (const row of tables[ROSTER_TABLES.policies] ?? []) {
    const allowlist = row.vendor_allowlist;
    if (!Array.isArray(allowlist) || !allowlist.every((entry) => typeof entry === "string")) {
      throw new Error("policies.vendor_allowlist must be an array of strings.");
    }
    snapshot.policies.push({
      id: requiredString(row, "id", "policies"),
      organizationId: requiredString(row, "organization_id", "policies"),
      agentId: requiredString(row, "agent_id", "policies"),
      dailySpendLimitUsdc: requiredString(row, "daily_spend_limit_usdc", "policies"),
      vendorAllowlist: allowlist,
      createdAt: requiredString(row, "created_at", "policies"),
    });
  }
  const walletRow = (tables[ROSTER_TABLES.walletState] ?? []).find((row) => row.id === WALLET_STATE_ID);
  snapshot.wallet = walletRow ? parseWalletBody(walletRow.body) : { balances: [], sequence: 0 };
  for (const row of tables[ROSTER_TABLES.escrows] ?? []) {
    snapshot.escrows.push(parseBody<Escrow>(row.body, "escrows"));
    snapshot.escrowSellerOrgs.push({
      id: requiredString(row, "id", "escrows"),
      sellerOrganizationId: requiredString(row, "seller_organization_id", "escrows"),
    });
  }
  for (const row of tables[ROSTER_TABLES.transactions] ?? []) {
    snapshot.transactions.push(parseBody<Transaction>(row.body, "transactions"));
  }
  for (const row of tables[ROSTER_TABLES.ledger] ?? []) {
    snapshot.ledger.push(parseBody<LedgerEntry>(row.body, "ledger_entries"));
  }
  for (const row of tables[ROSTER_TABLES.listings] ?? []) {
    const listing = parseBody<CapabilityListing>(row.body, "capability_listings");
    snapshot.listings.push(listing);
    const embedding = row.embedding;
    if (typeof embedding === "string") snapshot.embeddings[listing.id] = embedding;
  }
  for (const row of tables[ROSTER_TABLES.jobs] ?? []) {
    snapshot.jobs.push(parseBody<StoredJob>(row.body, "jobs"));
  }
  for (const row of tables[ROSTER_TABLES.sellers] ?? []) {
    snapshot.sellers.push({
      listingId: requiredString(row, "listing_id", "listing_sellers"),
      organizationId: requiredString(row, "organization_id", "listing_sellers"),
      sellerAgentId: requiredString(row, "seller_agent_id", "listing_sellers"),
      autofill: row.autofill === true,
      createdAt: requiredString(row, "created_at", "listing_sellers"),
    });
  }
  for (const row of tables[ROSTER_TABLES.reputationTotals] ?? []) {
    snapshot.reputationTotals.push(reputationTotalsFromRow(row));
  }
  for (const row of tables[ROSTER_TABLES.reputationEvents] ?? []) {
    snapshot.reputationEvents.push(reputationEventFromRow(row));
  }
  for (const row of tables[ROSTER_TABLES.waitlist] ?? []) {
    const source = row.source;
    snapshot.waitlist.push({
      email: requiredString(row, "email", "waitlist_entries"),
      source: typeof source === "string" ? source : null,
      createdAt: normalizeTimestamp(requiredString(row, "created_at", "waitlist_entries")),
    });
  }
  return snapshot;
}

export function applySnapshot(input: {
  snapshot: RosterSnapshot;
  store: MemoryStore;
  jobs: MemoryJobStore;
  reputation: { replaceAll(totals: ReputationTotals[], events: ReputationEventRecord[]): void };
  registry: CapabilityRegistry;
}): void {
  const { snapshot, store } = input;
  store.organizations.clear();
  store.users.clear();
  store.usersByEmail.clear();
  store.passwordHashes.clear();
  store.apiKeys.clear();
  store.authUsersById.clear();
  store.agents.clear();
  store.wallets.clear();
  store.policies.clear();
  store.escrows.clear();
  store.transactions.length = 0;
  store.ledger.length = 0;
  store.waitlist.clear();
  for (const organization of snapshot.organizations) store.organizations.set(organization.id, organization);
  for (const user of snapshot.users) {
    const email = user.email.toLowerCase();
    if (store.usersByEmail.has(email)) throw new Error(`Duplicate profile email ${email}.`);
    store.users.set(user.id, user);
    store.usersByEmail.set(email, user.id);
  }
  for (const entry of snapshot.passwordHashes) store.passwordHashes.set(entry.userId, entry.hash);
  for (const entry of snapshot.apiKeyHashes) store.apiKeys.set(entry.hash, entry.organizationId);
  for (const link of snapshot.authLinks) store.authUsersById.set(link.authUserId, link.userId);
  for (const agent of snapshot.agents) store.agents.set(agent.id, agent);
  for (const wallet of snapshot.wallets) store.wallets.set(wallet.id, wallet);
  for (const policy of snapshot.policies) store.policies.set(policy.id, policy);
  for (const escrow of snapshot.escrows) store.escrows.set(escrow.id, escrow);
  store.transactions.push(...snapshot.transactions);
  store.ledger.push(...snapshot.ledger);
  for (const entry of snapshot.waitlist) store.waitlist.set(entry.email, entry);
  input.jobs.replaceAll(snapshot.jobs, snapshot.sellers);
  input.reputation.replaceAll(snapshot.reputationTotals, snapshot.reputationEvents);
  input.registry.replaceAll(snapshot.listings);
}

export const UPSERT_ORDER = [
  ROSTER_TABLES.organizations,
  ROSTER_TABLES.profiles,
  ROSTER_TABLES.passwordHashes,
  ROSTER_TABLES.apiKeyHashes,
  ROSTER_TABLES.wallets,
  ROSTER_TABLES.agents,
  ROSTER_TABLES.policies,
  ROSTER_TABLES.walletBalances,
  ROSTER_TABLES.walletState,
  ROSTER_TABLES.escrows,
  ROSTER_TABLES.transactions,
  ROSTER_TABLES.ledger,
  ROSTER_TABLES.listings,
  ROSTER_TABLES.jobs,
  ROSTER_TABLES.sellers,
  ROSTER_TABLES.reputationTotals,
  ROSTER_TABLES.reputationEvents,
  ROSTER_TABLES.waitlist,
] as const;

export const DELETE_ORDER: { table: string; column: string }[] = [
  { table: ROSTER_TABLES.waitlist, column: "email" },
  { table: ROSTER_TABLES.reputationEvents, column: "id" },
  { table: ROSTER_TABLES.reputationTotals, column: "agent_id" },
  { table: ROSTER_TABLES.sellers, column: "listing_id" },
  { table: ROSTER_TABLES.jobs, column: "id" },
  { table: ROSTER_TABLES.listings, column: "id" },
  { table: ROSTER_TABLES.ledger, column: "id" },
  { table: ROSTER_TABLES.transactions, column: "id" },
  { table: ROSTER_TABLES.escrows, column: "id" },
  { table: ROSTER_TABLES.walletBalances, column: "address" },
  { table: ROSTER_TABLES.policies, column: "id" },
  { table: ROSTER_TABLES.agents, column: "id" },
  { table: ROSTER_TABLES.wallets, column: "id" },
  { table: ROSTER_TABLES.apiKeyHashes, column: "hash" },
  { table: ROSTER_TABLES.passwordHashes, column: "user_id" },
  { table: ROSTER_TABLES.profiles, column: "id" },
  { table: ROSTER_TABLES.organizations, column: "id" },
  { table: ROSTER_TABLES.walletState, column: "id" },
];

function reputationTotalsRow(totals: ReputationTotals): Record<string, unknown> {
  const passport = projectPassport(totals);
  return {
    agent_id: totals.agentId,
    organization_id: totals.organizationId,
    event_count: totals.eventCount,
    success_count: totals.successCount,
    failure_count: totals.failureCount,
    error_count: totals.errorCount,
    hallucination_count: totals.hallucinationCount,
    latency_total_ms: totals.latencyTotalMs,
    volume_settled_usdc: totals.volumeSettledUsdc,
    success_rate: passport.metrics.successRate,
    avg_latency_ms: passport.metrics.avgLatencyMs,
    error_index: passport.metrics.errorIndex,
    score: passport.score,
    updated_at: totals.updatedAt,
    body: totals,
  };
}

function reputationEventRow(event: ReputationEventRecord): Record<string, unknown> {
  return {
    id: event.id,
    organization_id: event.organizationId,
    agent_id: event.agentId,
    outcome: event.outcome,
    latency_ms: event.latencyMs,
    volume_usdc: event.volumeUsdc,
    is_error: event.error,
    hallucination: event.hallucination,
    source_ref: event.sourceRef,
    created_at: event.createdAt,
    body: event,
  };
}

/** Columns win when the passport migration is present. Older rows still use body. */
function reputationTotalsFromRow(row: Record<string, unknown>): ReputationTotals {
  if (!("event_count" in row)) return parseBody<ReputationTotals>(row.body, "reputation_totals");
  const updatedAt = row.updated_at;
  if (updatedAt !== null && updatedAt !== undefined && typeof updatedAt !== "string") {
    throw new Error("reputation_totals.updated_at must be a string or null.");
  }
  return {
    agentId: requiredString(row, "agent_id", "reputation_totals"),
    organizationId: requiredString(row, "organization_id", "reputation_totals"),
    eventCount: countField(row.event_count, "reputation_totals.event_count"),
    successCount: countField(row.success_count, "reputation_totals.success_count"),
    failureCount: countField(row.failure_count, "reputation_totals.failure_count"),
    errorCount: countField(row.error_count, "reputation_totals.error_count"),
    hallucinationCount: countField(row.hallucination_count, "reputation_totals.hallucination_count"),
    latencyTotalMs: countField(row.latency_total_ms, "reputation_totals.latency_total_ms"),
    volumeSettledUsdc: requiredString(row, "volume_settled_usdc", "reputation_totals"),
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
  };
}

function reputationEventFromRow(row: Record<string, unknown>): ReputationEventRecord {
  if (!("outcome" in row)) return parseBody<ReputationEventRecord>(row.body, "reputation_events");
  const outcome = row.outcome;
  if (outcome !== "success" && outcome !== "failure") {
    throw new Error("reputation_events.outcome is invalid.");
  }
  const sourceRef = row.source_ref;
  if (sourceRef !== null && sourceRef !== undefined && typeof sourceRef !== "string") {
    throw new Error("reputation_events.source_ref must be a string or null.");
  }
  if (typeof row.is_error !== "boolean") throw new Error("reputation_events.is_error must be a boolean.");
  if (typeof row.hallucination !== "boolean") {
    throw new Error("reputation_events.hallucination must be a boolean.");
  }
  return {
    id: requiredString(row, "id", "reputation_events"),
    agentId: requiredString(row, "agent_id", "reputation_events"),
    organizationId: requiredString(row, "organization_id", "reputation_events"),
    outcome,
    latencyMs: countField(row.latency_ms, "reputation_events.latency_ms"),
    volumeUsdc: requiredString(row, "volume_usdc", "reputation_events"),
    error: row.is_error,
    hallucination: row.hallucination,
    sourceRef: typeof sourceRef === "string" ? sourceRef : null,
    createdAt: requiredString(row, "created_at", "reputation_events"),
  };
}

function countField(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${label} must be a non-negative integer.`);
}

function cloneWallet(snapshot: MockWalletSnapshot): MockWalletSnapshot {
  return {
    balances: snapshot.balances.map((entry) => ({ address: entry.address, balanceUsdc: entry.balanceUsdc })),
    sequence: snapshot.sequence,
    ...(snapshot.networkFeesCollectedUsdc !== undefined
      ? { networkFeesCollectedUsdc: snapshot.networkFeesCollectedUsdc }
      : {}),
  };
}

function requiredString(row: Record<string, unknown>, key: string, table: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${table}.${key} must be a non-empty string.`);
  }
  return value;
}

function requiredMode(value: unknown): Organization["mode"] {
  if (value === "sandbox" || value === "testnet") return value;
  throw new Error("organizations.mode is invalid.");
}

function requiredChain(value: unknown): Wallet["chain"] {
  if (
    value === "mock" ||
    value === "base-sepolia" ||
    value === "base-sepolia-sim" ||
    value === "solana-devnet-sim"
  ) {
    return value;
  }
  throw new Error("wallets.chain is invalid.");
}

function parseWalletBody(value: unknown): MockWalletSnapshot {
  if (!isRecord(value) || !Array.isArray(value.balances) || typeof value.sequence !== "number") {
    throw new Error("sandbox_wallet_state body is invalid.");
  }
  const balances: { address: string; balanceUsdc: string }[] = [];
  for (const entry of value.balances) {
    if (!isRecord(entry) || typeof entry.address !== "string" || typeof entry.balanceUsdc !== "string") {
      throw new Error("sandbox_wallet_state balance is invalid.");
    }
    balances.push({ address: entry.address, balanceUsdc: entry.balanceUsdc });
  }
  const fees = value.networkFeesCollectedUsdc;
  if (fees !== undefined && typeof fees !== "string") {
    throw new Error("sandbox_wallet_state network fee is invalid.");
  }
  return {
    balances,
    sequence: value.sequence,
    ...(typeof fees === "string" ? { networkFeesCollectedUsdc: fees } : {}),
  };
}

function parseBody<T>(value: unknown, table: string): T {
  if (!isRecord(value)) throw new Error(`${table} body must be a JSON object.`);
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Postgres returns `2026-10-05T10:00:00+00:00`. Keep the ISO form the API writes. */
function normalizeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}
