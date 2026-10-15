import { Keypair, type VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { bootstrapSandboxFleet } from "./fleet.js";
import type { SafeFetchOptions, SafeResponse } from "./sell/net.js";
import {
  decodeHeader,
  DEVNET_USDC_MINT,
  encodeHeader,
  normalizeNetwork,
  parsePaymentHeader,
  parsePaymentRequired,
  type PaymentRequirements,
  SOLANA_DEVNET_CAIP2,
  usdcToMicros,
  microsToUsdc,
} from "./x402/protocol.js";
import { DevnetX402Payer } from "./x402/outbound.js";
import { buildExactSvmPayment, type SvmSettlementChain, verifyExactSvmTransaction } from "./x402/svm.js";
import { X402_GATEWAY_ORG_NAME } from "./x402/routes.js";

const blockhash = () => Keypair.generate().publicKey.toBase58();

class FakeChain implements SvmSettlementChain {
  readonly network = "solana-devnet";
  readonly settled: VersionedTransaction[] = [];
  constructor(private readonly keypair = Keypair.generate()) {}
  get feePayer() {
    return this.keypair.publicKey.toBase58();
  }
  async settle(tx: VersionedTransaction): Promise<string> {
    tx.sign([this.keypair]);
    this.settled.push(tx);
    return Buffer.from(tx.signatures[0]!).toString("hex");
  }
}

function requirement(overrides: Partial<PaymentRequirements> = {}, feePayer = Keypair.generate().publicKey.toBase58()): PaymentRequirements {
  return {
    scheme: "exact",
    network: "solana-devnet",
    amount: "20000",
    asset: DEVNET_USDC_MINT,
    payTo: Keypair.generate().publicKey.toBase58(),
    maxTimeoutSeconds: 60,
    extra: { feePayer },
    ...overrides,
  };
}

function paymentHeader(txB64: string, network = "solana-devnet"): string {
  return encodeHeader({ x402Version: 1, scheme: "exact", network, payload: { transaction: txB64 } });
}

describe("x402 protocol", () => {
  it("normalizes networks and converts amounts", () => {
    expect(normalizeNetwork(SOLANA_DEVNET_CAIP2)).toBe("solana-devnet");
    expect(normalizeNetwork("eip155:8453")).toBe("base");
    expect(normalizeNetwork("Base-Sepolia")).toBe("base-sepolia");
    expect(usdcToMicros("0.010000")).toBe("10000");
    expect(usdcToMicros("1.5")).toBe("1500000");
    expect(microsToUsdc("13000")).toBe("0.013000");
  });

  it("parses v1 bodies and v2 PAYMENT-REQUIRED headers", () => {
    const v1 = parsePaymentRequired({}, JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "100", asset: "0xabc", payTo: "0xdef" }] }));
    expect(v1?.accepts[0]).toMatchObject({ amount: "100", network: "base" });
    const v2 = parsePaymentRequired(
      { "payment-required": encodeHeader({ x402Version: 2, accepts: [{ scheme: "exact", network: SOLANA_DEVNET_CAIP2, amount: "5", asset: DEVNET_USDC_MINT, payTo: "X" }] }) },
      "",
    );
    expect(v2?.x402Version).toBe(2);
    expect(v2?.accepts[0]?.amount).toBe("5");
    expect(parsePaymentRequired({}, "{\"error\":\"nope\"}")).toBeNull();
    expect(parsePaymentRequired({}, "not json")).toBeNull();
  });

  it("parses payment headers (v1 + v2) and rejects junk", () => {
    expect(parsePaymentHeader(paymentHeader("AAAA")).network).toBe("solana-devnet");
    const v2 = encodeHeader({ x402Version: 2, accepted: { scheme: "exact", network: SOLANA_DEVNET_CAIP2 }, payload: { transaction: "AAAA" } });
    expect(parsePaymentHeader(v2)).toMatchObject({ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET_CAIP2 });
    expect(() => parsePaymentHeader("%%%")).toThrow();
    expect(() => parsePaymentHeader(encodeHeader({ scheme: "exact" }))).toThrow();
    expect(decodeHeader(encodeHeader({ a: 1 }))).toEqual({ a: 1 });
  });
});

describe("exact SVM verification", () => {
  const facilitator = Keypair.generate();
  const fp = facilitator.publicKey.toBase58();

  it("accepts a well-formed client payment", () => {
    const payer = Keypair.generate();
    const req = requirement({}, fp);
    const tx = buildExactSvmPayment({ requirement: req, payer, recentBlockhash: blockhash() });
    const verified = verifyExactSvmTransaction(tx, req, fp);
    expect(verified.payer).toBe(payer.publicKey.toBase58());
    expect(verified.amount).toBe("20000");
    expect(verified.memo).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects wrong amount, recipient, asset, fee payer and memo", () => {
    const payer = Keypair.generate();
    const req = requirement({ extra: { feePayer: fp, memo: "inv-1" } }, fp);
    const good = buildExactSvmPayment({ requirement: req, payer, recentBlockhash: blockhash() });
    expect(verifyExactSvmTransaction(good, req, fp).memo).toBe("inv-1");
    expect(() => verifyExactSvmTransaction(good, { ...req, amount: "20001" }, fp)).toThrow(/amount/i);
    expect(() => verifyExactSvmTransaction(good, { ...req, payTo: Keypair.generate().publicKey.toBase58() }, fp)).toThrow(/destination/i);
    expect(() => verifyExactSvmTransaction(good, { ...req, asset: Keypair.generate().publicKey.toBase58() }, fp)).toThrow(/mint/i);
    expect(() => verifyExactSvmTransaction(good, req, Keypair.generate().publicKey.toBase58())).toThrow(/fee payer/i);
    expect(() => verifyExactSvmTransaction(good, { ...req, extra: { feePayer: fp, memo: "other" } }, fp)).toThrow(/memo/i);
    // Fee payer as the transfer authority: client sets feePayer == its own key.
    const selfPay = buildExactSvmPayment({ requirement: { ...req, extra: { feePayer: payer.publicKey.toBase58() } }, payer, recentBlockhash: blockhash() });
    expect(() => verifyExactSvmTransaction(selfPay, req, payer.publicKey.toBase58())).toThrow(/fee payer/i);
    expect(() => verifyExactSvmTransaction("bm90IGEgdHg=", req, fp)).toThrow(/serialized/);
  });

  it("rejects an unsigned transfer", async () => {
    const payer = Keypair.generate();
    const req = requirement({}, fp);
    const tx = buildExactSvmPayment({ requirement: req, payer, recentBlockhash: blockhash() });
    const { VersionedTransaction } = await import("@solana/web3.js");
    const decoded = VersionedTransaction.deserialize(Buffer.from(tx, "base64"));
    decoded.signatures[1] = new Uint8Array(64);
    expect(() => verifyExactSvmTransaction(Buffer.from(decoded.serialize()).toString("base64"), req, fp)).toThrow(/not signed/);
  });
});

async function listingWithPrice(app: ReturnType<typeof createApp>): Promise<{ id: string; pricing: { amountUsdc: string } }> {
  const res = (await (await app.request("/v1/registry/listings")).json()) as { listings: { id: string; name: string; status: string; pricing: { model: string; amountUsdc: string } }[] };
  const listing = res.listings.find((item) => item.status === "active" && item.pricing.model !== "free" && Number(item.pricing.amountUsdc) >= 0.01);
  if (!listing) throw new Error("no fleet listing");
  return listing;
}

describe("x402 inbound gateway (local e2e, mocked chain)", () => {
  it("answers 402, verifies + settles X-PAYMENT, records a normal Roster job, and refuses replays", async () => {
    const chain = new FakeChain();
    const payTo = Keypair.generate().publicKey.toBase58();
    const app = createApp({ mode: "sandbox", autofill: "sync", dataCatalog: null, dataStore: null, x402: { payTo, asset: DEVNET_USDC_MINT, chain, publicBaseUrl: "https://roster.test/roster-api" } });
    await bootstrapSandboxFleet(app);
    const listing = await listingWithPrice(app);

    const info = (await (await app.request("/x402")).json()) as { networks: string[]; payTo: string; feePayer: string };
    expect(info.networks).toContain("solana-devnet");
    expect(info.feePayer).toBe(chain.feePayer);

    const first = await app.request(`/x402/listings/${listing.id}`);
    expect(first.status).toBe(402);
    const body = (await first.json()) as { x402Version: number; accepts: PaymentRequirements[] };
    expect(body.x402Version).toBe(1);
    const req = body.accepts[0]!;
    expect(req).toMatchObject({ scheme: "exact", network: "solana-devnet", payTo, asset: DEVNET_USDC_MINT, resource: `https://roster.test/roster-api/x402/listings/${listing.id}` });
    expect(req.amount).toBe(usdcToMicros(listing.pricing.amountUsdc));
    expect(req.maxAmountRequired).toBe(req.amount);
    expect(req.extra?.feePayer).toBe(chain.feePayer);
    const v2 = decodeHeader(first.headers.get("payment-required") ?? "") as { x402Version: number; accepts: PaymentRequirements[] };
    expect(v2.x402Version).toBe(2);
    expect(v2.accepts[0]?.network).toBe(SOLANA_DEVNET_CAIP2);

    const resources = (await (await app.request("/x402/resources")).json()) as { items: { resource: string }[] };
    expect(resources.items.some((item) => item.resource.endsWith(listing.id))).toBe(true);

    // Wrong amount → 402 with a reason, nothing settled.
    const agent = Keypair.generate();
    const cheap = buildExactSvmPayment({ requirement: { ...req, amount: "1" }, payer: agent, recentBlockhash: blockhash() });
    const bad = await app.request(`/x402/listings/${listing.id}`, { headers: { "X-PAYMENT": paymentHeader(cheap) } });
    expect(bad.status).toBe(402);
    expect(((await bad.json()) as { rosterReason: string }).rosterReason).toMatch(/amount_mismatch/);
    expect(chain.settled).toHaveLength(0);

    // Unsupported network.
    const base = await app.request(`/x402/listings/${listing.id}`, { headers: { "X-PAYMENT": paymentHeader("AAAA", "base") } });
    expect(base.status).toBe(402);

    const tx = buildExactSvmPayment({ requirement: req, payer: agent, recentBlockhash: blockhash() });
    const paid = await app.request(`/x402/listings/${listing.id}`, { headers: { "X-PAYMENT": paymentHeader(tx) } });
    expect(paid.status).toBe(200);
    const result = (await paid.json()) as { delivered: boolean; job: { id: string; status: string }; x402: { payer: string } };
    expect(result.delivered).toBe(true);
    expect(result.job.status).toBe("released");
    expect(result.x402.payer).toBe(agent.publicKey.toBase58());
    const settlement = decodeHeader(paid.headers.get("x-payment-response") ?? "") as { success: boolean; transaction: string; payer: string };
    expect(settlement.success).toBe(true);
    expect(settlement.transaction.length).toBeGreaterThan(40);
    expect(chain.settled).toHaveLength(1);

    const replay = await app.request(`/x402/listings/${listing.id}`, { headers: { "X-PAYMENT": paymentHeader(tx) } });
    expect(replay.status).toBe(402);
    expect(((await replay.json()) as { rosterReason: string }).rosterReason).toBe("duplicate_settlement");
    expect(chain.settled).toHaveLength(1);

    const poll = (await (await app.request(`/x402/jobs/${result.job.id}`)).json()) as { delivered: boolean };
    expect(poll.delivered).toBe(true);

    // v2 header name works too.
    const tx2 = buildExactSvmPayment({ requirement: req, payer: agent, recentBlockhash: blockhash() });
    const paid2 = await app.request(`/x402/listings/${listing.id}`, { method: "POST", headers: { "PAYMENT-SIGNATURE": paymentHeader(tx2, SOLANA_DEVNET_CAIP2), "content-type": "application/json" }, body: "{}" });
    expect(paid2.status).toBe(200);

    const activity = (await (await app.request("/v1/activity")).json()) as { items: { status: string }[] };
    expect(activity.items.filter((item) => item.status === "released").length).toBeGreaterThanOrEqual(2);
    expect(X402_GATEWAY_ORG_NAME).toBe("Roster x402 gateway");

    expect((await app.request("/x402/listings/nope")).status).toBe(404);
  }, 60_000);

  it("refuses payment when no settlement chain is configured", async () => {
    const app = createApp({ mode: "sandbox", autofill: "sync", dataCatalog: null, dataStore: null, x402: { payTo: Keypair.generate().publicKey.toBase58(), asset: DEVNET_USDC_MINT, chain: null, publicBaseUrl: null } });
    await bootstrapSandboxFleet(app);
    const listing = await listingWithPrice(app);
    const res = await app.request(`/x402/listings/${listing.id}`, { headers: { "X-PAYMENT": paymentHeader("AAAA") } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { rosterReason: string }).rosterReason).toBe("settlement_unavailable");
  }, 30_000);
});

// ---- outbound ----
const X402_SOL_URL = "https://x402.seller.example/weather";
const X402_BASE_URL = "https://x402.base.example/quote";

function res(body: string, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): SafeResponse {
  return { status, headers, body, url: "", elapsedMs: 1 };
}

function x402Upstream(state: { paid: string[]; facilitator: Keypair; payTo: string }) {
  const solReq: PaymentRequirements = {
    scheme: "exact",
    network: SOLANA_DEVNET_CAIP2,
    amount: "15000",
    asset: DEVNET_USDC_MINT,
    payTo: state.payTo,
    maxTimeoutSeconds: 30,
    description: "Weather now",
    extra: { feePayer: state.facilitator.publicKey.toBase58() },
  };
  return async (url: string, options: SafeFetchOptions = {}): Promise<SafeResponse> => {
    const headers = (options.headers ?? {}) as Record<string, string>;
    if (url.startsWith(X402_SOL_URL)) {
      const payment = headers["x-payment"];
      if (!payment) return res(JSON.stringify({ x402Version: 2, error: "payment required", accepts: [solReq] }), 402);
      const parsed = parsePaymentHeader(payment);
      verifyExactSvmTransaction(String(parsed.payload.transaction), solReq, state.facilitator.publicKey.toBase58());
      state.paid.push(String(parsed.payload.transaction));
      return res(JSON.stringify({ tempC: 21 }));
    }
    if (url.startsWith(X402_BASE_URL)) {
      return res(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 30 }] }), 402);
    }
    return res("not found", 404);
  };
}

async function signup(app: ReturnType<typeof createApp>): Promise<string> {
  const r = await app.request("/v1/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `x-${Math.random().toString(36).slice(2)}@example.com`, password: "password-123456" }) });
  return ((await r.json()) as { apiKey: string }).apiKey;
}
const post = (app: ReturnType<typeof createApp>, path: string, key: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

describe("x402 outbound import + buy (mocked upstream)", () => {
  it("imports a solana-devnet x402 endpoint, and roster buy pays it with a verifiable exact payment", async () => {
    const state = { paid: [] as string[], facilitator: Keypair.generate(), payTo: Keypair.generate().publicKey.toBase58() };
    const payer = new DevnetX402Payer(Keypair.generate(), null, async () => blockhash());
    const app = createApp({ mode: "sandbox", autofill: "sync", dataCatalog: null, dataStore: null, egressFetcher: x402Upstream(state), x402Payer: payer, x402: null });
    await bootstrapSandboxFleet(app);
    const seller = await signup(app);
    const imported = (await (await post(app, "/v1/listings/import", seller, { url: X402_SOL_URL })).json()) as { drafts: Record<string, unknown>[] };
    const draft = imported.drafts[0]!;
    expect(draft.endpoint).toMatchObject({ type: "x402", supported: true, method: "GET" });
    expect(draft.tags).toContain("x402");
    expect(draft.suggestedPriceUsdc).toBe("0.015000");

    const publish = await post(app, "/v1/listings/publish", seller, { listings: [{ ...draft, priceUsdc: "0.02" }], payout: { chain: "solana", address: state.payTo } });
    expect(publish.status).toBe(201);
    const listingId = ((await publish.json()) as { listings: { id: string }[] }).listings[0]!.id;
    const pub = (await (await app.request(`/v1/registry/listings/${listingId}`)).json()) as { proxied: { type: string; supported: boolean } };
    expect(pub.proxied).toMatchObject({ type: "x402", supported: true });

    const buyer = await signup(app);
    const bought = (await (await post(app, "/v1/need/buy", buyer, { listingId, input: {} })).json()) as { status: string; result: { data: { tempC: number } } };
    expect(bought.status).toBe("released");
    expect(bought.result.data.tempC).toBe(21);
    expect(state.paid).toHaveLength(1);
  }, 30_000);

  it("marks non-solana-devnet x402 endpoints as unsupported and refunds instead of paying", async () => {
    const state = { paid: [] as string[], facilitator: Keypair.generate(), payTo: Keypair.generate().publicKey.toBase58() };
    const payer = new DevnetX402Payer(Keypair.generate(), null, async () => blockhash());
    const app = createApp({ mode: "sandbox", autofill: "sync", dataCatalog: null, dataStore: null, egressFetcher: x402Upstream(state), x402Payer: payer, x402: null });
    await bootstrapSandboxFleet(app);
    const seller = await signup(app);
    const imported = (await (await post(app, "/v1/listings/import", seller, { url: X402_BASE_URL, kind: "x402" })).json()) as { drafts: Record<string, unknown>[] };
    const draft = imported.drafts[0]!;
    expect(draft.endpoint).toMatchObject({ type: "x402", supported: false, network: "base" });
    expect(String(draft.priceBasis)).toContain("x402 external, unsupported network");
    const publish = await post(app, "/v1/listings/publish", seller, { listings: [{ ...draft, priceUsdc: "0.02" }], payout: { chain: "solana", address: state.payTo } });
    const listingId = ((await publish.json()) as { listings: { id: string }[] }).listings[0]!.id;
    const pub = (await (await app.request(`/v1/registry/listings/${listingId}`)).json()) as { proxied: { status: string } };
    expect(pub.proxied.status).toBe("x402 external, unsupported network");
    const buyer = await signup(app);
    const bought = (await (await post(app, "/v1/need/buy", buyer, { listingId, input: {} })).json()) as { status: string };
    expect(bought.status).toBe("refunded");
    expect(state.paid).toHaveLength(0);

    const notX402 = await post(app, "/v1/listings/import", seller, { url: "https://x402.seller.example/../nothing", kind: "x402" });
    expect(notX402.status).toBe(422);
  }, 30_000);
});
