import { ROSTER_BROWSER_API_BASE } from "./api-base";

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
  outputSchema: unknown;
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
    if (body !== undefined) {
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
    account(): Promise<AccountSnapshot> {
      return request<unknown>("GET", "/v1/account").then(readAccount);
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
      return request<unknown>("POST", "/v1/jobs", body).then(readJobPayload);
    },
    job(jobId: string): Promise<ConsoleJob> {
      return request<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`).then(readJobPayload);
    },
    submitResult(jobId: string, result: unknown): Promise<ConsoleJob> {
      return request<unknown>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/result`, { result }).then(readJobPayload);
    },
  };
}

export function rosterErrorMessage(error: unknown): string {
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

function readAccount(payload: unknown): AccountSnapshot {
  if (!isRecord(payload) || !isRecord(payload.user) || !isRecord(payload.treasury)) {
    throw invalidResponse("Account response was incomplete.");
  }
  const wallet = payload.treasury.wallet;
  if (typeof payload.user.email !== "string" || typeof payload.user.organizationId !== "string") {
    throw invalidResponse("Account response was incomplete.");
  }
  return {
    email: payload.user.email,
    displayName: typeof payload.user.displayName === "string" ? payload.user.displayName : payload.user.email,
    organizationId: payload.user.organizationId,
    balanceUsdc: typeof payload.treasury.balanceUsdc === "string" ? payload.treasury.balanceUsdc : "",
    address: isRecord(wallet) && typeof wallet.address === "string" ? wallet.address : "",
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
    outputSchema: payload.outputSchema ?? {},
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
  };
}

function invalidResponse(message: string): RosterApiError {
  return new RosterApiError(200, "invalid_response", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
