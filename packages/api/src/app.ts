import { Hono } from "hono";
import {
  createWalletProvider,
  isPersistentSandboxWallet,
  resolveRuntimeMode,
  resolveWalletRail,
  type RuntimeMode,
  type WalletRail,
} from "@albesa/core";
import {
  CapabilityRegistry,
  parseSearchQuery,
  readListingAgentId,
  RegistryError,
  type CapabilityListing,
  type CapabilitySearchQuery,
  type ReputationRankInput,
} from "@albesa/registry";
import { JsonReputationLedger, type ReputationEventInput, type ReputationLedger } from "@albesa/reputation";
import {
  AgentFinanceService,
  ServiceError,
  type CreateAgentInput,
  type CreateEscrowInput,
  type PaymentInput,
} from "./service.js";
import { JsonFileStore } from "./store.js";

type AppEnv = {
  Variables: {
    orgId: string;
  };
};

export interface AppOptions {
  mode?: RuntimeMode;
  now?: () => Date;
  service?: AgentFinanceService;
  /**
   * JSON file for organizations, agents, escrows, balances, and the ledger.
   * Omit it to keep state in memory (tests and one-off callers).
   */
  dataFile?: string;
  reputation?: ReputationLedger;
  /** Versioned JSON metrics file. Ignored when `service` or `reputation` is passed. */
  reputationFile?: string;
  /** Capability index. Omit it to keep listings in memory. */
  registry?: CapabilityRegistry;
  /**
   * Test double for passport lookup. When set, search uses it instead of the
   * reputation ledger. Return null when the seller has no events (neutral).
   */
  passportScores?: ListingPassportScore;
  /**
   * Settlement adapter. Omit it to read `ROSTER_WALLET` / `ALBESA_WALLET`.
   * Unset selects the mock rail.
   */
  walletRail?: WalletRail;
}

/** Score for one listing, or null when reputation should stay neutral. */
export type ListingPassportScore = (
  listing: Pick<CapabilityListing, "id" | "organizationId" | "agentId">,
) => number | null | Promise<number | null>;

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const mode = options.mode ?? resolveRuntimeMode();
  const walletRail = options.walletRail ?? resolveWalletRail();
  const service = options.service ?? openService(options, mode, walletRail);
  const registry = options.registry ?? new CapabilityRegistry(options.now ? { now: options.now } : {});
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ ok: true, product: "Roster", mode, rail: walletRail, asset: "USDC" }));

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/organizations" && c.req.method === "POST") {
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/.exec(header);
    const apiKey = match?.[1];
    if (!apiKey) {
      return c.json({ error: { code: "unauthorized", message: "Send Authorization: Bearer <api key>." } }, 401);
    }
    const orgId = service.authenticate(apiKey);
    if (!orgId) {
      return c.json({ error: { code: "unauthorized", message: "Unknown API key." } }, 401);
    }
    c.set("orgId", orgId);
    await next();
    return;
  });

  app.post("/v1/organizations", async (c) => {
    const body = await readJson(c);
    const name = readString(body, "name");
    if (!name) throw new ServiceError(400, "invalid_request", "name is required.");
    const result = await service.createOrganization(name);
    return c.json(result, 201);
  });

  app.post("/v1/agents", async (c) => {
    const input = parseCreateAgent(await readJson(c));
    const result = await service.createAgent(c.get("orgId"), input);
    return c.json(result, 201);
  });

  app.post("/v1/agents/:agentId/fund", async (c) => {
    const body = await readJson(c);
    const amountUsdc = readString(body, "amountUsdc");
    if (!amountUsdc) throw new ServiceError(400, "invalid_request", "amountUsdc is required.");
    const result = await service.fundAgent(c.get("orgId"), c.req.param("agentId"), amountUsdc);
    return c.json(result);
  });

  app.post("/v1/agents/:agentId/payments", async (c) => {
    const input = parsePayment(await readJson(c));
    const result = await service.payAgent(c.get("orgId"), c.req.param("agentId"), input);
    return c.json(result);
  });

  app.get("/v1/agents/:agentId/balance", async (c) => {
    const result = await service.getAgentBalance(c.get("orgId"), c.req.param("agentId"));
    return c.json(result);
  });

  app.get("/v1/agents/:agentId/transactions", async (c) => {
    const transactions = await service.listAgentTransactions(c.get("orgId"), c.req.param("agentId"));
    return c.json({ transactions });
  });

  app.get("/v1/agents/:agentId/ledger", async (c) => {
    const balance = await service.getAgentBalance(c.get("orgId"), c.req.param("agentId"));
    const entries = await service.listLedger(c.get("orgId"), balance.walletId);
    return c.json({ entries });
  });

  app.get("/v1/treasury", async (c) => {
    const result = await service.getTreasury(c.get("orgId"));
    return c.json(result);
  });

  app.post("/v1/agents/:agentId/reputation/events", async (c) => {
    const input = parseReputationEvent(await readJson(c));
    const result = await service.recordReputationEvent(c.get("orgId"), c.req.param("agentId"), input);
    return c.json(result, 201);
  });

  app.get("/v1/agents/:agentId/passport", async (c) => {
    const passport = await service.getPassport(c.req.param("agentId"));
    return c.json({ passport });
  });

  app.post("/v1/escrows", async (c) => {
    const input = parseCreateEscrow(await readJson(c));
    const result = await service.createEscrow(c.get("orgId"), input);
    return c.json(result, 201);
  });

  app.get("/v1/escrows", async (c) => {
    const escrows = await service.listEscrows(c.get("orgId"));
    return c.json({ escrows });
  });

  app.get("/v1/escrows/:escrowId", async (c) => {
    const result = await service.getEscrow(c.get("orgId"), c.req.param("escrowId"));
    return c.json(result);
  });

  app.post("/v1/escrows/:escrowId/result", async (c) => {
    const resultPayload = parseEscrowResult(await readJson(c));
    const result = await service.submitEscrowResult(c.get("orgId"), c.req.param("escrowId"), resultPayload);
    return c.json(result);
  });

  app.post("/v1/registry/listings", async (c) => {
    const body = await readJson(c);
    await bindSellerAgent(service, c.get("orgId"), body);
    const listing = registry.register(c.get("orgId"), body);
    return c.json({ listing }, 201);
  });

  app.put("/v1/registry/listings/:id", async (c) => {
    const body = await readJson(c);
    await bindSellerAgent(service, c.get("orgId"), body);
    const listing = registry.update(c.get("orgId"), c.req.param("id"), body);
    return c.json({ listing });
  });

  app.get("/v1/registry/listings/:id", (c) => {
    const listing = registry.get(c.req.param("id"));
    if (!listing) throw new RegistryError(404, "not_found", "Capability listing not found.");
    return c.json({ listing });
  });

  app.get("/v1/registry/search", async (c) => {
    const query = parseSearchQuery({
      q: c.req.query("q"),
      tags: c.req.query("tags"),
      maxPriceUsdc: c.req.query("maxPriceUsdc"),
      maxP95Ms: c.req.query("maxP95Ms"),
      limit: c.req.query("limit"),
      minScore: c.req.query("minScore"),
      withReputation: c.req.query("withReputation"),
    });
    const reputation = await reputationForSearch(registry, service, options.passportScores, query);
    const hits = registry.search(query, reputation);
    return c.json({ hits });
  });

  app.onError((error, c) => {
    if (error instanceof ServiceError) {
      const body = error.transaction
        ? { error: { code: error.code, message: error.message }, transaction: error.transaction }
        : { error: { code: error.code, message: error.message } };
      return c.json(body, error.status);
    }
    if (error instanceof RegistryError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal", message: "Internal error." } }, 500);
  });

  return app;
}

async function bindSellerAgent(service: AgentFinanceService, organizationId: string, body: unknown): Promise<void> {
  const agentId = readListingAgentId(body);
  if (typeof agentId === "string") await service.assertOwnedAgent(organizationId, agentId);
}

async function reputationForSearch(
  registry: CapabilityRegistry,
  service: AgentFinanceService,
  lookup: ListingPassportScore | undefined,
  query: CapabilitySearchQuery,
): Promise<ReputationRankInput | null> {
  if (!query.withReputation && query.minScore === null) return null;
  const listings = registry.list();
  const scoresByListingId = new Map<string, number | null>();
  if (lookup) {
    for (const listing of listings) {
      const score = await lookup(listing);
      if (typeof score === "number") scoresByListingId.set(listing.id, score);
    }
  } else {
    const observed = await service.observedPassportScores(listings);
    for (const [id, score] of observed) scoresByListingId.set(id, score);
  }
  return { scoresByListingId };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ServiceError(400, "invalid_request", "Expected a JSON body.");
  }
}

function readString(body: unknown, key: string): string | null {
  if (!isRecord(body)) return null;
  const value = body[key];
  return typeof value === "string" ? value : null;
}

function parseCreateAgent(body: unknown): CreateAgentInput {
  if (!isRecord(body)) throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  const name = body.name;
  const dailySpendLimitUsdc = body.dailySpendLimitUsdc;
  const vendorAllowlist = body.vendorAllowlist;
  if (typeof name !== "string" || typeof dailySpendLimitUsdc !== "string" || !Array.isArray(vendorAllowlist)) {
    throw new ServiceError(
      400,
      "invalid_request",
      "name, dailySpendLimitUsdc, and vendorAllowlist are required.",
    );
  }
  const vendors: string[] = [];
  for (const vendorId of vendorAllowlist) {
    if (typeof vendorId !== "string") {
      throw new ServiceError(400, "invalid_request", "vendorAllowlist entries must be strings.");
    }
    vendors.push(vendorId);
  }
  return { name, dailySpendLimitUsdc, vendorAllowlist: vendors };
}

function parsePayment(body: unknown): PaymentInput {
  if (!isRecord(body)) throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  const vendorId = body.vendorId;
  const amountUsdc = body.amountUsdc;
  if (typeof vendorId !== "string" || typeof amountUsdc !== "string") {
    throw new ServiceError(400, "invalid_request", "vendorId and amountUsdc are required.");
  }
  if (body.memo !== undefined && body.memo !== null && typeof body.memo !== "string") {
    throw new ServiceError(400, "invalid_request", "memo must be a string.");
  }
  return {
    vendorId,
    amountUsdc,
    memo: typeof body.memo === "string" ? body.memo : null,
  };
}

function parseReputationEvent(body: unknown): ReputationEventInput {
  if (!isRecord(body)) throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  const outcome = body.outcome;
  const latencyMs = body.latencyMs;
  const volumeUsdc = body.volumeUsdc;
  if (outcome !== "success" && outcome !== "failure") {
    throw new ServiceError(400, "invalid_request", 'outcome must be "success" or "failure".');
  }
  if (typeof latencyMs !== "number" || typeof volumeUsdc !== "string") {
    throw new ServiceError(400, "invalid_request", "latencyMs (number) and volumeUsdc (string) are required.");
  }
  if (body.error !== undefined && typeof body.error !== "boolean") {
    throw new ServiceError(400, "invalid_request", "error must be a boolean.");
  }
  if (body.hallucination !== undefined && typeof body.hallucination !== "boolean") {
    throw new ServiceError(400, "invalid_request", "hallucination must be a boolean.");
  }
  if (body.sourceRef !== undefined && body.sourceRef !== null && typeof body.sourceRef !== "string") {
    throw new ServiceError(400, "invalid_request", "sourceRef must be a string.");
  }
  return {
    outcome,
    latencyMs,
    volumeUsdc,
    ...(typeof body.error === "boolean" ? { error: body.error } : {}),
    ...(typeof body.hallucination === "boolean" ? { hallucination: body.hallucination } : {}),
    ...(typeof body.sourceRef === "string" || body.sourceRef === null ? { sourceRef: body.sourceRef } : {}),
  };
}

function parseCreateEscrow(body: unknown): CreateEscrowInput {
  if (!isRecord(body)) throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  const buyerAgentId = body.buyerAgentId;
  const sellerAgentId = body.sellerAgentId;
  const amountUsdc = body.amountUsdc;
  if (
    typeof buyerAgentId !== "string" ||
    typeof sellerAgentId !== "string" ||
    typeof amountUsdc !== "string" ||
    !("schema" in body)
  ) {
    throw new ServiceError(
      400,
      "invalid_request",
      "buyerAgentId, sellerAgentId, amountUsdc, and schema are required.",
    );
  }
  if (body.memo !== undefined && body.memo !== null && typeof body.memo !== "string") {
    throw new ServiceError(400, "invalid_request", "memo must be a string.");
  }
  return {
    buyerAgentId,
    sellerAgentId,
    amountUsdc,
    schema: body.schema,
    memo: typeof body.memo === "string" ? body.memo : null,
  };
}

function parseEscrowResult(body: unknown): unknown {
  if (!isRecord(body) || !("result" in body)) {
    throw new ServiceError(400, "invalid_request", "result is required.");
  }
  return body.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openService(options: AppOptions, mode: RuntimeMode, walletRail: WalletRail): AgentFinanceService {
  const wallets = createWalletProvider(walletRail);
  const reputationPath = options.reputationFile?.trim();
  const reputation =
    options.reputation ?? (reputationPath ? JsonReputationLedger.open(reputationPath) : undefined);
  const dataFile = options.dataFile?.trim();
  const store = dataFile ? JsonFileStore.open(dataFile) : undefined;
  if (store && isPersistentSandboxWallet(wallets)) wallets.importState(store.readWalletState());
  return new AgentFinanceService({
    mode,
    wallets,
    ...(options.now ? { now: options.now } : {}),
    ...(reputation ? { reputation } : {}),
    ...(store ? { store } : {}),
  });
}
