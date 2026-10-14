import type { Context, Env, Hono } from "hono";
import { compareUsdc, MIN_PAID_LISTING_USDC } from "@albesa/core";
import type { CapabilityListing, CapabilityRegistry } from "@albesa/registry";
import { buyListing, type NeedDeps } from "../need.js";
import type { AgentFinanceService } from "../service.js";
import {
  DEVNET_USDC_MINT,
  encodeHeader,
  isSolanaDevnet,
  parsePaymentHeader,
  type PaymentRequiredBody,
  type PaymentRequirements,
  SOLANA_DEVNET,
  SOLANA_DEVNET_CAIP2,
  type SettlementResponse,
  usdcToMicros,
  X402_VERSION,
  X402Error,
} from "./protocol.js";
import { type SvmSettlementChain, verifyExactSvmTransaction } from "./svm.js";

export const X402_GATEWAY_ORG_NAME = "Roster x402 gateway";
const DUPLICATE_WINDOW_MS = 120_000;
const MAX_TIMEOUT_SECONDS = 120;

export interface X402Config {
  /** Wallet that receives x402 payments (owner of the USDC ATA). */
  payTo: string;
  /** SPL mint. Defaults to Circle Devnet USDC. */
  asset: string;
  /** Settlement adapter. null => the gateway still answers 402 but refuses payments (`settlement_unavailable`). */
  chain: SvmSettlementChain | null;
  /** Public origin used in `resource` URLs, e.g. https://roster.network/roster-api. */
  publicBaseUrl: string | null;
}

export interface X402RouteDeps {
  registry: CapabilityRegistry;
  service: AgentFinanceService;
  orchestrator: NeedDeps["orchestrator"];
  needDeps: NeedDeps;
  config: X402Config;
  now?: () => Date;
  /** Wait for delivery before answering 202 + poll URL. */
  waitMs?: number;
}

export function x402ConfigFromEnv(env: NodeJS.ProcessEnv, chain: SvmSettlementChain | null): X402Config {
  const payTo = env.ROSTER_X402_PAY_TO?.trim() || chain?.feePayer || "";
  return {
    payTo,
    asset: env.ROSTER_X402_ASSET?.trim() || DEVNET_USDC_MINT,
    chain,
    publicBaseUrl: env.ROSTER_PUBLIC_API_URL?.trim().replace(/\/$/, "") || null,
  };
}

function isBuyable(listing: CapabilityListing | null): listing is CapabilityListing {
  if (!listing || listing.status !== "active") return false;
  if (listing.pricing.model === "free") return false;
  return compareUsdc(listing.pricing.amountUsdc, MIN_PAID_LISTING_USDC) >= 0;
}

function resourceUrl(c: Context, config: X402Config, listingId: string): string {
  if (config.publicBaseUrl) return `${config.publicBaseUrl}/x402/listings/${listingId}`;
  const url = new URL(c.req.url);
  return `${url.origin}/x402/listings/${listingId}`;
}

/** Spec-compliant requirements: `exact` on solana-devnet. Amount = listing price (Roster fee 1% + 0.003 is taken from it in escrow). */
export function listingRequirements(listing: CapabilityListing, config: X402Config, resource: string, feePayer: string | null): PaymentRequirements {
  const amount = usdcToMicros(listing.pricing.amountUsdc);
  return {
    scheme: "exact",
    network: SOLANA_DEVNET,
    amount,
    maxAmountRequired: amount,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: Math.min(MAX_TIMEOUT_SECONDS, Math.max(30, Math.ceil(listing.latency.p95Ms / 1000) + 60)),
    resource,
    description: `${listing.name}: ${listing.description}`.slice(0, 300),
    mimeType: "application/json",
    outputSchema: { input: { type: "http", method: "POST", bodyType: "json", bodyFields: listing.inputSchema }, output: listing.outputSchema },
    extra: {
      ...(feePayer ? { feePayer } : {}),
      name: "USDC",
      decimals: 6,
      rosterListingId: listing.id,
      priceUsdc: listing.pricing.amountUsdc,
      rosterFee: "1% + 0.003 USDC, deducted from the price in escrow",
      caip2: SOLANA_DEVNET_CAIP2,
    },
  };
}

function paymentRequired(c: Context, requirement: PaymentRequirements, error: string, reason?: string): Response {
  const body: PaymentRequiredBody & { rosterReason?: string } = {
    x402Version: 1,
    error,
    resource: { url: requirement.resource ?? "", description: requirement.description ?? "", mimeType: "application/json" },
    accepts: [requirement],
    ...(reason ? { rosterReason: reason } : {}),
  };
  const v2: PaymentRequiredBody = {
    x402Version: X402_VERSION,
    error,
    resource: body.resource as { url: string },
    accepts: [{ ...requirement, network: SOLANA_DEVNET_CAIP2 }],
  };
  c.header("PAYMENT-REQUIRED", encodeHeader(v2));
  c.header("Cache-Control", "no-store");
  return c.json(body, 402);
}

export function registerX402Routes<E extends Env>(app: Hono<E>, deps: X402RouteDeps): void {
  const now = deps.now ?? (() => new Date());
  const inflight = new Map<string, number>();
  const settled = new Map<string, number>();
  let gatewayOrg: string | null = null;

  const ensureGatewayOrg = async (): Promise<string> => {
    if (gatewayOrg) return gatewayOrg;
    const orgs = await deps.service.listOrganizations();
    const existing = orgs.filter((org) => org.name === X402_GATEWAY_ORG_NAME).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    gatewayOrg = existing ? existing.id : (await deps.service.createOrganization(X402_GATEWAY_ORG_NAME)).organization.id;
    return gatewayOrg;
  };

  const claim = (key: string): boolean => {
    const at = now().getTime();
    for (const [entry, started] of inflight) if (at - started > DUPLICATE_WINDOW_MS) inflight.delete(entry);
    for (const [entry, done] of settled) if (at - done > 10 * DUPLICATE_WINDOW_MS) settled.delete(entry);
    if (inflight.has(key) || settled.has(key)) return false;
    inflight.set(key, at);
    return true;
  };

  app.get("/x402", (c) =>
    c.json({
      x402Version: X402_VERSION,
      versions: [1, 2],
      schemes: ["exact"],
      networks: [SOLANA_DEVNET, SOLANA_DEVNET_CAIP2],
      asset: deps.config.asset,
      payTo: deps.config.payTo || null,
      feePayer: deps.config.chain?.feePayer ?? null,
      settlement: deps.config.chain ? "roster-facilitator (local verify + fee-payer co-sign on solana-devnet)" : "unavailable",
      resources: "/x402/resources",
      pay: "GET or POST /x402/listings/{listingId} → 402, then retry with X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2)",
      outbound: "POST /v1/listings/import detects x402 endpoints; roster_buy pays exact/solana-devnet requirements",
    }),
  );

  app.get("/x402/resources", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    const feePayer = deps.config.chain?.feePayer ?? null;
    const items = deps.registry
      .list()
      .filter((listing) => isBuyable(listing))
      .slice(0, limit)
      .map((listing) => {
        const resource = resourceUrl(c, deps.config, listing.id);
        return { resource, type: "http", x402Version: 1, accepts: [listingRequirements(listing, deps.config, resource, feePayer)], metadata: { name: listing.name, tags: listing.tags } };
      });
    return c.json({ x402Version: 1, items, pagination: { limit, total: items.length } });
  });

  const handle = async (c: Context): Promise<Response> => {
    const listingId = c.req.param("id") ?? "";
    const listing = deps.registry.get(listingId);
    if (!isBuyable(listing)) return c.json({ error: { code: "not_found", message: "Listing not found, paused or not paid." } }, 404);
    const feePayer = deps.config.chain?.feePayer ?? null;
    const requirement = listingRequirements(listing, deps.config, resourceUrl(c, deps.config, listing.id), feePayer);
    if (!deps.config.payTo) return c.json({ error: { code: "x402_unconfigured", message: "x402 payTo is not configured on this API." } }, 503);

    const header = c.req.header("x-payment") ?? c.req.header("payment-signature");
    if (!header) return paymentRequired(c, requirement, "X-PAYMENT header is required");

    let input: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      try {
        const body: unknown = await c.req.json();
        if (typeof body === "object" && body !== null && !Array.isArray(body)) input = body as Record<string, unknown>;
      } catch {
        return c.json({ error: { code: "invalid_request", message: "Expected a JSON body." } }, 400);
      }
    } else {
      for (const [key, value] of Object.entries(c.req.query())) input[key] = value;
    }

    let txB64: string;
    let payer: string;
    let verified: ReturnType<typeof verifyExactSvmTransaction>;
    let chain: SvmSettlementChain;
    try {
      const payment = parsePaymentHeader(header);
      if (payment.scheme !== "exact" || !isSolanaDevnet(payment.network)) {
        throw new X402Error("unsupported_scheme", "Only scheme exact on solana-devnet is accepted.");
      }
      if (!deps.config.chain || !feePayer) throw new X402Error("settlement_unavailable", "Solana devnet settlement is not configured on this API.");
      const tx = payment.payload.transaction;
      if (typeof tx !== "string" || tx.length === 0) throw new X402Error("invalid_payload", "payload.transaction is required.");
      txB64 = tx;
      chain = deps.config.chain;
      verified = verifyExactSvmTransaction(tx, requirement, feePayer);
      payer = verified.payer;
    } catch (error) {
      if (error instanceof X402Error) return paymentRequired(c, requirement, error.message, error.reason);
      throw error;
    }
    if (!claim(txB64)) return paymentRequired(c, requirement, "Payment already used.", "duplicate_settlement");

    let signature: string;
    try {
      signature = await chain.settle(verified.transaction);
      settled.set(txB64, now().getTime());
    } catch (error) {
      const message = error instanceof Error ? error.message : "settlement failed";
      return paymentRequired(c, requirement, `Settlement failed: ${message}`.slice(0, 300), error instanceof X402Error ? error.reason : "settlement_failed");
    } finally {
      inflight.delete(txB64);
    }
    const settlement: SettlementResponse = { success: true, transaction: signature, network: SOLANA_DEVNET, payer };
    const encoded = encodeHeader(settlement);
    c.header("X-PAYMENT-RESPONSE", encoded);
    c.header("PAYMENT-RESPONSE", encodeHeader({ ...settlement, network: SOLANA_DEVNET_CAIP2 }));
    c.header("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE, PAYMENT-RESPONSE, PAYMENT-REQUIRED");

    // The x402 payment is final; record the purchase as a normal Roster job (escrow, schema check, reputation, activity).
    const org = await ensureGatewayOrg();
    const bought = await buyListing(deps.needDeps, org, {
      listingId: listing.id,
      input: Object.keys(input).length > 0 ? input : null,
      buyerAgentId: null,
      waitMs: deps.waitMs ?? 20_000,
    });
    const x402 = { payer, transaction: signature, network: SOLANA_DEVNET, amount: requirement.amount, asset: requirement.asset, payTo: requirement.payTo };
    const job = { id: bought.job.id, status: bought.status, poll: `/x402/jobs/${bought.job.id}` };
    if (bought.status === "released") return c.json({ delivered: true, result: bought.result, job, receipt: bought.receipt, x402 });
    if (bought.status === "held") return c.json({ delivered: false, result: null, job, receipt: bought.receipt, x402 }, 202);
    return c.json(
      {
        delivered: false,
        result: null,
        job,
        receipt: bought.receipt,
        x402,
        error: { code: "delivery_failed", message: "The seller did not deliver a schema-valid result. Your x402 payment is recorded against this job for refund review." },
      },
      502,
    );
  };

  app.get("/x402/listings/:id", handle);
  app.post("/x402/listings/:id", handle);

  app.get("/x402/jobs/:jobId", async (c) => {
    const org = await ensureGatewayOrg();
    try {
      const { job } = await deps.orchestrator.getJob(org, c.req.param("jobId"));
      return c.json({ job: { id: job.id, status: job.status, listingId: job.listingId }, delivered: job.status === "released", result: job.status === "released" ? job.result : null });
    } catch {
      return c.json({ error: { code: "not_found", message: "Job not found." } }, 404);
    }
  });
}
