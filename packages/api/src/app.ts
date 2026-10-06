import { SolanaFeeError, resolveSolanaEngineConfig, type SolanaEngineConfig } from "@albesa/solana";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import {
  createWalletProvider,
  isPersistentSandboxWallet,
  resolveRuntimeMode,
  resolveWalletRail,
  type EscrowMode,
  type RuntimeMode,
  type WalletRail,
} from "@albesa/core";
import {
  CapabilityRegistry,
  embedSemantic,
  parseSearchQuery,
  readListingAgentId,
  RegistryError,
  type CapabilityListing,
  type CapabilitySearchQuery,
  type ReputationRankInput,
} from "@albesa/registry";
import { JsonReputationLedger, type ReputationEventInput, type ReputationLedger } from "@albesa/reputation";
import {
  JobOrchestrator,
  JsonJobStore,
  MemoryJobStore,
  parseCreateJobBody,
  parseJobResultBody,
  parseSellerBindingBody,
  resolveAutofillConfig,
  sandboxMarketplaceListings,
  type JobStore,
} from "./jobs.js";
import { adminGateFor, adminGateResponse, isAdminPath, registerAdminRoutes } from "./admin.js";
import { rosterCors } from "./cors.js";
import { attachAppRuntime } from "./fleet.js";
import {
  clientAddress,
  IDEMPOTENCY_HEADER,
  IdempotencyCache,
  isValidIdempotencyKey,
  RateLimiter,
  readOrCreateRequestId,
  type RateLimitConfig,
  type RateLimitDecision,
  type RateLimitRule,
} from "./http.js";
import { openApiDocument } from "./openapi.js";
import { registerSolanaEscrowRoutes } from "./solana-routes.js";
import {
  AgentFinanceService,
  ServiceError,
  type CreateAccountInput,
  type CreateAgentInput,
  type CreateEscrowInput,
  type PaymentInput,
} from "./service.js";
import { JsonFileStore } from "./store.js";
import { KYC_SUBMISSION_MAX_BODY_BYTES, LocalKycDocumentStore, type KycDocumentStore, type KycLimits } from "./kyc.js";
import { KYC_DOCUMENT_TOKEN_RE, KYC_SUBMISSION_PATH, registerKycAdminRoutes, registerKycRoutes } from "./kyc-routes.js";
import { DataCatalog } from "./data/catalog.js";
import { LocalDataStore, type DataStore } from "./data/store.js";
import { DATA_DOWNLOAD_TOKEN_RE, registerDataAdminRoutes, registerDataRoutes } from "./data-routes.js";
import { DemandLog } from "./demand.js";
import type { ExternalFulfiller } from "./jobs.js";
import type { FirstPartyOrgs } from "./sell/activity.js";
import { createSafeFetcher, type SafeFetcher } from "./sell/net.js";
import { SellerProxy } from "./sell/proxy.js";
import { registerSellRoutes } from "./sell/routes.js";

import { foundingConfigFromEnv, SellerDirectory } from "./sell/sellers.js";

type AppEnv = {
  Variables: {
    orgId: string;
    requestId: string;
  };
};

/** Largest JSON body the API reads. Larger bodies get 413 payload_too_large. */
export const MAX_BODY_BYTES = 256 * 1024;

const STARTED_AT = new Date();

/** Transport options. server.ts turns them on; tests opt in. */
export interface AppHttpOptions {
  /** Rate limits. Omit or pass null to turn them off (tests, scripts). */
  rateLimit?: RateLimitConfig | null;
  /** One JSON line per request on stdout. */
  accessLog?: boolean;
  /** Reported by /health. Omit it to read `ROSTER_GIT_SHA`. */
  version?: string;
  /** Reported by /health: `memory`, `json`, or `supabase`. */
  storage?: string;
  /** Clock for the rate limiter and idempotency cache. */
  clock?: () => number;
}

export interface AppOptions extends AppHttpOptions {
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
  /** Escrow custody model. Ignored when `service` is passed. Omit it to read `ROSTER_ESCROW_MODE`. */
  escrowMode?: EscrowMode;
  /** KYC caps. Ignored when `service` is passed. Omit them to read `ROSTER_KYC_T*_LIMIT_USDC`. */
  kycLimits?: KycLimits;
  /** Private KYC document storage. Omit it to keep documents in process memory. */
  kycDocuments?: KycDocumentStore;
  /**
   * Data product files and freshness records. Omit it for an in-memory store;
   * `null` turns Roster Data off. Ignored when `dataCatalog` is passed.
   */
  dataStore?: DataStore | null;
  /** Prebuilt data catalog (tests inject fixture products). */
  dataCatalog?: DataCatalog | null;
  /** Unmet-demand log for `POST /v1/need`. Omit it to keep it in memory. */
  demandLog?: DemandLog;
  /** Seller profiles and private endpoints of imported listings. Omit it to keep them in memory. */
  sellers?: SellerDirectory;
  /** Outbound HTTP for imports and the seller proxy. Omit it for the SSRF-guarded default. */
  egressFetcher?: SafeFetcher;
  /** Tests only: accept http:// seller URLs. */
  allowHttpEgress?: boolean;
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
  /** Jobs and listing→seller bindings. Omit both this and `jobsFile` to keep them in memory. */
  jobs?: JobStore;
  /** Versioned JSON file for jobs. Ignored when `jobs` is passed. */
  jobsFile?: string;
  /**
   * Fleet delivery. `sync` settles inside `POST /v1/jobs`.
   * Omit it to read `ROSTER_AUTOFULFILL` (`sync` or async).
   */
  autofill?: "sync" | "async";
  /** Wait before an async fleet delivery. Omit it to read `ROSTER_AUTOFULFILL_DELAY_MS` (default 50). */
  autofillDelayMs?: number;
  /**
   * Gasless Solana fee engine. Omit it to read ROSTER_SOLANA_* from the environment.
   * The default cluster is mock and does not broadcast.
   */
  solana?: SolanaEngineConfig;
  /**
   * Operator token for `/v1/admin/*`.
   * Omit it to read `ROSTER_ADMIN_TOKEN`. `null` or a blank string disables the admin API.
   */
  adminToken?: string | null;
  /**
   * Supabase Auth and Postgres. Omit it and the API keeps API keys and JSON files.
   * Agents are not required to present a Supabase user.
   */
  supabase?: {
    verifyAccessToken: (
      accessToken: string,
    ) => Promise<{ id: string; email: string; displayName: string | null } | null>;
    matchCapabilities?: (query: ArrayLike<number>, limit: number) => Promise<ReadonlyMap<string, number>>;
    flush?: () => Promise<void>;
  };
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
  const jobs = openJobStore(options);
  const autofill = resolveAutofillConfig({
    ...(options.autofill !== undefined ? { mode: options.autofill } : {}),
    ...(options.autofillDelayMs !== undefined ? { delayMs: options.autofillDelayMs } : {}),
  });
  const dataStore =
    options.dataStore === null ? null : (options.dataStore ?? (options.dataCatalog === undefined ? new LocalDataStore() : null));
  const data =
    options.dataCatalog !== undefined
      ? options.dataCatalog
      : dataStore
        ? new DataCatalog(dataStore, options.now ? { now: options.now } : {})
        : null;
  const demand = options.demandLog ?? new DemandLog(null, options.now ?? (() => new Date()));
  const firstParty: FirstPartyOrgs = { labs: null, data: null };
  const sellers = options.sellers ?? new SellerDirectory(null, foundingConfigFromEnv(), undefined, options.now ?? (() => new Date()));
  sellers.setFirstPartyCheck((org) => org === firstParty.labs || org === firstParty.data);
  const egress = options.egressFetcher ?? createSafeFetcher({ allowHttp: options.allowHttpEgress === true });
  const proxy = new SellerProxy(sellers, egress, (listingId) => registry.get(listingId)?.latency.p95Ms ?? 30_000);
  // The data catalog matches by name, so it only serves listings of the real Roster Data org.
  const ownsData = (listing: { name: string; organizationId: string }) =>
    data !== null && firstParty.data !== null && listing.organizationId === firstParty.data && data.handles(listing.name);
  const fulfiller: ExternalFulfiller = {
    handles: (listing) => proxy.handles(listing) || ownsData(listing),
    fulfill: (listing, input) => (proxy.handles(listing) ? proxy.fulfill(listing, input) : data!.fulfill(listing.name, input)),
  };
  service.setTakeRatePolicy((org) => sellers.takeRateBpsFor(org));
  const orchestrator = new JobOrchestrator({
    service,
    registry,
    jobs,
    autofill,
    ...(options.now ? { now: options.now } : {}),
    externalFulfiller: fulfiller,
  });
  const app = new Hono<AppEnv>();
  attachAppRuntime(app, { mode, service, registry, jobs, orchestrator, data, firstParty, sellers });
  const clock = options.clock ?? Date.now;
  const limits = options.rateLimit ?? null;
  const limiter = new RateLimiter(clock);
  const idempotency = new IdempotencyCache(clock);
  const version = options.version ?? (process.env.ROSTER_GIT_SHA?.trim() || "dev");
  const storage = options.storage ?? (options.dataFile ? "json" : "memory");
  const accessLog = options.accessLog === true;

  // Request id and access log wrap everything, including errors and 404s.
  app.use("*", async (c, next) => {
    const started = performance.now();
    const requestId = readOrCreateRequestId(c.req.header("x-request-id"));
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("x-request-id", requestId);
    if (accessLog) {
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          msg: "request",
          requestId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          ms: Math.round((performance.now() - started) * 10) / 10,
          org: c.get("orgId") ?? null,
        }),
      );
    }
  });

  const flush = options.supabase?.flush;
  if (flush) {
    app.use("*", async (_c, next) => {
      let failure: unknown;
      try {
        await next();
      } catch (error) {
        failure = error;
      }
      try {
        await flush();
      } catch (error) {
        if (failure === undefined) throw error;
        console.error(error);
      }
      if (failure !== undefined) throw failure;
    });
  }

  // Direct browser calls from https://roster.network and localhost.
  // A same-origin Next.js proxy on the marketing site is the preferred path.
  app.use("*", rosterCors());
  app.use(
    "*",
    secureHeaders({
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
    }),
  );
  const defaultBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "payload_too_large",
            message: `Request body must be at most ${(MAX_BODY_BYTES / 1024).toString()} KB.`,
          },
        },
        413,
      ),
  });
  // KYC document uploads get their own 5 MB (+ multipart overhead) cap.
  const kycBodyLimit = bodyLimit({
    maxSize: KYC_SUBMISSION_MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: { code: "payload_too_large", message: "The KYC submission must be at most 5 MB." } }, 413),
  });
  app.use("/v1/*", (c, next) =>
    c.req.method === "POST" && c.req.path === KYC_SUBMISSION_PATH ? kycBodyLimit(c, next) : defaultBodyLimit(c, next),
  );
  const kycDocuments = options.kycDocuments ?? new LocalKycDocumentStore(options.now ? { now: options.now } : {});
  const kycDeps = { service, documents: kycDocuments, now: options.now ?? (() => new Date()) };

  app.get("/health", (c) =>
    c.json({
      ok: true,
      product: "Roster",
      mode,
      rail: walletRail,
      asset: "USDC",
      version,
      storage,
      escrowMode: service.escrowMode,
      kyc: { tier0LimitUsdc: service.kycLimits.tier0Usdc, tier1LimitUsdc: service.kycLimits.tier1Usdc, windowDays: 30 },
      startedAt: STARTED_AT.toISOString(),
      uptimeS: Math.floor((Date.now() - STARTED_AT.getTime()) / 1000),
    }),
  );


  app.get("/openapi.json", (c) => c.json(openApiDocument));
  app.get("/v1/openapi.json", (c) => c.json(openApiDocument));

  const adminDeps = {
    mode,
    rail: walletRail,
    service,
    registry,
    orchestrator,
    jobs,
    sellers,
    appHandle: app,
    ...(options.adminToken !== undefined ? { adminToken: options.adminToken } : {}),
  };

  const limit = (c: Context<AppEnv>, key: string, rule: RateLimitRule): Response | null => {
    if (!limits) return null;
    const decision = limiter.hit(key, rule);
    setRateLimitHeaders(c, decision);
    if (decision.allowed) return null;
    return rateLimitedResponse(c, decision);
  };
  const failureKey = (c: Context<AppEnv>) => `fail:${clientAddress(c.req.raw.headers)}`;
  const tooManyFailures = (c: Context<AppEnv>): Response | null => {
    if (!limits) return null;
    const decision = limiter.peek(failureKey(c), limits.authFailures);
    if (decision.allowed) return null;
    return rateLimitedResponse(c, decision);
  };
  const recordFailure = (c: Context<AppEnv>): void => {
    if (limits) limiter.hit(failureKey(c), limits.authFailures);
  };

  app.use("/v1/*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      await next();
      return;
    }
    const address = clientAddress(c.req.raw.headers);
    if (isAdminPath(c.req.path)) {
      const blocked = tooManyFailures(c);
      if (blocked) return blocked;
      const gate = adminGateFor(c.req.raw.headers, adminDeps);
      if (!gate.ok) {
        if (gate.status === 401) recordFailure(c);
        return adminGateResponse(c, gate);
      }
      await next();
      return;
    }
    if (isPublicRoute(c.req.method, c.req.path)) {
      if (limits) {
        let rule = limits.publicRead;
        let bucket = "public";
        if (isAnonymousAuthRoute(c.req.method, c.req.path)) {
          rule = limits.anonymous;
          bucket = "anonymous";
        } else if (isAuthRoute(c.req.method, c.req.path)) {
          rule = limits.auth;
          bucket = "auth";
        } else if (c.req.path === "/v1/waitlist") {
          rule = limits.waitlist;
          bucket = "waitlist";
        }
        const blocked = limit(c, `${bucket}:${address}`, rule);
        if (blocked) return blocked;
      }
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/.exec(header);
    const apiKey = match?.[1];
    if (!apiKey) {
      return c.json({ error: { code: "unauthorized", message: "Send Authorization: Bearer <api key>." } }, 401);
    }
    const blocked = tooManyFailures(c);
    if (blocked) return blocked;
    let orgId: string | null;
    if (looksLikeJwt(apiKey)) {
      const resolved = await organizationForSupabaseToken(service, options.supabase, apiKey);
      if (typeof resolved !== "string") {
        if (resolved.status === 401) recordFailure(c);
        return c.json({ error: { code: resolved.code, message: resolved.message } }, resolved.status);
      }
      orgId = resolved;
    } else {
      orgId = service.authenticate(apiKey);
    }
    if (!orgId) {
      recordFailure(c);
      return c.json({ error: { code: "unauthorized", message: "Unknown API key." } }, 401);
    }
    c.set("orgId", orgId);
    if (limits) {
      const limited = limit(c, `org:${orgId}`, limits.organization);
      if (limited) return limited;
    }
    await next();
    return;
  });

  // Idempotency-Key on authenticated writes. The first response is replayed for 24 hours.
  app.use("/v1/*", async (c, next) => {
    const method = c.req.method;
    const key = c.req.header(IDEMPOTENCY_HEADER)?.trim();
    const orgId = c.get("orgId");
    // Multipart uploads are not replayed: reading the body as text would corrupt the file.
    if ((method !== "POST" && method !== "PUT" && method !== "DELETE") || !key || !orgId || c.req.path === KYC_SUBMISSION_PATH) {
      await next();
      return;
    }
    if (!isValidIdempotencyKey(key)) {
      return c.json(
        { error: { code: "invalid_request", message: "Idempotency-Key must be 1-255 printable ASCII characters." } },
        400,
      );
    }
    const body = await c.req.text();
    const fingerprint = IdempotencyCache.fingerprint(body);
    const scope = IdempotencyCache.scope(orgId, method, c.req.path, key);
    const existing = idempotency.lookup(scope);
    if (existing === "pending") {
      return c.json(
        { error: { code: "idempotency_in_progress", message: "A request with this Idempotency-Key is still running." } },
        409,
      );
    }
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return c.json(
          {
            error: {
              code: "idempotency_conflict",
              message: "This Idempotency-Key was already used with a different request body.",
            },
          },
          409,
        );
      }
      const headers = new Headers({ "idempotent-replayed": "true" });
      if (existing.contentType) headers.set("content-type", existing.contentType);
      return new Response(existing.body, { status: existing.status, headers });
    }
    idempotency.begin(scope);
    try {
      await next();
    } catch (error) {
      idempotency.abort(scope);
      throw error;
    }
    const status = c.res.status;
    if (status >= 500) {
      idempotency.abort(scope);
      return;
    }
    const text = await c.res.clone().text();
    idempotency.finish(scope, {
      fingerprint,
      status,
      body: text,
      contentType: c.res.headers.get("content-type"),
    });
  });

  app.post("/v1/organizations", async (c) => {
    const body = await readJson(c);
    const name = readString(body, "name");
    if (!name) throw new ServiceError(400, "invalid_request", "name is required.");
    const result = await service.createOrganization(name);
    return c.json(result, 201);
  });

  app.post("/v1/accounts", async (c) => {
    const input = parseCreateAccount(await readJson(c));
    const result = await service.createAccount(input);
    return c.json(result, 201);
  });

  app.post("/v1/accounts/login", async (c) => {
    const input = parseLogin(await readJson(c));
    const result = await service.loginAccount(input.email, input.password);
    return c.json(result);
  });

  app.post("/v1/accounts/session", async (c) => {
    const supabase = options.supabase;
    if (!supabase) {
      return c.json(
        {
          error: {
            code: "supabase_unconfigured",
            message:
              "Supabase Auth is not configured. Use email and password, or set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
          },
        },
        503,
      );
    }
    const header = c.req.header("authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/.exec(header)?.[1];
    if (!token) {
      return c.json(
        { error: { code: "unauthorized", message: "Send Authorization: Bearer <supabase access token>." } },
        401,
      );
    }
    const identity = await supabase.verifyAccessToken(token);
    if (!identity) {
      return c.json({ error: { code: "unauthorized", message: "Supabase access token was rejected." } }, 401);
    }
    const result = await service.acceptAuthUser({
      authUserId: identity.id,
      email: identity.email,
      displayName: identity.displayName,
    });
    return c.json(result);
  });

  /** Instant sandbox org without email. Rate-limited per IP more tightly than email signup. */
  app.post("/v1/accounts/anonymous", async (c) => {
    const result = await service.createAnonymousAccount();
    return c.json(result, 201);
  });

  app.get("/v1/account", async (c) => {
    const result = await service.getAccount(c.get("orgId"));
    return c.json(result);
  });

  app.post("/v1/account/claim", async (c) => {
    const input = parseCreateAccount(await readJson(c));
    const result = await service.claimAccount(c.get("orgId"), input);
    return c.json(result, 201);
  });

  app.post("/v1/account/api-key/rotate", async (c) => {
    const token = /^Bearer\s+(\S+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (!token || looksLikeJwt(token)) {
      throw new ServiceError(400, "invalid_request", "Only Roster API keys can be rotated. Sign in with a sandbox key.");
    }
    const result = await service.rotateApiKey(token);
    return c.json(result);
  });

  app.delete("/v1/account/api-key", async (c) => {
    const token = /^Bearer\s+(\S+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (looksLikeJwt(token)) {
      throw new ServiceError(400, "invalid_request", "Only Roster API keys can be revoked. Sign out of Supabase instead.");
    }
    const result = await service.revokeApiKey(token);
    return c.json(result);
  });

  app.post("/v1/waitlist", async (c) => {
    const body = await readJson(c);
    const email = readString(body, "email");
    if (!email) throw new ServiceError(400, "invalid_request", "email is required.");
    const source = readString(body, "source");
    await service.joinWaitlist({ email, source });
    // Same answer for new and repeated emails, so the form does not reveal who signed up.
    return c.json({ ok: true }, 202);
  });

  app.get("/v1/agents", async (c) => {
    const agents = await service.listAgentDetails(c.get("orgId"));
    return c.json({ agents });
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
    const founding = sellers.badge(passport.organizationId);
    return c.json({ passport, ...(founding ? { founding } : {}) });
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

  app.get("/v1/registry/listings", (c) => {
    const listings = registry
      .list()
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return c.json({ listings });
  });

  app.post("/v1/registry/seed", (c) => {
    const organizationId = c.get("orgId");
    const samples = sandboxMarketplaceListings();
    let created = 0;
    for (const draft of samples) {
      const exists = registry
        .list()
        .some((listing) => listing.organizationId === organizationId && listing.name === draft.name);
      if (exists) continue;
      registry.register(organizationId, draft);
      created += 1;
    }
    const listings = samples.flatMap((draft) => {
      const match = registry
        .list()
        .find((listing) => listing.organizationId === organizationId && listing.name === draft.name);
      return match ? [match] : [];
    });
    return c.json({ listings }, created > 0 ? 201 : 200);
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
    const slug = listing.data?.slug;
    const dataProduct = slug && data ? data.info(slug) : null;
    const founding = sellers.badge(listing.organizationId);
    const imported = sellers.endpointFor(listing.id);
    return c.json({
      listing,
      ...(dataProduct ? { dataProduct } : {}),
      ...(founding ? { founding } : {}),
      ...(imported ? { proxied: { type: imported.endpoint.type } } : {}),
    });
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
      semantic: c.req.query("semantic"),
      kind: c.req.query("kind"),
    });
    const reputation = await reputationForSearch(registry, service, options.passportScores, query);
    const similarities =
      query.semantic && query.q.trim() !== "" && options.supabase?.matchCapabilities
        ? await options.supabase.matchCapabilities(embedSemantic(query.q), 200)
        : null;
    const hits = registry.search(query, reputation, similarities);
    return c.json({ hits });
  });

  app.put("/v1/jobs/listings/:listingId/seller", async (c) => {
    const sellerAgentId = parseSellerBindingBody(await readJson(c));
    const binding = await orchestrator.bindSeller(c.get("orgId"), c.req.param("listingId"), sellerAgentId);
    return c.json({ binding });
  });

  app.post("/v1/jobs", async (c) => {
    const input = parseCreateJobBody(await readJson(c));
    const result = await orchestrator.createJob(c.get("orgId"), input);
    return c.json(result, 201);
  });

  app.post("/v1/jobs/expire", async (c) => {
    const result = await orchestrator.expireDue(c.get("orgId"));
    return c.json(result);
  });

  app.get("/v1/jobs", async (c) => {
    const result = await orchestrator.listJobs(c.get("orgId"));
    return c.json(result);
  });

  app.get("/v1/jobs/:jobId", async (c) => {
    const result = await orchestrator.getJob(c.get("orgId"), c.req.param("jobId"));
    return c.json(result);
  });

  app.post("/v1/jobs/:jobId/result", async (c) => {
    const input = parseJobResultBody(await readJson(c));
    const result = await orchestrator.submitResult(c.get("orgId"), c.req.param("jobId"), input);
    return c.json(result);
  });

  const optionalOrg = async (headers: Headers): Promise<string | null> => {
    const match = /^Bearer\s+(\S+)$/.exec(headers.get("authorization") ?? "");
    const key = match?.[1];
    if (!key) return null;
    if (looksLikeJwt(key)) {
      const resolved = await organizationForSupabaseToken(service, options.supabase, key);
      return typeof resolved === "string" ? resolved : null;
    }
    return service.authenticate(key);
  };
  registerDataRoutes(app, {
    registry,
    service,
    orchestrator,
    data,
    demand,
    dataStore,
    optionalOrg,
    orgOf: (c) => (c as Context<AppEnv>).get("orgId"),
    ...(options.supabase?.matchCapabilities ? { matchCapabilities: options.supabase.matchCapabilities } : {}),
  });

  registerSellRoutes(app, {
    registry,
    service,
    orchestrator,
    jobs,
    sellers,
    demand,
    fetcher: egress,
    firstParty,
    orgOf: (c) => (c as Context<AppEnv>).get("orgId"),
    allowHttp: options.allowHttpEgress === true,
    ...(options.now ? { now: options.now } : {}),
  });

  registerAdminRoutes(app, adminDeps);
  registerDataAdminRoutes(app, { data, demand });
  registerKycAdminRoutes(app, kycDeps);
  registerKycRoutes(app, kycDeps);
  registerSolanaEscrowRoutes(app, options.solana ?? resolveSolanaEngineConfig());

  app.onError((error, c) => {
    if (error instanceof SolanaFeeError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof ServiceError) {
      const payload = { code: error.code, message: error.message, ...(error.details ?? {}) };
      const body = error.transaction ? { error: payload, transaction: error.transaction } : { error: payload };
      return c.json(body, error.status);
    }
    if (error instanceof RegistryError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    const requestId = c.get("requestId");
    console.error(JSON.stringify({ t: new Date().toISOString(), msg: "unhandled", requestId, path: c.req.path }), error);
    return c.json({ error: { code: "internal", message: "Internal error.", requestId } }, 500);
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}.` } }, 404),
  );

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

const PASSPORT_PATH_RE = /^\/v1\/agents\/[^/]+\/passport$/;
const LISTING_PATH_RE = /^\/v1\/registry\/listings\/[^/]+$/;
const DATA_PRODUCT_PATH_RE = /^\/v1\/data\/products\/[a-z0-9-]+$/;

function isAuthRoute(method: string, path: string): boolean {
  return (
    method === "POST" &&
    (path === "/v1/organizations" ||
      path === "/v1/accounts" ||
      path === "/v1/accounts/anonymous" ||
      path === "/v1/accounts/login" ||
      path === "/v1/accounts/session")
  );
}

function isAnonymousAuthRoute(method: string, path: string): boolean {
  return method === "POST" && path === "/v1/accounts/anonymous";
}

/**
 * Routes that do not need an API key. Discovery and the reputation passport are
 * public reads, as the product brief asks for public reliability metrics.
 */
export function isPublicRoute(method: string, path: string): boolean {
  if (isAuthRoute(method, path)) return true;
  if (method === "POST" && (path === "/v1/waitlist" || path === "/v1/need")) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  return (
    path === "/v1/openapi.json" ||
    path === "/v1/registry/listings" ||
    path === "/v1/registry/search" ||
    LISTING_PATH_RE.test(path) ||
    PASSPORT_PATH_RE.test(path) ||
    KYC_DOCUMENT_TOKEN_RE.test(path) ||
    path === "/v1/founding" ||
    path === "/v1/demand" ||
    path === "/v1/activity" ||
    path === "/v1/data/products" ||
    DATA_PRODUCT_PATH_RE.test(path) ||
    DATA_DOWNLOAD_TOKEN_RE.test(path)
  );
}

function setRateLimitHeaders(c: Context<AppEnv>, decision: RateLimitDecision): void {
  c.header("ratelimit-limit", decision.limit.toString());
  c.header("ratelimit-remaining", decision.remaining.toString());
  c.header("ratelimit-reset", decision.resetS.toString());
}

function rateLimitedResponse(c: Context<AppEnv>, decision: RateLimitDecision): Response {
  setRateLimitHeaders(c, decision);
  c.header("retry-after", decision.resetS.toString());
  return c.json(
    {
      error: {
        code: "rate_limited",
        message: `Too many requests. Retry in ${decision.resetS.toString()} s.`,
      },
    },
    429,
  );
}

function looksLikeJwt(token: string): boolean {
  return token.startsWith("eyJ") && token.split(".").length === 3;
}

async function organizationForSupabaseToken(
  service: AgentFinanceService,
  supabase: AppOptions["supabase"],
  accessToken: string,
): Promise<string | { status: 401 | 503; code: string; message: string }> {
  if (!supabase) {
    return {
      status: 503,
      code: "supabase_unconfigured",
      message:
        "Supabase Auth is not configured on this API. Send a sandbox API key, or set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
    };
  }
  const identity = await supabase.verifyAccessToken(accessToken);
  if (!identity) {
    return { status: 401, code: "unauthorized", message: "Supabase access token was rejected." };
  }
  const orgId = service.authenticateAuthUser(identity.id);
  if (!orgId) {
    return {
      status: 401,
      code: "unauthorized",
      message: "This Supabase user has no Roster organization yet. Call POST /v1/accounts/session first.",
    };
  }
  return orgId;
}

function parseCreateAccount(body: unknown): CreateAccountInput {
  if (!isRecord(body)) throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  const email = body.email;
  const password = body.password;
  if (typeof email !== "string" || typeof password !== "string") {
    throw new ServiceError(400, "invalid_request", "email and password are required.");
  }
  if (body.name !== undefined && body.name !== null && typeof body.name !== "string") {
    throw new ServiceError(400, "invalid_request", "name must be a string.");
  }
  return {
    email,
    password,
    displayName: typeof body.name === "string" ? body.name : null,
  };
}

function parseLogin(body: unknown): { email: string; password: string } {
  if (!isRecord(body)) throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  const email = body.email;
  const password = body.password;
  if (typeof email !== "string" || typeof password !== "string") {
    throw new ServiceError(400, "invalid_request", "email and password are required.");
  }
  return { email, password };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openJobStore(options: AppOptions): JobStore {
  if (options.jobs) return options.jobs;
  const jobsFile = options.jobsFile?.trim();
  if (jobsFile) return JsonJobStore.open(jobsFile);
  return new MemoryJobStore();
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
    ...(options.escrowMode ? { escrowMode: options.escrowMode } : {}),
    ...(options.kycLimits ? { kycLimits: options.kycLimits } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(reputation ? { reputation } : {}),
    ...(store ? { store } : {}),
  });
}
