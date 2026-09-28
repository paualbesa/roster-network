import { Hono } from "hono";
import { MockWalletProvider, resolveRuntimeMode, type RuntimeMode } from "@albesa/core";
import { JsonReputationLedger, type ReputationEventInput, type ReputationLedger } from "@albesa/reputation";
import { AgentFinanceService, ServiceError, type CreateAgentInput, type PaymentInput } from "./service.js";
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
   * JSON file for organizations, agents, balances, and the ledger.
   * Omit it to keep state in memory (tests and one-off callers).
   */
  dataFile?: string;
  reputation?: ReputationLedger;
  /** Versioned JSON metrics file. Ignored when `service` or `reputation` is passed. */
  reputationFile?: string;
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const mode = options.mode ?? resolveRuntimeMode();
  const service = options.service ?? openService(options, mode);
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ ok: true, product: "Roster", mode, rail: "mock", asset: "USDC" }));

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

  app.onError((error, c) => {
    if (error instanceof ServiceError) {
      const body = error.transaction
        ? { error: { code: error.code, message: error.message }, transaction: error.transaction }
        : { error: { code: error.code, message: error.message } };
      return c.json(body, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal", message: "Internal error." } }, 500);
  });

  return app;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openService(options: AppOptions, mode: RuntimeMode): AgentFinanceService {
  const reputationPath = options.reputationFile?.trim();
  const reputation =
    options.reputation ?? (reputationPath ? JsonReputationLedger.open(reputationPath) : undefined);
  const shared = {
    mode,
    ...(options.now ? { now: options.now } : {}),
    ...(reputation ? { reputation } : {}),
  };
  const dataFile = options.dataFile?.trim();
  if (!dataFile) return new AgentFinanceService(shared);
  const store = JsonFileStore.open(dataFile);
  const wallets = new MockWalletProvider();
  wallets.importState(store.readWalletState());
  return new AgentFinanceService({ ...shared, store, wallets });
}
