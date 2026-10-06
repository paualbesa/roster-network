import type { Context, Env, Hono } from "hono";
import { compareUsdc, EscrowSchemaError, MIN_PAID_LISTING_USDC, parseResultSchema } from "@albesa/core";
import type { CapabilityListing, CapabilityRegistry } from "@albesa/registry";
import type { DemandLog } from "../demand.js";
import type { JobOrchestrator, JobStore } from "../jobs.js";
import { ServiceError, type AgentFinanceService } from "../service.js";
import { buildActivity, isFirstParty, type FirstPartyOrgs } from "./activity.js";
import { buildDemandBoard } from "./demand-board.js";
import { ImportError, importSource, sanitizeTags, type SellerEndpoint } from "./import.js";
import { assertSafeUrl, EgressError, type SafeFetcher } from "./net.js";
import type { SellerDirectory } from "./sellers.js";
import { maskAddress, validatePayoutWallet } from "./wallets.js";

export const SELLER_AGENT_NAME = "Roster seller";
const MAX_PUBLISH = 25;
const IMPORTS_PER_HOUR = 30;

export interface SellRouteDeps {
  registry: CapabilityRegistry;
  service: AgentFinanceService;
  orchestrator: JobOrchestrator;
  jobs: JobStore;
  sellers: SellerDirectory;
  demand: DemandLog;
  fetcher: SafeFetcher;
  firstParty: FirstPartyOrgs;
  orgOf: (c: Context) => string;
  allowHttp?: boolean;
  now?: () => Date;
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ServiceError(400, "invalid_request", "Expected a JSON body.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ServiceError(400, "invalid_request", "Expected a JSON object.");
  return body as Record<string, unknown>;
}

export function registerSellRoutes<E extends Env>(app: Hono<E>, deps: SellRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  const importHits = new Map<string, number[]>();

  app.post("/v1/listings/import", async (c) => {
    const org = deps.orgOf(c);
    const cutoff = now().getTime() - 3_600_000;
    const hits = (importHits.get(org) ?? []).filter((at) => at > cutoff);
    if (hits.length >= IMPORTS_PER_HOUR) throw new ServiceError(429, "rate_limited", `At most ${IMPORTS_PER_HOUR.toString()} imports per hour.`);
    importHits.set(org, [...hits, now().getTime()]);
    const body = await readBody(c);
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new ServiceError(400, "invalid_request", "url is required.");
    const kind = body.kind === "mcp" || body.kind === "openapi" ? body.kind : "auto";
    try {
      const result = await importSource(url, { fetcher: deps.fetcher, registry: deps.registry, allowHttp: deps.allowHttp === true }, kind);
      return c.json({ ...result, founding: foundingFor(deps, org) });
    } catch (error) {
      if (error instanceof ImportError) throw new ServiceError(error.status, error.code, error.message);
      throw error;
    }
  });

  app.post("/v1/listings/publish", async (c) => {
    const org = deps.orgOf(c);
    if (isFirstParty(org, deps.firstParty)) throw new ServiceError(403, "forbidden", "First-party organizations publish through the fleet bootstrap.");
    const body = await readBody(c);
    const rawListings = Array.isArray(body.listings) ? body.listings : [];
    if (rawListings.length === 0 || rawListings.length > MAX_PUBLISH) {
      throw new ServiceError(400, "invalid_request", `listings must hold 1 to ${MAX_PUBLISH.toString()} items.`);
    }
    const existingProfile = deps.sellers.profile(org);
    let payout = existingProfile?.payout ?? null;
    if (body.payout !== undefined && body.payout !== null) {
      const checked = validatePayoutWallet(body.payout);
      if (!checked.ok) throw new ServiceError(400, "invalid_payout", checked.message);
      payout = checked.wallet;
    }
    if (!payout) throw new ServiceError(400, "invalid_payout", "Connect a payout wallet (Solana or Base address) before publishing.");
    const parsed = rawListings.map((raw, index) => parsePublishItem(raw, index, deps.allowHttp === true));
    const agentId = await ensureSellerAgent(deps.service, org);
    await deps.sellers.init();
    const published: CapabilityListing[] = [];
    for (const item of parsed) {
      const listing = deps.registry.register(org, {
        name: item.name,
        description: item.description,
        inputSchema: item.inputSchema,
        outputSchema: item.outputSchema,
        pricing: { model: "per_call", amountUsdc: item.priceUsdc },
        latency: { p95Ms: item.p95Ms, p50Ms: null },
        tags: item.tags,
        kind: "service",
      });
      try {
        await deps.sellers.saveEndpoint({
          listingId: listing.id,
          organizationId: org,
          endpoint: item.endpoint,
          source: { type: item.endpoint.type, url: item.sourceUrl ?? item.endpoint.url },
          createdAt: now().toISOString(),
        });
        await deps.orchestrator.bindSeller(org, listing.id, agentId, { autofill: true });
      } catch (error) {
        deps.registry.update(org, listing.id, { status: "paused" });
        throw error;
      }
      published.push(deps.registry.get(listing.id) ?? listing);
    }
    const profile = await deps.sellers.upsertProfile(org, { payout, enrolFounding: true });
    return c.json(
      {
        listings: published,
        sellerAgentId: agentId,
        payout: { chain: payout.chain, address: payout.address },
        founding: deps.sellers.badge(org),
        takeRateBps: deps.sellers.takeRateBpsFor(org) ?? 100,
        profileCreatedAt: profile.createdAt,
      },
      201,
    );
  });

  app.get("/v1/sellers/me", async (c) => {
    const org = deps.orgOf(c);
    await deps.sellers.init();
    const profile = deps.sellers.profile(org);
    const endpoints = new Map(deps.sellers.endpointsFor(org).map((record) => [record.listingId, record]));
    const listings = deps.registry.list().filter((listing) => listing.organizationId === org);
    const { jobs } = await deps.orchestrator.listJobs(org);
    const sold = jobs.filter((job) => job.sellerOrganizationId === org);
    const stats = new Map<string, { calls: number; released: number; refunded: number; held: number; earnedMicros: bigint; latency: number[] }>();
    for (const job of sold) {
      const entry = stats.get(job.listingId) ?? { calls: 0, released: 0, refunded: 0, held: 0, earnedMicros: 0n, latency: [] };
      entry.calls += 1;
      if (job.status === "released") {
        entry.released += 1;
        entry.earnedMicros += micros(job.sellerNetUsdc);
        if (job.latencyMs !== null) entry.latency.push(job.latencyMs);
      } else if (job.status === "held") entry.held += 1;
      else entry.refunded += 1;
      stats.set(job.listingId, entry);
    }
    let earned = 0n;
    let calls = 0;
    let released = 0;
    const rows = listings.map((listing) => {
      const entry = stats.get(listing.id) ?? { calls: 0, released: 0, refunded: 0, held: 0, earnedMicros: 0n, latency: [] };
      earned += entry.earnedMicros;
      calls += entry.calls;
      released += entry.released;
      const record = endpoints.get(listing.id);
      return {
        id: listing.id,
        name: listing.name,
        status: listing.status,
        priceUsdc: listing.pricing.amountUsdc,
        p95Ms: listing.latency.p95Ms,
        endpoint: record ? { type: record.endpoint.type, host: safeHost(record.endpoint.url) } : null,
        calls: entry.calls,
        released: entry.released,
        refunded: entry.refunded,
        held: entry.held,
        earningsUsdc: usdc(entry.earnedMicros),
        avgLatencyMs: entry.latency.length > 0 ? Math.round(entry.latency.reduce((a, b) => a + b, 0) / entry.latency.length) : null,
      };
    });
    const recent = sold.slice(0, 20).map((job) => ({
      id: job.id,
      listingName: job.listingName,
      status: job.status,
      amountUsdc: job.amountUsdc,
      sellerNetUsdc: job.status === "released" ? job.sellerNetUsdc : "0.000000",
      takeRateUsdc: job.status === "released" ? job.takeRateUsdc : "0.000000",
      latencyMs: job.latencyMs,
      at: job.settledAt ?? job.createdAt,
    }));
    return c.json({
      sandbox: true,
      profile: profile
        ? { payout: profile.payout ? { chain: profile.payout.chain, address: profile.payout.address, masked: maskAddress(profile.payout.address) } : null, createdAt: profile.createdAt }
        : null,
      founding: deps.sellers.badge(org),
      takeRateBps: deps.sellers.takeRateBpsFor(org) ?? 100,
      totals: { listings: rows.length, calls, released, earningsUsdc: usdc(earned), pendingPayoutUsdc: usdc(earned) },
      payoutNote: "Sandbox: earnings are mock USDC. Payouts to your wallet are not sent until mainnet launches.",
      listings: rows,
      recent,
    });
  });

  app.put("/v1/sellers/me/payout", async (c) => {
    const org = deps.orgOf(c);
    const body = await readBody(c);
    const checked = validatePayoutWallet(body.payout ?? body);
    if (!checked.ok) throw new ServiceError(400, "invalid_payout", checked.message);
    const profile = await deps.sellers.upsertProfile(org, { payout: checked.wallet });
    return c.json({ payout: profile.payout });
  });

  app.get("/v1/founding", async (c) => {
    await deps.sellers.init();
    c.header("cache-control", "public, max-age=30");
    return c.json({ program: "founding_sellers", ...deps.sellers.foundingSummary(), defaultTakeRateBps: 100 });
  });

  app.get("/v1/demand", async (c) => {
    const needs = await deps.demand.list(2000);
    const board = buildDemandBoard(needs, { registry: deps.registry, now: now(), limit: clampInt(c.req.query("limit"), 1, 200, 60) });
    c.header("cache-control", "public, max-age=60");
    return c.json({
      sandbox: true,
      notice: "Real requests agents sent to Roster that no listing served well. Estimated earnings = requests × suggested price; an estimate, not a sale.",
      ...board,
      generatedAt: now().toISOString(),
    });
  });

  app.get("/v1/activity", async (c) => {
    await deps.sellers.init();
    const organizations = await deps.service.listOrganizations();
    const orgNames = new Map(organizations.map((organization) => [organization.id, organization.name]));
    const activity = await buildActivity({
      jobs: deps.jobs,
      registry: deps.registry,
      service: deps.service,
      sellers: deps.sellers,
      firstParty: deps.firstParty,
      orgNames,
      now: now(),
      limit: clampInt(c.req.query("limit"), 1, 100, 40),
    });
    c.header("cache-control", "public, max-age=10");
    return c.json({ ...activity, generatedAt: now().toISOString() });
  });
}

function foundingFor(deps: SellRouteDeps, org: string) {
  const summary = deps.sellers.foundingSummary();
  const badge = deps.sellers.badge(org);
  return { ...summary, eligible: !badge && summary.remaining > 0 && !isFirstParty(org, deps.firstParty), badge };
}

interface PublishItem {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  priceUsdc: string;
  p95Ms: number;
  tags: string[];
  endpoint: SellerEndpoint;
  sourceUrl: string | null;
}

function parsePublishItem(raw: unknown, index: number, allowHttp: boolean): PublishItem {
  const at = `listings[${index.toString()}]`;
  if (typeof raw !== "object" || raw === null) throw new ServiceError(400, "invalid_request", `${at} must be an object.`);
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const description = typeof item.description === "string" ? item.description.trim() : "";
  if (!name || name.length > 80) throw new ServiceError(400, "invalid_request", `${at}.name must be 1-80 characters.`);
  if (!description || description.length > 4000) throw new ServiceError(400, "invalid_request", `${at}.description must be 1-4000 characters.`);
  const priceUsdc = typeof item.priceUsdc === "string" ? item.priceUsdc.trim() : typeof item.priceUsdc === "number" ? item.priceUsdc.toString() : "";
  if (!/^\d+(\.\d{1,6})?$/.test(priceUsdc) || compareUsdc(priceUsdc, MIN_PAID_LISTING_USDC) < 0 || compareUsdc(priceUsdc, "100") > 0) {
    throw new ServiceError(400, "invalid_request", `${at}.priceUsdc must be between ${MIN_PAID_LISTING_USDC} and 100 USDC.`);
  }
  const p95Ms = Number(item.p95Ms);
  if (!Number.isInteger(p95Ms) || p95Ms < 1000 || p95Ms > 60_000) throw new ServiceError(400, "invalid_request", `${at}.p95Ms must be an integer from 1000 to 60000.`);
  if (typeof item.inputSchema !== "object" || item.inputSchema === null || Array.isArray(item.inputSchema)) {
    throw new ServiceError(400, "invalid_request", `${at}.inputSchema must be a JSON Schema object.`);
  }
  try {
    parseResultSchema(item.outputSchema);
  } catch (error) {
    if (error instanceof EscrowSchemaError) throw new ServiceError(400, "invalid_schema", `${at}.outputSchema: ${error.message}`);
    throw error;
  }
  const endpoint = parseEndpoint(item.endpoint, at, allowHttp);
  const tags = sanitizeTags(Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : []);
  const sourceUrl = typeof item.sourceUrl === "string" && item.sourceUrl.length <= 2048 ? item.sourceUrl : null;
  return { name, description, inputSchema: item.inputSchema as Record<string, unknown>, outputSchema: item.outputSchema as Record<string, unknown>, priceUsdc, p95Ms, tags, endpoint, sourceUrl };
}

function parseEndpoint(raw: unknown, at: string, allowHttp: boolean): SellerEndpoint {
  if (typeof raw !== "object" || raw === null) throw new ServiceError(400, "invalid_request", `${at}.endpoint is required (from the import step).`);
  const value = raw as Record<string, unknown>;
  const url = typeof value.url === "string" ? value.url : "";
  const check = value.type === "openapi" ? url.replace(/\{[^}]+\}/g, "x") : url;
  try {
    assertSafeUrl(check, { allowHttp });
  } catch (error) {
    if (error instanceof EgressError) throw new ServiceError(400, error.code, `${at}.endpoint.url: ${error.message}`);
    throw error;
  }
  if (value.type === "mcp") {
    if (typeof value.toolName !== "string" || value.toolName.length === 0 || value.toolName.length > 128) {
      throw new ServiceError(400, "invalid_request", `${at}.endpoint.toolName is required.`);
    }
    return { type: "mcp", url, toolName: value.toolName, structured: value.structured === true };
  }
  if (value.type === "openapi") {
    const method = typeof value.method === "string" ? value.method.toUpperCase() : "";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new ServiceError(400, "invalid_request", `${at}.endpoint.method is invalid.`);
    const params = Array.isArray(value.params)
      ? value.params.slice(0, 40).flatMap((param) => {
          if (typeof param !== "object" || param === null) return [];
          const { name, in: where } = param as { name?: unknown; in?: unknown };
          return typeof name === "string" && name.length <= 128 && (where === "path" || where === "query") ? [{ name, in: where as "path" | "query" }] : [];
        })
      : [];
    return { type: "openapi", url, method: method as "GET", params, hasBody: value.hasBody === true };
  }
  throw new ServiceError(400, "invalid_request", `${at}.endpoint.type must be "mcp" or "openapi".`);
}

async function ensureSellerAgent(service: AgentFinanceService, org: string): Promise<string> {
  const agents = await service.listAgents(org);
  const existing = agents
    .filter((agent) => agent.name === SELLER_AGENT_NAME && agent.status === "active")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (existing) return existing.id;
  const created = await service.createAgent(org, { name: SELLER_AGENT_NAME, dailySpendLimitUsdc: "10.00", vendorAllowlist: [] });
  return created.agent.id;
}

function safeHost(url: string): string {
  try {
    return new URL(url.replace(/\{[^}]+\}/g, "x")).host;
  } catch {
    return "";
  }
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function micros(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

function usdc(value: bigint): string {
  return `${(value / 1_000_000n).toString()}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}
