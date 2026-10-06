import { ROSTER_BROWSER_API_BASE } from "./api-base";
import { readBuyResponse, readDataProduct, readNeedResponse, type BuyResponseView, type DataProductView, type ListingKind, type NeedResponseView } from "./need";
import type { RosterFeeQuote } from "./roster-fee";

export class RosterApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RosterApiError";
    this.status = status;
    this.code = code;
  }
}

export interface SignupResult {
  apiKey: string;
  email: string;
  userId: string;
  organizationId: string;
  displayName: string;
  treasuryBalanceUsdc: string;
}

export interface AccountSnapshot {
  email: string;
  displayName: string;
  organizationId: string;
  balanceUsdc: string;
  address: string;
  claimable: boolean;
  anonymous: boolean;
}

export interface TreasurySnapshot {
  balanceUsdc: string;
  address: string;
}

export interface ConsoleAgent {
  id: string;
  name: string;
  status: string;
  address: string;
  balanceUsdc: string;
  dailySpendLimitUsdc: string;
  createdAt: string;
}

export interface MarketplaceListing {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  pricing: { model: string; amountUsdc: string };
  latency: { p95Ms: number };
  tags: string[];
  agentId: string | null;
  inputSchema: unknown;
  outputSchema: unknown;
  kind: ListingKind;
  /** Refresh cadence and first source for data products. */
  data: { slug: string; refreshCadence: string; source: string; license: string } | null;
}

export interface MarketplaceHit {
  listing: MarketplaceListing;
  score: number;
  reputationScore: number | null;
}

export interface ConsoleJob {
  id: string;
  status: string;
  listingId: string;
  listingName: string;
  query: string;
  amountUsdc: string;
  takeRateUsdc: string;
  sellerNetUsdc: string;
  buyerBalanceUsdc: string;
  sellerBalanceUsdc: string;
  escrowId: string;
  validationErrors: string[] | null;
  buyerAgentId: string;
  sellerAgentId: string;
  createdAt: string;
  settledAt: string | null;
  holdAddress?: string | null;
  vaultAddress?: string | null;
  vaultExplorerUrl?: string | null;
  programId?: string | null;
  programExplorerUrl?: string | null;
  escrowMode?: string | null;
  lockExplorerUrl?: string | null;
  settlementExplorerUrl?: string | null;
  chain?: string | null;
}

export interface SolanaLockReceipt {
  cluster: string;
  broadcast: boolean;
  escrowId: string;
  jobId: string | null;
  feePayer: string;
  buyerPubkey: string;
  amountUsdc: string;
  quote: RosterFeeQuote;
  transaction: string;
}

export interface SolanaSettleReceipt {
  cluster: string;
  broadcast: boolean;
  broadcastNote: string | null;
  submitted: boolean;
  signature: string | null;
  escrowId: string;
  quote: RosterFeeQuote;
  treasuryUsdcAta: string;
  transaction: string;
}

export interface RegistrySearchInput {
  q: string;
  semantic: boolean;
  withReputation: boolean;
}

export function registrySearchPath(input: RegistrySearchInput): string {
  const params = new URLSearchParams();
  const q = input.q.trim();
  if (q) params.set("q", q);
  if (input.semantic) params.set("semantic", "1");
  if (input.withReputation) params.set("withReputation", "1");
  const search = params.toString();
  return `/v1/registry/search${search ? `?${search}` : ""}`;
}

export function formatPassport(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  return score.toFixed(1);
}

export interface RosterClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export function createRosterClient(options: RosterClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? ROSTER_BROWSER_API_BASE).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
    bearer?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
    } else if (auth) {
      const apiKey = options.apiKey?.trim() ?? "";
      if (!apiKey) throw new RosterApiError(401, "unauthorized", "Sign in to use the sandbox console.");
      headers.authorization = `Bearer ${apiKey}`;
    }
    const init: RequestInit = { method, headers, cache: "no-store" };
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      // The browser sets the multipart boundary.
      init.body = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init);
    } catch {
      throw new RosterApiError(502, "unavailable", "The sandbox API could not be reached from this site.");
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = readError(payload, response.status);
      throw new RosterApiError(response.status, error.code, error.message);
    }
    return payload as T;
  }

  return {
    signup(input: { email: string; password: string; name?: string }): Promise<SignupResult> {
      const body: { email: string; password: string; name?: string } = {
        email: input.email.trim(),
        password: input.password,
      };
      const name = input.name?.trim();
      if (name) body.name = name;
      return request<unknown>("POST", "/v1/accounts", body, false).then(readSignup);
    },
    login(input: { email: string; password: string }): Promise<SignupResult> {
      return request<unknown>(
        "POST",
        "/v1/accounts/login",
        { email: input.email.trim(), password: input.password },
        false,
      ).then(readSignup);
    },
    adoptSession(accessToken: string): Promise<SignupResult> {
      return request<unknown>("POST", "/v1/accounts/session", undefined, false, accessToken).then(readSignup);
    },
    /** Instant sandbox org with no email. Key shown once. */
    anonymous(): Promise<SignupResult> {
      return request<unknown>("POST", "/v1/accounts/anonymous", {}, false).then(readAnonymousSignup);
    },
    account(): Promise<AccountSnapshot> {
      return request<unknown>("GET", "/v1/account").then(readAccount);
    },
    claim(input: { email: string; password: string; name?: string }): Promise<SignupResult> {
      const body: Record<string, string> = { email: input.email.trim(), password: input.password };
      if (input.name?.trim()) body.name = input.name.trim();
      return request<unknown>("POST", "/v1/account/claim", body).then(readSignup);
    },
    rotateKey(): Promise<{ apiKey: string }> {
      return request<unknown>("POST", "/v1/account/api-key/rotate").then((payload) => {
        if (!isRecord(payload) || typeof payload.apiKey !== "string" || !payload.apiKey.trim()) {
          throw invalidResponse("Rotate response did not include an API key.");
        }
        return { apiKey: payload.apiKey.trim() };
      });
    },
    treasury(): Promise<TreasurySnapshot> {
      return request<unknown>("GET", "/v1/treasury").then(readTreasury);
    },
    listAgents(): Promise<ConsoleAgent[]> {
      return request<unknown>("GET", "/v1/agents").then(readAgentList);
    },
    createAgent(input: { name: string; dailySpendLimitUsdc: string }): Promise<ConsoleAgent> {
      return request<unknown>("POST", "/v1/agents", {
        name: input.name.trim(),
        dailySpendLimitUsdc: input.dailySpendLimitUsdc.trim(),
        vendorAllowlist: [],
      }).then(readAgent);
    },
    fundAgent(agentId: string, amountUsdc: string): Promise<{ balanceUsdc: string }> {
      return request<unknown>("POST", `/v1/agents/${encodeURIComponent(agentId)}/fund`, {
        amountUsdc: amountUsdc.trim(),
      }).then(readFund);
    },
    search(input: RegistrySearchInput): Promise<MarketplaceHit[]> {
      return request<unknown>("GET", registrySearchPath(input)).then(readHits);
    },
    listing(id: string): Promise<MarketplaceListing> {
      return request<unknown>("GET", `/v1/registry/listings/${encodeURIComponent(id)}`).then((payload) => {
        if (!isRecord(payload)) throw invalidResponse("Listing response was not an object.");
        return readListing(payload.listing);
      });
    },
    seed(): Promise<MarketplaceListing[]> {
      return request<unknown>("POST", "/v1/registry/seed").then(readListings);
    },
    bindSeller(listingId: string, sellerAgentId: string): Promise<void> {
      return request<unknown>("PUT", `/v1/jobs/listings/${encodeURIComponent(listingId)}/seller`, {
        sellerAgentId,
      }).then(() => undefined);
    },
    createJob(input: {
      buyerAgentId: string;
      query: string;
      amountUsdc: string;
      schema: unknown;
      tags: string[];
      memo: string | null;
      listingId?: string | null;
      input?: unknown;
    }): Promise<ConsoleJob> {
      const body: Record<string, unknown> = {
        buyerAgentId: input.buyerAgentId,
        query: input.query.trim(),
        amountUsdc: input.amountUsdc.trim(),
        schema: input.schema,
        tags: input.tags,
      };
      if (input.memo) body.memo = input.memo;
      if (input.listingId) body.listingId = input.listingId;
      if (input.input !== undefined) body.input = input.input;
      return request<unknown>("POST", "/v1/jobs", body).then(readJobPayload);
    },
    /** Plain-language need → ranked listings. Public; sends the key when the client has one. */
    need(input: { need: string; budgetUsdc?: string; kinds?: string[]; limit?: number }): Promise<NeedResponseView> {
      const apiKey = options.apiKey?.trim();
      return request<unknown>("POST", "/v1/need", input, false, apiKey || undefined).then(readNeedResponse);
    },
    buy(input: { listingId: string; input?: Record<string, unknown> }): Promise<BuyResponseView> {
      return request<unknown>("POST", "/v1/need/buy", input).then(readBuyResponse);
    },
    dataProducts(): Promise<DataProductView[]> {
      return request<unknown>("GET", "/v1/data/products", undefined, false).then((payload) => {
        if (!isRecord(payload) || !Array.isArray(payload.products)) throw invalidResponse("Data catalog response was incomplete.");
        return payload.products.map(readDataProduct).filter((product): product is DataProductView => product !== null);
      });
    },
    health(): Promise<RosterHealth> {
      return request<unknown>("GET", "/health", undefined, false).then(readHealth);
    },
    kyc(): Promise<KycSnapshot> {
      return request<unknown>("GET", "/v1/kyc").then(readKycPayload);
    },
    submitKyc(form: FormData): Promise<KycSnapshot> {
      return request<unknown>("POST", "/v1/kyc/submission", form).then(readKycPayload);
    },
    listJobs(): Promise<ConsoleJob[]> {
      return request<unknown>("GET", "/v1/jobs").then(readJobList);
    },
    revokeKey(): Promise<void> {
      return request<unknown>("DELETE", "/v1/account/api-key").then(() => undefined);
    },
    job(jobId: string): Promise<ConsoleJob> {
      return request<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`).then(readJobPayload);
    },
    submitResult(jobId: string, result: unknown): Promise<ConsoleJob> {
      return request<unknown>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/result`, { result }).then(readJobPayload);
    },
    prepareLock(input: {
      buyerPubkey: string;
      amountUsdc: string;
      escrowId?: string;
      jobId?: string;
    }): Promise<SolanaLockReceipt> {
      const body: Record<string, string> = {
        buyerPubkey: input.buyerPubkey,
        amountUsdc: input.amountUsdc.trim(),
      };
      if (input.escrowId) body.escrowId = input.escrowId;
      if (input.jobId) body.jobId = input.jobId;
      return request<unknown>("POST", "/v1/escrow/prepare-lock", body).then(readLock);
    },
    settleEscrow(input: {
      escrowId: string;
      buyerPubkey: string;
      providerPubkey: string;
      amountUsdc: string;
      jobId?: string;
      verified: true;
    }): Promise<SolanaSettleReceipt> {
      const body: Record<string, string | boolean> = {
        escrowId: input.escrowId,
        buyerPubkey: input.buyerPubkey,
        providerPubkey: input.providerPubkey,
        amountUsdc: input.amountUsdc.trim(),
        verified: true,
      };
      if (input.jobId) body.jobId = input.jobId;
      return request<unknown>("POST", "/v1/escrow/settle", body).then(readSettle);
    },
  };
}

export function rosterErrorMessage(error: unknown): string {
  if (error instanceof RosterApiError && error.code === "kyc_limit_exceeded") {
    return `${error.message} Raise the cap with Tier 1 verification at /console/kyc.`;
  }
  if (error instanceof RosterApiError && error.message.trim()) return error.message;
  return "The sandbox console could not complete that request.";
}

export function readError(payload: unknown, status: number): { code: string; message: string } {
  if (isRecord(payload) && isRecord(payload.error)) {
    const code = payload.error.code;
    const message = payload.error.message;
    if (typeof code === "string" && typeof message === "string" && message.trim()) {
      return { code, message };
    }
  }
  return { code: "request_failed", message: `Roster API returned ${status.toString()}.` };
}

function readSignup(payload: unknown): SignupResult {
  if (!isRecord(payload) || typeof payload.apiKey !== "string" || !payload.apiKey.trim()) {
    throw invalidResponse("The account response did not include an API key.");
  }
  const user = payload.user;
  if (
    !isRecord(user) ||
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    typeof user.organizationId !== "string" ||
    typeof user.displayName !== "string"
  ) {
    throw invalidResponse("The account response did not include the user.");
  }
  const treasury = payload.treasury;
  const balance = isRecord(treasury) && typeof treasury.balanceUsdc === "string" ? treasury.balanceUsdc : "";
  return {
    apiKey: payload.apiKey.trim(),
    email: user.email,
    userId: user.id,
    organizationId: user.organizationId,
    displayName: user.displayName,
    treasuryBalanceUsdc: balance,
  };
}

function readAnonymousSignup(payload: unknown): SignupResult {
  if (!isRecord(payload) || typeof payload.apiKey !== "string" || !payload.apiKey.trim()) {
    throw invalidResponse("The account response did not include an API key.");
  }
  const organization = payload.organization;
  if (!isRecord(organization) || typeof organization.id !== "string") {
    throw invalidResponse("The anonymous response did not include an organization.");
  }
  const treasury = payload.treasury;
  const balance = isRecord(treasury) && typeof treasury.balanceUsdc === "string" ? treasury.balanceUsdc : "";
  return {
    apiKey: payload.apiKey.trim(),
    email: "",
    userId: "",
    organizationId: organization.id,
    displayName: typeof organization.name === "string" ? organization.name : "Anonymous sandbox",
    treasuryBalanceUsdc: balance,
  };
}

function readAccount(payload: unknown): AccountSnapshot {
  if (!isRecord(payload) || !isRecord(payload.treasury) || !isRecord(payload.organization)) {
    throw invalidResponse("Account response was incomplete.");
  }
  const wallet = payload.treasury.wallet;
  const organizationId =
    typeof payload.organization.id === "string"
      ? payload.organization.id
      : isRecord(payload.user) && typeof payload.user.organizationId === "string"
        ? payload.user.organizationId
        : "";
  if (!organizationId) throw invalidResponse("Account response was incomplete.");
  const claimable = payload.claimable === true || payload.user === null;
  const user = payload.user;
  const email = isRecord(user) && typeof user.email === "string" ? user.email : "";
  const displayName =
    isRecord(user) && typeof user.displayName === "string"
      ? user.displayName
      : typeof payload.organization.name === "string"
        ? payload.organization.name
        : "Anonymous sandbox";
  return {
    email,
    displayName,
    organizationId,
    balanceUsdc: typeof payload.treasury.balanceUsdc === "string" ? payload.treasury.balanceUsdc : "",
    address: isRecord(wallet) && typeof wallet.address === "string" ? wallet.address : "",
    claimable,
    anonymous: payload.anonymous === true || claimable,
  };
}

function readTreasury(payload: unknown): TreasurySnapshot {
  if (!isRecord(payload) || typeof payload.balanceUsdc !== "string" || !isRecord(payload.wallet)) {
    throw invalidResponse("Treasury response was incomplete.");
  }
  return {
    balanceUsdc: payload.balanceUsdc,
    address: typeof payload.wallet.address === "string" ? payload.wallet.address : "",
  };
}

function readAgentList(payload: unknown): ConsoleAgent[] {
  if (!isRecord(payload) || !Array.isArray(payload.agents)) throw invalidResponse("Agent list was incomplete.");
  return payload.agents.map((entry) => readAgent(entry));
}

function readAgent(payload: unknown): ConsoleAgent {
  if (!isRecord(payload) || !isRecord(payload.agent) || !isRecord(payload.wallet) || !isRecord(payload.policy)) {
    throw invalidResponse("Agent response was incomplete.");
  }
  const agent = payload.agent;
  if (typeof agent.id !== "string" || typeof agent.name !== "string") {
    throw invalidResponse("Agent response was incomplete.");
  }
  return {
    id: agent.id,
    name: agent.name,
    status: typeof agent.status === "string" ? agent.status : "active",
    address: typeof payload.wallet.address === "string" ? payload.wallet.address : "",
    balanceUsdc: typeof payload.balanceUsdc === "string" ? payload.balanceUsdc : "",
    dailySpendLimitUsdc:
      typeof payload.policy.dailySpendLimitUsdc === "string" ? payload.policy.dailySpendLimitUsdc : "",
    createdAt: typeof agent.createdAt === "string" ? agent.createdAt : "",
  };
}

function readFund(payload: unknown): { balanceUsdc: string } {
  if (!isRecord(payload) || typeof payload.balanceUsdc !== "string") {
    throw invalidResponse("Fund response was incomplete.");
  }
  return { balanceUsdc: payload.balanceUsdc };
}

function readHits(payload: unknown): MarketplaceHit[] {
  if (!isRecord(payload) || !Array.isArray(payload.hits)) throw invalidResponse("Search response was incomplete.");
  return payload.hits.map((entry) => {
    if (!isRecord(entry) || typeof entry.score !== "number") throw invalidResponse("Search hit was incomplete.");
    return {
      listing: readListing(entry.listing),
      score: entry.score,
      reputationScore: typeof entry.reputationScore === "number" ? entry.reputationScore : null,
    };
  });
}

function readListings(payload: unknown): MarketplaceListing[] {
  if (!isRecord(payload) || !Array.isArray(payload.listings)) throw invalidResponse("Catalog response was incomplete.");
  return payload.listings.map((entry) => readListing(entry));
}

function readListing(payload: unknown): MarketplaceListing {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.name !== "string") {
    throw invalidResponse("Listing response was incomplete.");
  }
  const pricing = payload.pricing;
  const latency = payload.latency;
  return {
    id: payload.id,
    organizationId: typeof payload.organizationId === "string" ? payload.organizationId : "",
    name: payload.name,
    description: typeof payload.description === "string" ? payload.description : "",
    pricing: {
      model: isRecord(pricing) && typeof pricing.model === "string" ? pricing.model : "per_call",
      amountUsdc: isRecord(pricing) && typeof pricing.amountUsdc === "string" ? pricing.amountUsdc : "0.000000",
    },
    latency: {
      p95Ms: isRecord(latency) && typeof latency.p95Ms === "number" ? latency.p95Ms : 0,
    },
    tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : [],
    agentId: typeof payload.agentId === "string" ? payload.agentId : null,
    inputSchema: payload.inputSchema ?? {},
    outputSchema: payload.outputSchema ?? {},
    kind: readListingKind(payload.kind),
    data: readListingData(payload.data),
  };
}

function readListingKind(value: unknown): ListingKind {
  return value === "dataset" || value === "feed" || value === "lookup" ? value : "service";
}

function readListingData(value: unknown): MarketplaceListing["data"] {
  if (!isRecord(value) || typeof value.slug !== "string") return null;
  const first = Array.isArray(value.sources) && isRecord(value.sources[0]) ? value.sources[0] : null;
  return {
    slug: value.slug,
    refreshCadence: typeof value.refreshCadence === "string" ? value.refreshCadence : "",
    source: first && typeof first.name === "string" ? first.name : "",
    license: first && typeof first.license === "string" ? first.license : "",
  };
}

function readJobPayload(payload: unknown): ConsoleJob {
  if (!isRecord(payload)) throw invalidResponse("Job response was incomplete.");
  return readJob(payload.job);
}

function readJob(payload: unknown): ConsoleJob {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.status !== "string") {
    throw invalidResponse("Job response was incomplete.");
  }
  return {
    id: payload.id,
    status: payload.status,
    listingId: typeof payload.listingId === "string" ? payload.listingId : "",
    listingName: typeof payload.listingName === "string" ? payload.listingName : "",
    query: typeof payload.query === "string" ? payload.query : "",
    amountUsdc: typeof payload.amountUsdc === "string" ? payload.amountUsdc : "",
    takeRateUsdc: typeof payload.takeRateUsdc === "string" ? payload.takeRateUsdc : "",
    sellerNetUsdc: typeof payload.sellerNetUsdc === "string" ? payload.sellerNetUsdc : "",
    buyerBalanceUsdc: typeof payload.buyerBalanceUsdc === "string" ? payload.buyerBalanceUsdc : "",
    sellerBalanceUsdc: typeof payload.sellerBalanceUsdc === "string" ? payload.sellerBalanceUsdc : "",
    escrowId: typeof payload.escrowId === "string" ? payload.escrowId : "",
    validationErrors: Array.isArray(payload.validationErrors)
      ? payload.validationErrors.filter((entry): entry is string => typeof entry === "string")
      : null,
    buyerAgentId: typeof payload.buyerAgentId === "string" ? payload.buyerAgentId : "",
    sellerAgentId: typeof payload.sellerAgentId === "string" ? payload.sellerAgentId : "",
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : "",
    settledAt: typeof payload.settledAt === "string" ? payload.settledAt : null,
    holdAddress: typeof payload.holdAddress === "string" ? payload.holdAddress : null,
    vaultAddress: typeof payload.vaultAddress === "string" ? payload.vaultAddress : null,
    vaultExplorerUrl: typeof payload.vaultExplorerUrl === "string" ? payload.vaultExplorerUrl : null,
    programId: typeof payload.programId === "string" ? payload.programId : null,
    programExplorerUrl: typeof payload.programExplorerUrl === "string" ? payload.programExplorerUrl : null,
    escrowMode: typeof payload.escrowMode === "string" ? payload.escrowMode : null,
    lockExplorerUrl: typeof payload.lockExplorerUrl === "string" ? payload.lockExplorerUrl : null,
    settlementExplorerUrl: typeof payload.settlementExplorerUrl === "string" ? payload.settlementExplorerUrl : null,
    chain: typeof payload.chain === "string" ? payload.chain : null,
  };
}

/** `GET /v1/jobs`, newest first. Rows that do not parse are skipped. */
export function readJobList(payload: unknown): ConsoleJob[] {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) throw invalidResponse("Jobs response was incomplete.");
  const jobs: ConsoleJob[] = [];
  for (const item of payload.jobs) {
    try {
      jobs.push(readJob(item));
    } catch {
      // Skip a malformed row rather than hiding the whole history.
    }
  }
  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

function readLock(payload: unknown): SolanaLockReceipt {
  if (!isRecord(payload) || typeof payload.cluster !== "string" || typeof payload.broadcast !== "boolean") {
    throw invalidResponse("Prepare-lock response was incomplete.");
  }
  if (typeof payload.escrowId !== "string" || typeof payload.transaction !== "string") {
    throw invalidResponse("Prepare-lock response was incomplete.");
  }
  return {
    cluster: payload.cluster,
    broadcast: payload.broadcast,
    escrowId: payload.escrowId,
    jobId: typeof payload.jobId === "string" ? payload.jobId : null,
    feePayer: typeof payload.feePayer === "string" ? payload.feePayer : "",
    buyerPubkey: typeof payload.buyerPubkey === "string" ? payload.buyerPubkey : "",
    amountUsdc: typeof payload.amountUsdc === "string" ? payload.amountUsdc : "",
    quote: readFeeQuote(payload.quote),
    transaction: payload.transaction,
  };
}

function readSettle(payload: unknown): SolanaSettleReceipt {
  if (!isRecord(payload) || typeof payload.cluster !== "string" || typeof payload.broadcast !== "boolean") {
    throw invalidResponse("Settle response was incomplete.");
  }
  if (typeof payload.escrowId !== "string" || typeof payload.transaction !== "string") {
    throw invalidResponse("Settle response was incomplete.");
  }
  return {
    cluster: payload.cluster,
    broadcast: payload.broadcast,
    broadcastNote: typeof payload.broadcastNote === "string" ? payload.broadcastNote : null,
    submitted: payload.submitted === true,
    signature: typeof payload.signature === "string" ? payload.signature : null,
    escrowId: payload.escrowId,
    quote: readFeeQuote(payload.quote),
    treasuryUsdcAta: typeof payload.treasuryUsdcAta === "string" ? payload.treasuryUsdcAta : "",
    transaction: payload.transaction,
  };
}

function readFeeQuote(payload: unknown): RosterFeeQuote {
  if (
    !isRecord(payload) ||
    typeof payload.jobPriceUsdc !== "string" ||
    typeof payload.percentFee !== "number" ||
    typeof payload.baseFeeUsdc !== "string" ||
    typeof payload.rosterFeeUsdc !== "string" ||
    typeof payload.providerPayoutUsdc !== "string"
  ) {
    throw invalidResponse("Fee quote was incomplete.");
  }
  return {
    jobPriceUsdc: payload.jobPriceUsdc,
    percentFee: payload.percentFee,
    baseFeeUsdc: payload.baseFeeUsdc,
    rosterFeeUsdc: payload.rosterFeeUsdc,
    providerPayoutUsdc: payload.providerPayoutUsdc,
  };
}

function invalidResponse(message: string): RosterApiError {
  return new RosterApiError(200, "invalid_response", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type EscrowMode = "custodial-mock" | "noncustodial-sim" | "noncustodial-devnet";

export interface RosterHealth {
  version: string;
  escrowMode: EscrowMode;
  mode: string;
  rail: string;
}

export function readHealth(payload: unknown): RosterHealth {
  if (!isRecord(payload)) throw invalidResponse("Health response was incomplete.");
  return {
    version: typeof payload.version === "string" ? payload.version : "dev",
    escrowMode:
      payload.escrowMode === "noncustodial-devnet"
        ? "noncustodial-devnet"
        : payload.escrowMode === "noncustodial-sim"
          ? "noncustodial-sim"
          : "custodial-mock",
    mode: typeof payload.mode === "string" ? payload.mode : "sandbox",
    rail: typeof payload.rail === "string" ? payload.rail : "mock",
  };
}

export function describeEscrowMode(mode: EscrowMode): string {
  if (mode === "noncustodial-devnet") {
    return "Non-custodial DEVNET: locks sit in the on-chain roster-escrow PDA vault. Roster cannot move funds arbitrarily.";
  }
  if (mode === "noncustodial-sim") {
    return "Non-custodial (simulated): the buyer wallet signs the lock into a program vault; Roster holds no keys.";
  }
  return "Custodial mock: sandbox locks sit on a Roster-minted mock hold address.";
}

export type KycStatus = "none" | "pending" | "approved" | "rejected";

export interface KycSnapshot {
  tier: 0 | 1;
  status: KycStatus;
  windowDays: number;
  usedUsdc: string;
  limitUsdc: string;
  remainingUsdc: string;
  limits: { tier0Usdc: string; tier1Usdc: string };
  submission: {
    entityType: "individual" | "company";
    legalName: string;
    country: string;
    dateOfBirth: string | null;
    companyRegNo: string | null;
    submittedAt: string;
  } | null;
  document: { mimeType: string; sizeBytes: number; uploadedAt: string; deleted: boolean } | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  upgrade: string | null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function readKycPayload(payload: unknown): KycSnapshot {
  if (!isRecord(payload) || !isRecord(payload.kyc)) throw invalidResponse("KYC response was incomplete.");
  const kyc = payload.kyc;
  const limits = isRecord(kyc.limits) ? kyc.limits : {};
  const status = kyc.status;
  const submission = isRecord(kyc.submission) ? kyc.submission : null;
  const document = isRecord(kyc.document) ? kyc.document : null;
  return {
    tier: kyc.tier === 1 ? 1 : 0,
    status: status === "pending" || status === "approved" || status === "rejected" ? status : "none",
    windowDays: typeof kyc.windowDays === "number" ? kyc.windowDays : 30,
    usedUsdc: str(kyc.usedUsdc, "0.000000"),
    limitUsdc: str(kyc.limitUsdc, "0.000000"),
    remainingUsdc: str(kyc.remainingUsdc, "0.000000"),
    limits: { tier0Usdc: str(limits.tier0Usdc, "0.000000"), tier1Usdc: str(limits.tier1Usdc, "0.000000") },
    submission: submission
      ? {
          entityType: submission.entityType === "company" ? "company" : "individual",
          legalName: str(submission.legalName),
          country: str(submission.country),
          dateOfBirth: typeof submission.dateOfBirth === "string" ? submission.dateOfBirth : null,
          companyRegNo: typeof submission.companyRegNo === "string" ? submission.companyRegNo : null,
          submittedAt: str(submission.submittedAt),
        }
      : null,
    document: document
      ? {
          mimeType: str(document.mimeType),
          sizeBytes: typeof document.sizeBytes === "number" ? document.sizeBytes : 0,
          uploadedAt: str(document.uploadedAt),
          deleted: document.deleted === true,
        }
      : null,
    reviewedAt: typeof kyc.reviewedAt === "string" ? kyc.reviewedAt : null,
    rejectionReason: typeof kyc.rejectionReason === "string" ? kyc.rejectionReason : null,
    upgrade: typeof kyc.upgrade === "string" ? kyc.upgrade : null,
  };
}

/** Share of the cap already used, 0-100. */
export function kycUsagePercent(snapshot: Pick<KycSnapshot, "usedUsdc" | "limitUsdc">): number {
  const used = Number(snapshot.usedUsdc);
  const limit = Number(snapshot.limitUsdc);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 1000) / 10));
}
