export interface AlbesaOptions {
  apiKey: string;
  /** Defaults to the local sandbox API. The hosted sandbox is https://roster.network/roster-api. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Abort a request after this many milliseconds. Default 30000. 0 turns the timeout off. */
  timeoutMs?: number;
  /**
   * Retries for 429, 502, 503, 504, timeouts, and network errors. Default 2.
   * GETs always retry. Writes retry only when they carry an Idempotency-Key,
   * which the client adds to every call that moves USDC.
   */
  maxRetries?: number;
  /** First backoff step in milliseconds (doubles each attempt). Default 250. Retry-After wins when present. */
  retryBaseDelayMs?: number;
}

/** Same options under the product name. */
export type RosterOptions = AlbesaOptions;

export interface CreateAgentInput {
  name: string;
  dailySpendLimitUsdc: string;
  vendorAllowlist: string[];
}

export interface AgentHandle {
  id: string;
  name: string;
  address: string;
  walletId: string;
  policyId: string;
  dailySpendLimitUsdc: string;
  vendorAllowlist: string[];
  balanceUsdc: string;
  status: "active" | "suspended";
  createdAt: string;
}

export interface FundResult {
  transactionId: string;
  amountUsdc: string;
  balanceUsdc: string;
}

export interface PayInput {
  vendorId: string;
  amountUsdc: string;
  memo?: string;
}

export interface Payment {
  id: string;
  status: "settled";
  agentId: string;
  vendorId: string;
  amountUsdc: string;
  feeUsdc: string;
  toAddress: string;
  balanceUsdc: string;
  createdAt: string;
}

export interface Balance {
  agentId: string;
  walletId: string;
  address: string;
  asset: "USDC";
  chain: "mock" | "base-sepolia" | "base-sepolia-sim" | "solana-devnet-sim";
  balanceUsdc: string;
}

export interface TreasuryBalance {
  walletId: string;
  address: string;
  asset: "USDC";
  chain: Balance["chain"];
  balanceUsdc: string;
}

export interface TransactionRecord {
  id: string;
  type: "sandbox_grant" | "fund" | "payment" | "escrow_lock" | "escrow_release" | "escrow_refund";
  status: "settled" | "rejected";
  amountUsdc: string;
  feeUsdc: string;
  vendorId: string | null;
  rejectionReason: string | null;
  escrowId?: string;
  createdAt: string;
}

export interface RecordReputationEventInput {
  outcome: "success" | "failure";
  latencyMs: number;
  volumeUsdc: string;
  error?: boolean;
  hallucination?: boolean;
  sourceRef?: string | null;
}

export interface ReputationPassport {
  agentId: string;
  score: string;
  metrics: {
    eventCount: number;
    successCount: number;
    failureCount: number;
    volumeSettledUsdc: string;
    avgLatencyMs: string;
    successRate: string;
    errorIndex: string;
  };
  updatedAt: string | null;
}

export interface EscrowCreateInput {
  buyerAgentId: string;
  sellerAgentId: string;
  amountUsdc: string;
  schema: unknown;
  memo?: string;
}

export interface EscrowHandle {
  id: string;
  status: "held" | "released" | "refunded";
  buyerAgentId: string;
  sellerAgentId: string;
  amountUsdc: string;
  takeRateUsdc: string;
  sellerNetUsdc: string;
  holdAddress: string;
  validationErrors: string[] | null;
  result: unknown;
  buyerBalanceUsdc: string;
  sellerBalanceUsdc: string;
}

export interface RegistryManifest {
  mcp: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  openapi: {
    openapi: "3.0.3";
    operationId: string;
    method: "post";
    path: string;
    requestSchema: Record<string, unknown>;
    responseSchema: Record<string, unknown>;
  };
}

export interface RegistryListing {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  pricing: { model: "per_call" | "per_1k_tokens" | "free"; amountUsdc: string };
  latency: { p95Ms: number; p50Ms: number | null };
  tags: string[];
  status: "active" | "paused";
  /** MCP tool and OpenAPI operation. Null when the publisher omitted a manifest. */
  manifest: RegistryManifest | null;
  /** Seller agent bound to this listing, or null when the publisher did not set one. */
  agentId: string | null;
  /** "service" (default) or a data product: "dataset", "feed", or "lookup". */
  kind?: ListingKind;
  /** Data product details (sources, license, cadence, columns). Only on data listings. */
  data?: DataProductListingInfo;
  createdAt: string;
  updatedAt: string;
}

export type ListingKind = "service" | "dataset" | "feed" | "lookup";

export interface DataSourceAttribution {
  name: string;
  url: string;
  license: string;
  licenseUrl?: string;
  attribution?: string;
}

export interface DataProductListingInfo {
  slug: string;
  sources: DataSourceAttribution[];
  refreshCadence: string;
  refreshIntervalS: number;
  formats: ("json" | "csv")[];
  delivery: "signed_url" | "inline";
  columns: { name: string; type: string; description?: string }[];
}

export interface NeedInput {
  /** What you need, in plain language (any language). */
  need: string;
  /** Max price per call in USDC, e.g. "0.05". */
  budgetUsdc?: string;
  /** Restrict to kinds. "data" means any data product. */
  kinds?: (ListingKind | "data")[];
  limit?: number;
  /** Buy the top match in the same call. */
  buy?: boolean;
  /** Input for the bought listing. Defaults to the listing's example. */
  input?: Record<string, unknown>;
}

export interface NeedMatch {
  listingId: string;
  name: string;
  kind: ListingKind;
  summary: string;
  priceUsdc: string;
  relevance: number;
  score: number;
  seller: string | null;
  freshness: { lastRefreshedAt: string | null; refreshCadence: string | null; status: string; rowCount: number | null } | null;
  source: { name: string; license: string; url: string } | null;
  sample: Record<string, unknown>[];
  inputExample: Record<string, unknown>;
  p95Ms: number;
  buy: { method: "POST"; path: "/v1/need/buy"; body: { listingId: string; input: Record<string, unknown> } };
}

export interface BuyInput {
  listingId: string;
  input?: Record<string, unknown>;
  /** Pay from this agent. Omit to use (and top up) the account's "Roster buyer" agent. */
  buyerAgentId?: string;
}

export interface BuyResult {
  job: JobHandle;
  status: JobHandle["status"];
  delivered: boolean;
  /** Delivered payload. Datasets carry signed `jsonUrl`/`csvUrl` links valid for one hour. */
  result: unknown;
  receipt: {
    listingId: string;
    listingName: string;
    amountUsdc: string;
    takeRateUsdc: string;
    sellerNetUsdc: string;
    escrowId: string;
    buyerAgentId: string;
    buyerBalanceUsdc: string;
    settledAt: string | null;
  };
}

export interface NeedResult {
  need: string;
  budgetUsdc: string | null;
  matched: boolean;
  matches: NeedMatch[];
  /** Present when nothing matched well. The need was logged as demand. */
  unmet?: { logged: boolean; message: string };
  weak?: boolean;
  bought?: BuyResult;
}

export interface DataProduct {
  slug: string;
  name: string;
  kind: Exclude<ListingKind, "service">;
  description: string;
  priceUsdc: string;
  refreshCadence: string;
  refreshIntervalS: number;
  live: boolean;
  status: string;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  rowCount: number;
  bytes: number;
  sha256: string | null;
  lastError: string | null;
  columns: { name: string; type: string; description?: string }[];
  sample: Record<string, unknown>[];
  sources: DataSourceAttribution[];
  example: unknown;
  formats: string[];
  delivery: "signed_url" | "inline";
  listingId: string | null;
}

export interface RegisterCapabilityInput {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  pricing: { model: "per_call" | "per_1k_tokens" | "free"; amountUsdc: string };
  latency: { p95Ms: number; p50Ms?: number };
  tags?: string[];
  version?: string;
  status?: "active" | "paused";
  agentId?: string | null;
  manifest?: RegistryManifest | null;
}

export interface UpdateCapabilityInput {
  name?: string;
  description?: string;
  version?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  pricing?: { model: "per_call" | "per_1k_tokens" | "free"; amountUsdc: string };
  latency?: { p95Ms: number; p50Ms?: number | null };
  tags?: string[];
  status?: "active" | "paused";
  agentId?: string | null;
  manifest?: RegistryManifest | null;
}

export interface RegistrySearchQuery {
  q?: string;
  tags?: string[];
  maxPriceUsdc?: string;
  maxP95Ms?: number;
  limit?: number;
  /** Passport floor from 0 to 100. Also opts into blended ranking. */
  minScore?: number;
  /** Blend passport scores into the rank. Missing passports stay neutral (50). */
  withReputation?: boolean;
  /** Rank by stored semantic vectors (cosine). Omit to keep keyword search. */
  semantic?: boolean;
  /** Only these listing kinds, e.g. ["dataset", "lookup"]. */
  kinds?: ListingKind[];
}

export interface RegistrySearchHit {
  listing: RegistryListing;
  score: number;
  relevance: number;
  priceHint: number;
  latencyHint: number;
  /** Set when the query opted into reputation ranking. 50 means neutral. */
  reputationScore?: number;
}

export interface CreateJobInput {
  buyerAgentId: string;
  query: string;
  amountUsdc: string;
  schema: unknown;
  tags?: string[];
  maxP95Ms?: number;
  memo?: string;
  /** Buyer payload for a first-party sandbox fixture. Omit it for the schema-valid sample. */
  input?: unknown;
}

export interface JobPassportChange {
  agentId: string;
  scoreBefore: string;
  scoreAfter: string;
}

export interface JobHandle {
  id: string;
  status: "held" | "released" | "refunded" | "timed_out";
  /** Listing p95 captured when the job was locked. Null on jobs written before SLA deadlines. */
  slaMs: number | null;
  /** ISO timestamp when a missing delivery refunds the buyer. Null when the job cannot time out. */
  deadlineAt: string | null;
  organizationId: string;
  sellerOrganizationId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  listingId: string;
  listingName: string;
  query: string;
  amountUsdc: string;
  escrowId: string;
  rankScore: number;
  takeRateUsdc: string;
  sellerNetUsdc: string;
  holdAddress: string;
  result: unknown;
  validationErrors: string[] | null;
  latencyMs: number | null;
  buyerBalanceUsdc: string;
  sellerBalanceUsdc: string;
  passport: JobPassportChange | null;
  createdAt: string;
  settledAt: string | null;
}

export interface ListingSellerBinding {
  listingId: string;
  organizationId: string;
  sellerAgentId: string;
  createdAt: string;
  /** True when Roster delivers for the seller (fleet, data products, imported listings): no seller submit needed. */
  autofill: boolean;
}

export class AlbesaError extends Error {
  readonly status: number;
  readonly code: string;
  /** X-Request-Id from the API, to quote in a bug report. */
  readonly requestId: string | null;
  /** Seconds from Retry-After on a 429. */
  readonly retryAfterS: number | null;

  constructor(status: number, code: string, message: string, requestId: string | null = null, retryAfterS: number | null = null) {
    super(message);
    this.name = "AlbesaError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterS = retryAfterS;
  }
}

/** Same error under the product name. `instanceof RosterError` and `instanceof AlbesaError` both hold. */
export const RosterError = AlbesaError;
export type RosterError = AlbesaError;

interface ApiAgentResponse {
  agent: {
    id: string;
    name: string;
    walletId: string;
    policyId: string;
    status: "active" | "suspended";
    createdAt: string;
  };
  wallet: { id: string; address: string };
  policy: { id: string; dailySpendLimitUsdc: string; vendorAllowlist: string[] };
  balanceUsdc: string;
}

interface ApiFundResponse {
  transaction: { id: string; amountUsdc: string };
  balanceUsdc: string;
}

interface ApiEscrowResponse {
  escrow: {
    id: string;
    status: "held" | "released" | "refunded";
    buyerAgentId: string;
    sellerAgentId: string;
    amountUsdc: string;
    takeRateUsdc: string;
    sellerNetUsdc: string;
    holdAddress: string;
    validationErrors: string[] | null;
    result: unknown;
  };
  buyerBalanceUsdc: string;
  sellerBalanceUsdc: string;
}

interface ApiPayResponse {
  transaction: {
    id: string;
    status: "settled";
    agentId: string;
    vendorId: string;
    amountUsdc: string;
    feeUsdc: string;
    toAddress: string;
    createdAt: string;
  };
  balanceUsdc: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

interface RequestOptions {
  /** Send an Idempotency-Key. `true` generates one per logical call. */
  idempotencyKey?: string | true;
}

function newIdempotencyKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return `sdk_${cryptoApi.randomUUID()}`;
  return `sdk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Albesa {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  readonly agents: {
    create: (input: CreateAgentInput) => Promise<AgentHandle>;
    fund: (agentId: string, amountUsdc: string) => Promise<FundResult>;
    pay: (agentId: string, input: PayInput) => Promise<Payment>;
    balance: (agentId: string) => Promise<Balance>;
    transactions: (agentId: string) => Promise<TransactionRecord[]>;
  };

  readonly reputation: {
    recordEvent: (agentId: string, input: RecordReputationEventInput) => Promise<ReputationPassport>;
    passport: (agentId: string) => Promise<ReputationPassport>;
  };

  readonly escrows: {
    create: (input: EscrowCreateInput) => Promise<EscrowHandle>;
    submit: (escrowId: string, result: unknown) => Promise<EscrowHandle>;
    get: (escrowId: string) => Promise<EscrowHandle>;
  };

  readonly registry: {
    register: (input: RegisterCapabilityInput) => Promise<RegistryListing>;
    update: (id: string, input: UpdateCapabilityInput) => Promise<RegistryListing>;
    get: (id: string) => Promise<RegistryListing>;
    list: () => Promise<RegistryListing[]>;
    seed: () => Promise<RegistryListing[]>;
    search: (query?: RegistrySearchQuery) => Promise<RegistrySearchHit[]>;
  };

  readonly jobs: {
    bindSeller: (listingId: string, sellerAgentId: string) => Promise<ListingSellerBinding>;
    create: (input: CreateJobInput) => Promise<JobHandle>;
    list: () => Promise<JobHandle[]>;
    get: (jobId: string) => Promise<JobHandle>;
    submit: (jobId: string, result: unknown, options?: { latencyMs?: number }) => Promise<JobHandle>;
    /** Refund held jobs for this account whose listing SLA has passed. */
    expire: () => Promise<JobHandle[]>;
  };

  readonly treasury: {
    get: () => Promise<TreasuryBalance>;
  };

  readonly data: {
    /** Every Roster Data product with freshness, row count, sample, and license. */
    products: () => Promise<DataProduct[]>;
    product: (slug: string) => Promise<DataProduct>;
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AlbesaOptions) {
    if (!options.apiKey.trim()) throw new Error("Albesa apiKey is required.");
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS);
    this.agents = {
      create: (input) => this.createAgent(input),
      fund: (agentId, amountUsdc) => this.fundAgent(agentId, amountUsdc),
      pay: (agentId, input) => this.payAgent(agentId, input),
      balance: (agentId) => this.getBalance(agentId),
      transactions: (agentId) => this.listTransactions(agentId),
    };
    this.reputation = {
      recordEvent: (agentId, input) => this.recordReputationEvent(agentId, input),
      passport: (agentId) => this.getPassport(agentId),
    };
    this.escrows = {
      create: (input) => this.createEscrow(input),
      submit: (escrowId, result) => this.submitEscrow(escrowId, result),
      get: (escrowId) => this.getEscrow(escrowId),
    };
    this.registry = {
      register: (input) => this.registerCapability(input),
      update: (id, input) => this.updateCapability(id, input),
      get: (id) => this.getCapability(id),
      list: () => this.listCapabilities(),
      seed: () => this.seedCapabilities(),
      search: (query) => this.searchCapabilities(query),
    };
    this.jobs = {
      bindSeller: (listingId, sellerAgentId) => this.bindJobSeller(listingId, sellerAgentId),
      create: (input) => this.createJob(input),
      list: () => this.listJobs(),
      get: (jobId) => this.getJob(jobId),
      submit: (jobId, result, options) => this.submitJob(jobId, result, options),
      expire: () => this.expireJobs(),
    };
    this.treasury = {
      get: () => this.getTreasury(),
    };
    this.data = {
      products: async () => (await this.request<{ products: DataProduct[] }>("GET", "/v1/data/products")).products,
      product: async (slug) =>
        (await this.request<{ product: DataProduct }>("GET", `/v1/data/products/${encodeURIComponent(slug)}`)).product,
    };
  }

  /**
   * Say what you need in plain language and get ranked listings (data products and services)
   * with price, freshness, and a ready buy body. Pass `buy: true` to buy the top match in one call.
   * Needs nothing matches well are logged as demand.
   */
  async need(input: NeedInput | string): Promise<NeedResult> {
    const body = typeof input === "string" ? { need: input } : input;
    return this.request<NeedResult>("POST", "/v1/need", body, body.buy ? { idempotencyKey: true } : {});
  }

  /** Buy one listing through escrow and wait briefly for delivery. You pay only when the result validates. */
  async buy(input: BuyInput): Promise<BuyResult> {
    return this.request<BuyResult>("POST", "/v1/need/buy", input, { idempotencyKey: true });
  }

  private async createAgent(input: CreateAgentInput): Promise<AgentHandle> {
    const raw = await this.request<ApiAgentResponse>("POST", "/v1/agents", input);
    return {
      id: raw.agent.id,
      name: raw.agent.name,
      address: raw.wallet.address,
      walletId: raw.wallet.id,
      policyId: raw.policy.id,
      dailySpendLimitUsdc: raw.policy.dailySpendLimitUsdc,
      vendorAllowlist: raw.policy.vendorAllowlist,
      balanceUsdc: raw.balanceUsdc,
      status: raw.agent.status,
      createdAt: raw.agent.createdAt,
    };
  }

  private async fundAgent(agentId: string, amountUsdc: string): Promise<FundResult> {
    const raw = await this.request<ApiFundResponse>("POST", `/v1/agents/${agentId}/fund`, { amountUsdc }, { idempotencyKey: true });
    return {
      transactionId: raw.transaction.id,
      amountUsdc: raw.transaction.amountUsdc,
      balanceUsdc: raw.balanceUsdc,
    };
  }

  private async payAgent(agentId: string, input: PayInput): Promise<Payment> {
    const body = input.memo === undefined ? { vendorId: input.vendorId, amountUsdc: input.amountUsdc } : input;
    const raw = await this.request<ApiPayResponse>("POST", `/v1/agents/${agentId}/payments`, body, { idempotencyKey: true });
    return {
      id: raw.transaction.id,
      status: "settled",
      agentId: raw.transaction.agentId,
      vendorId: raw.transaction.vendorId,
      amountUsdc: raw.transaction.amountUsdc,
      feeUsdc: raw.transaction.feeUsdc,
      toAddress: raw.transaction.toAddress,
      balanceUsdc: raw.balanceUsdc,
      createdAt: raw.transaction.createdAt,
    };
  }

  private async createEscrow(input: EscrowCreateInput): Promise<EscrowHandle> {
    const body = input.memo === undefined
      ? {
          buyerAgentId: input.buyerAgentId,
          sellerAgentId: input.sellerAgentId,
          amountUsdc: input.amountUsdc,
          schema: input.schema,
        }
      : input;
    const raw = await this.request<ApiEscrowResponse>("POST", "/v1/escrows", body, { idempotencyKey: true });
    return toEscrowHandle(raw);
  }

  private async submitEscrow(escrowId: string, result: unknown): Promise<EscrowHandle> {
    const raw = await this.request<ApiEscrowResponse>("POST", `/v1/escrows/${escrowId}/result`, { result }, { idempotencyKey: true });
    return toEscrowHandle(raw);
  }

  private async getEscrow(escrowId: string): Promise<EscrowHandle> {
    const raw = await this.request<ApiEscrowResponse>("GET", `/v1/escrows/${escrowId}`);
    return toEscrowHandle(raw);
  }

  private getBalance(agentId: string): Promise<Balance> {
    return this.request<Balance>("GET", `/v1/agents/${agentId}/balance`);
  }

  private async getTreasury(): Promise<TreasuryBalance> {
    const raw = await this.request<{
      wallet: { id: string; address: string; asset: "USDC"; chain: Balance["chain"] };
      balanceUsdc: string;
    }>("GET", "/v1/treasury");
    return {
      walletId: raw.wallet.id,
      address: raw.wallet.address,
      asset: "USDC",
      chain: raw.wallet.chain,
      balanceUsdc: raw.balanceUsdc,
    };
  }

  private async recordReputationEvent(agentId: string, input: RecordReputationEventInput): Promise<ReputationPassport> {
    const raw = await this.request<{ passport: ReputationPassport }>(
      "POST",
      `/v1/agents/${agentId}/reputation/events`,
      input,
    );
    return raw.passport;
  }

  private getPassport(agentId: string): Promise<ReputationPassport> {
    return this.request<{ passport: ReputationPassport }>("GET", `/v1/agents/${agentId}/passport`).then(
      (raw) => raw.passport,
    );
  }

  private async listTransactions(agentId: string): Promise<TransactionRecord[]> {
    const raw = await this.request<{ transactions: TransactionRecord[] }>(
      "GET",
      `/v1/agents/${agentId}/transactions`,
    );
    return raw.transactions;
  }

  private async registerCapability(input: RegisterCapabilityInput): Promise<RegistryListing> {
    const raw = await this.request<{ listing: RegistryListing }>("POST", "/v1/registry/listings", input);
    return raw.listing;
  }

  private async updateCapability(id: string, input: UpdateCapabilityInput): Promise<RegistryListing> {
    const raw = await this.request<{ listing: RegistryListing }>("PUT", `/v1/registry/listings/${id}`, input);
    return raw.listing;
  }

  private async getCapability(id: string): Promise<RegistryListing> {
    const raw = await this.request<{ listing: RegistryListing }>("GET", `/v1/registry/listings/${id}`);
    return raw.listing;
  }

  private async listCapabilities(): Promise<RegistryListing[]> {
    const raw = await this.request<{ listings: RegistryListing[] }>("GET", "/v1/registry/listings");
    return raw.listings;
  }

  private async seedCapabilities(): Promise<RegistryListing[]> {
    const raw = await this.request<{ listings: RegistryListing[] }>("POST", "/v1/registry/seed");
    return raw.listings;
  }

  private async bindJobSeller(listingId: string, sellerAgentId: string): Promise<ListingSellerBinding> {
    const raw = await this.request<{ binding: ListingSellerBinding }>(
      "PUT",
      `/v1/jobs/listings/${listingId}/seller`,
      { sellerAgentId },
    );
    return raw.binding;
  }

  private async createJob(input: CreateJobInput): Promise<JobHandle> {
    const body: Record<string, unknown> = {
      buyerAgentId: input.buyerAgentId,
      query: input.query,
      amountUsdc: input.amountUsdc,
      schema: input.schema,
    };
    if (input.tags !== undefined) body.tags = input.tags;
    if (input.maxP95Ms !== undefined) body.maxP95Ms = input.maxP95Ms;
    if (input.memo !== undefined) body.memo = input.memo;
    if (input.input !== undefined) body.input = input.input;
    const raw = await this.request<{ job: JobHandle }>("POST", "/v1/jobs", body, { idempotencyKey: true });
    return raw.job;
  }

  private getJob(jobId: string): Promise<JobHandle> {
    return this.request<{ job: JobHandle }>("GET", `/v1/jobs/${jobId}`).then((raw) => raw.job);
  }

  private async listJobs(): Promise<JobHandle[]> {
    const raw = await this.request<{ jobs: JobHandle[] }>("GET", "/v1/jobs");
    return raw.jobs;
  }

  private async expireJobs(): Promise<JobHandle[]> {
    const raw = await this.request<{ jobs: JobHandle[] }>("POST", "/v1/jobs/expire");
    return raw.jobs;
  }

  private async submitJob(
    jobId: string,
    result: unknown,
    options?: { latencyMs?: number },
  ): Promise<JobHandle> {
    const body = options?.latencyMs === undefined ? { result } : { result, latencyMs: options.latencyMs };
    const raw = await this.request<{ job: JobHandle }>("POST", `/v1/jobs/${jobId}/result`, body, { idempotencyKey: true });
    return raw.job;
  }

  private async searchCapabilities(query: RegistrySearchQuery = {}): Promise<RegistrySearchHit[]> {
    const params = new URLSearchParams();
    if (query.q !== undefined) params.set("q", query.q);
    if (query.tags !== undefined && query.tags.length > 0) params.set("tags", query.tags.join(","));
    if (query.maxPriceUsdc !== undefined) params.set("maxPriceUsdc", query.maxPriceUsdc);
    if (query.maxP95Ms !== undefined) params.set("maxP95Ms", query.maxP95Ms.toString());
    if (query.limit !== undefined) params.set("limit", query.limit.toString());
    if (query.minScore !== undefined) params.set("minScore", query.minScore.toString());
    if (query.withReputation) params.set("withReputation", "1");
    if (query.semantic) params.set("semantic", "1");
    if (query.kinds !== undefined && query.kinds.length > 0) params.set("kind", query.kinds.join(","));
    const search = params.toString();
    const raw = await this.request<{ hits: RegistrySearchHit[] }>(
      "GET",
      `/v1/registry/search${search.length > 0 ? `?${search}` : ""}`,
    );
    return raw.hits;
  }

  private async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey === true ? newIdempotencyKey() : options.idempotencyKey;
    }
    const retryable = method === "GET" || headers["idempotency-key"] !== undefined;
    for (let attempt = 0; ; attempt += 1) {
      const canRetry = retryable && attempt < this.maxRetries;
      let response: Response;
      const controller = this.timeoutMs > 0 ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl}${path}`,
          controller ? { ...init, signal: controller.signal } : init,
        );
      } catch (error) {
        if (timer) clearTimeout(timer);
        if (canRetry) {
          await sleep(this.backoff(attempt, null));
          continue;
        }
        const timedOut = controller?.signal.aborted === true;
        throw new AlbesaError(
          0,
          timedOut ? "timeout" : "network_error",
          timedOut
            ? `Roster API did not answer within ${this.timeoutMs.toString()} ms.`
            : `Roster API request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (timer) clearTimeout(timer);
      if (!response.ok && RETRY_STATUSES.has(response.status) && canRetry) {
        await sleep(this.backoff(attempt, readRetryAfter(response)));
        continue;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = readError(payload);
        throw new AlbesaError(
          response.status,
          error.code,
          error.message,
          response.headers?.get?.("x-request-id") ?? null,
          readRetryAfter(response),
        );
      }
      return payload as T;
    }
  }

  private backoff(attempt: number, retryAfterS: number | null): number {
    if (retryAfterS !== null) return Math.min(retryAfterS, 10) * 1000;
    const base = this.retryBaseDelayMs * 2 ** attempt;
    return base + Math.floor(Math.random() * this.retryBaseDelayMs);
  }

}

export async function createSandboxAccount(input: {
  email: string;
  password: string;
  name?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Promise<{ apiKey: string; organizationId: string; userId: string; client: Albesa }> {
  const body: { email: string; password: string; name?: string } = {
    email: input.email,
    password: input.password,
  };
  if (input.name !== undefined) body.name = input.name;
  const payload = await publicRequest(input, "/v1/accounts", body);
  return sessionFrom(payload, input);
}

export async function loginSandboxAccount(input: {
  email: string;
  password: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Promise<{ apiKey: string; organizationId: string; userId: string; client: Albesa }> {
  const payload = await publicRequest(input, "/v1/accounts/login", {
    email: input.email,
    password: input.password,
  });
  return sessionFrom(payload, input);
}

async function publicRequest(
  input: { baseUrl?: string; fetch?: typeof fetch },
  path: string,
  body: unknown,
): Promise<unknown> {
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = readError(payload);
    throw new AlbesaError(response.status, error.code, error.message);
  }
  return payload;
}

function sessionFrom(
  payload: unknown,
  input: { baseUrl?: string; fetch?: typeof fetch },
): { apiKey: string; organizationId: string; userId: string; client: Albesa } {
  if (!isRecord(payload) || typeof payload.apiKey !== "string") {
    throw new AlbesaError(200, "invalid_response", "Account response did not include an API key.");
  }
  const user = payload.user;
  const userId = isRecord(user) && typeof user.id === "string" ? user.id : "";
  const organizationId =
    isRecord(user) && typeof user.organizationId === "string" ? user.organizationId : "";
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = input.fetch ?? globalThis.fetch;
  return {
    apiKey: payload.apiKey,
    organizationId,
    userId,
    client: new Albesa({ apiKey: payload.apiKey, baseUrl, fetch: fetchImpl }),
  };
}

export async function createSandboxOrganization(input: {
  name: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Promise<{ apiKey: string; organizationId: string; client: Albesa }> {
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${baseUrl}/v1/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: input.name }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = readError(payload);
    throw new AlbesaError(response.status, error.code, error.message);
  }
  if (!isRecord(payload) || typeof payload.apiKey !== "string") {
    throw new AlbesaError(response.status, "invalid_response", "Organization response did not include an API key.");
  }
  const organization = payload.organization;
  const organizationId =
    isRecord(organization) && typeof organization.id === "string" ? organization.id : "";
  return {
    apiKey: payload.apiKey,
    organizationId,
    client: new Albesa({ apiKey: payload.apiKey, baseUrl, fetch: fetchImpl }),
  };
}

function toEscrowHandle(raw: ApiEscrowResponse): EscrowHandle {
  return {
    id: raw.escrow.id,
    status: raw.escrow.status,
    buyerAgentId: raw.escrow.buyerAgentId,
    sellerAgentId: raw.escrow.sellerAgentId,
    amountUsdc: raw.escrow.amountUsdc,
    takeRateUsdc: raw.escrow.takeRateUsdc,
    sellerNetUsdc: raw.escrow.sellerNetUsdc,
    holdAddress: raw.escrow.holdAddress,
    validationErrors: raw.escrow.validationErrors,
    result: raw.escrow.result,
    buyerBalanceUsdc: raw.buyerBalanceUsdc,
    sellerBalanceUsdc: raw.sellerBalanceUsdc,
  };
}

function readRetryAfter(response: Response): number | null {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function readError(payload: unknown): { code: string; message: string } {
  if (isRecord(payload) && isRecord(payload.error)) {
    const code = typeof payload.error.code === "string" ? payload.error.code : "request_failed";
    const message = typeof payload.error.message === "string" ? payload.error.message : "Request failed.";
    return { code, message };
  }
  return { code: "request_failed", message: "Request failed." };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The client under the product name. `new Roster({ apiKey })` is the same as `new Albesa({ apiKey })`. */
export const Roster = Albesa;
export type Roster = Albesa;
