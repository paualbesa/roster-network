import { bootstrapSandboxFleet, createApp } from "@albesa/api";
import { describe, expect, it } from "vitest";
import { Albesa, AlbesaError, createSandboxAccount, createSandboxOrganization, loginSandboxAccount } from "./index.js";

describe("Albesa SDK", () => {
  it("signs up a sandbox account and reads the treasury through the client", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const { client, organizationId } = await createSandboxAccount({
      email: "ada@example.com",
      password: "sandbox-passphrase-9",
      name: "Ada",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });
    const treasury = await client.treasury.get();
    expect(organizationId.startsWith("org_")).toBe(true);
    expect(treasury.balanceUsdc).toBe("1000.000000");
    expect(treasury.asset).toBe("USDC");

    const again = await loginSandboxAccount({
      email: "ada@example.com",
      password: "sandbox-passphrase-9",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });
    expect((await again.client.treasury.get()).balanceUsdc).toBe("1000.000000");
  });

  it("runs the hello payment against the in-process API", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const { apiKey } = await createSandboxOrganization({
      name: "Acme",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });

    const albesa = new Albesa({ apiKey, baseUrl: "http://albesa.test", fetch: fetchImpl });
    const agent = await albesa.agents.create({
      name: "buyer",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: ["vendor_data"],
    });
    await albesa.agents.fund(agent.id, "5.00");
    const payment = await albesa.agents.pay(agent.id, { vendorId: "vendor_data", amountUsdc: "0.15" });

    expect(agent.address.startsWith("mock:agent:")).toBe(true);
    expect(payment.status).toBe("settled");
    expect(payment.amountUsdc).toBe("0.150000");
    expect(payment.balanceUsdc).toBe("4.838500");

    await expect(
      albesa.agents.pay(agent.id, { vendorId: "vendor_other", amountUsdc: "0.10" }),
    ).rejects.toBeInstanceOf(AlbesaError);
  });

  it("records a reputation event and reads the passport score", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const { client } = await createSandboxOrganization({
      name: "Acme",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });
    const agent = await client.agents.create({
      name: "seller",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: ["vendor_data"],
    });
    const passport = await client.reputation.recordEvent(agent.id, {
      outcome: "success",
      latencyMs: 500,
      volumeUsdc: "100",
    });
    expect(passport.score).toBe("84.7500");
    const read = await client.reputation.passport(agent.id);
    expect(read.score).toBe("84.7500");
    expect(read.metrics.volumeSettledUsdc).toBe("100.000000");
  });

  it("settles a schema-valid escrow and refunds a schema failure", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const { client } = await createSandboxOrganization({
      name: "Acme",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });
    const buyer = await client.agents.create({
      name: "buyer",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    const seller = await client.agents.create({
      name: "seller",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    await client.agents.fund(buyer.id, "3.00");
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["rows"],
      properties: { rows: { type: "integer", minimum: 1 } },
    };

    const held = await client.escrows.create({
      buyerAgentId: buyer.id,
      sellerAgentId: seller.id,
      amountUsdc: "1.00",
      schema,
    });
    expect(held.status).toBe("held");
    expect(held.buyerBalanceUsdc).toBe("2.000000");

    const released = await client.escrows.submit(held.id, { rows: 2 });
    expect(released.status).toBe("released");
    expect(released.sellerNetUsdc).toBe("0.990000");
    expect(released.sellerBalanceUsdc).toBe("0.990000");

    const refundHold = await client.escrows.create({
      buyerAgentId: buyer.id,
      sellerAgentId: seller.id,
      amountUsdc: "1.00",
      schema,
    });
    const refunded = await client.escrows.submit(refundHold.id, { rows: 0 });
    expect(refunded.status).toBe("refunded");
    expect(refunded.validationErrors).toEqual(["result.rows: expected >= 1."]);
    expect(refunded.buyerBalanceUsdc).toBe("2.000000");
  });

  it("registers capabilities and returns them ranked by relevance, price, and latency", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const { client } = await createSandboxOrganization({
      name: "Acme",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });

    const schema = {
      inputSchema: { type: "object", properties: { documentUrl: { type: "string" } } },
      outputSchema: { type: "object", properties: { total: { type: "string" } } },
    };
    const cheap = await client.registry.register({
      name: "Invoice extractor",
      description: "Extract structured fields from invoices and receipts.",
      ...schema,
      pricing: { model: "per_call", amountUsdc: "0.02" },
      latency: { p95Ms: 400 },
      tags: ["invoice", "extract"],
    });
    const pricey = await client.registry.register({
      name: "Invoice extractor",
      description: "Extract structured fields from invoices and receipts.",
      ...schema,
      pricing: { model: "per_call", amountUsdc: "0.75" },
      latency: { p95Ms: 2200 },
      tags: ["invoice", "extract"],
    });
    await client.registry.register({
      name: "Weather forecast",
      description: "Hourly weather for a city.",
      ...schema,
      pricing: { model: "per_call", amountUsdc: "0.01" },
      latency: { p95Ms: 80 },
      tags: ["weather"],
    });

    const hits = await client.registry.search({ q: "parse receipts" });
    expect(hits.map((hit) => hit.listing.id)).toEqual([cheap.id, pricey.id]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);

    const keywordMiss = await client.registry.search({ q: "invioce extractr" });
    expect(keywordMiss.map((hit) => hit.listing.id)).not.toContain(cheap.id);
    const semanticHits = await client.registry.search({ q: "invioce extractr", semantic: true });
    expect(semanticHits.map((hit) => hit.listing.id)).toEqual([cheap.id, pricey.id]);

    const loaded = await client.registry.get(cheap.id);
    expect(loaded.pricing.amountUsdc).toBe("0.020000");
  });

  it("runs a marketplace job through create, get, and submit", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const { client } = await createSandboxOrganization({
      name: "Acme",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });
    const buyer = await client.agents.create({
      name: "buyer",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    const seller = await client.agents.create({
      name: "seller",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    await client.agents.fund(buyer.id, "5.00");
    const listing = await client.registry.register({
      name: "Receipt parser",
      description: "Parse receipts and invoices into a structured total.",
      inputSchema: { type: "object", properties: { documentUrl: { type: "string" } } },
      outputSchema: { type: "object", properties: { total: { type: "string" } } },
      pricing: { model: "per_call", amountUsdc: "0.02" },
      latency: { p95Ms: 400 },
      tags: ["receipt", "invoice"],
    });
    const binding = await client.jobs.bindSeller(listing.id, seller.id);
    expect(binding.sellerAgentId).toBe(seller.id);

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["total"],
      properties: { total: { type: "string", minLength: 1 } },
    };
    const held = await client.jobs.create({
      buyerAgentId: buyer.id,
      query: "parse receipts",
      amountUsdc: "1.00",
      schema,
    });
    expect(held.status).toBe("held");
    expect(held.listingId).toBe(listing.id);
    const loaded = await client.jobs.get(held.id);
    expect(loaded.status).toBe("held");

    const released = await client.jobs.submit(held.id, { total: "12.50" });
    expect(released.status).toBe("released");
    expect(released.sellerNetUsdc).toBe("0.990000");
    expect(released.passport?.scoreBefore).toBe("0.0000");
    expect(released.passport?.scoreAfter).toBe("85.0100");

    const refundHold = await client.jobs.create({
      buyerAgentId: buyer.id,
      query: "parse receipts",
      amountUsdc: "1.00",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["rows"],
        properties: { rows: { type: "integer", minimum: 1 } },
      },
    });
    const refunded = await client.jobs.submit(refundHold.id, { rows: 0 });
    expect(refunded.status).toBe("refunded");
    expect(refunded.validationErrors).toEqual(["result.rows: expected >= 1."]);
    expect(refunded.buyerBalanceUsdc).toBe("4.000000");
  });

  it("pays a seller organization through escrow and refunds a failed delivery", async () => {
    const app = createApp({ mode: "sandbox" });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const base = { baseUrl: "http://albesa.test", fetch: fetchImpl };
    const buyerOrg = await createSandboxOrganization({ name: "Northwind", ...base });
    const sellerOrg = await createSandboxOrganization({ name: "Harbor", ...base });

    const buyer = await buyerOrg.client.agents.create({
      name: "buyer",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    const seller = await sellerOrg.client.agents.create({
      name: "seller",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    const funded = await buyerOrg.client.agents.fund(buyer.id, "5.00");
    expect(funded.balanceUsdc).toBe("5.000000");

    const catalog = await sellerOrg.client.registry.seed();
    expect(catalog.map((listing) => listing.name)).toEqual([
      "Receipt parser",
      "Doc summarizer",
      "Unit converter",
      "Structured data extract",
      "Doc Q&A",
      "Compute arb",
    ]);
    const receipt = catalog[0];
    expect(receipt?.name).toBe("Receipt parser");
    if (!receipt) throw new Error("missing receipt listing");
    await sellerOrg.client.jobs.bindSeller(receipt.id, seller.id);
    const listed = await buyerOrg.client.registry.list();
    expect(listed.some((listing) => listing.id === receipt.id)).toBe(true);

    const hits = await buyerOrg.client.registry.search({ q: "parse receipts", tags: ["receipt"], withReputation: true });
    expect(hits[0]?.listing.id).toBe(receipt.id);
    expect(hits[0]?.reputationScore).toBe(50);

    const before = await buyerOrg.client.reputation.passport(seller.id);
    expect(before.score).toBe("0.0000");
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["total"],
      properties: { total: { type: "string", minLength: 1 } },
    };
    const held = await buyerOrg.client.jobs.create({
      buyerAgentId: buyer.id,
      query: "parse receipts",
      amountUsdc: "1.00",
      schema,
      tags: ["receipt"],
    });
    expect(held.sellerOrganizationId).toBe(sellerOrg.organizationId);
    expect(held.takeRateUsdc).toBe("0.010000");
    expect((await sellerOrg.client.jobs.list()).map((job) => job.id)).toEqual([held.id]);

    await expect(buyerOrg.client.jobs.submit(held.id, { total: "12.50" })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });

    const released = await sellerOrg.client.jobs.submit(held.id, { total: "12.50" });
    expect(released.status).toBe("released");
    expect(released.sellerNetUsdc).toBe("0.990000");
    expect(released.sellerBalanceUsdc).toBe("0.990000");
    expect(released.buyerBalanceUsdc).toBe("4.000000");
    expect(released.passport).toEqual({
      agentId: seller.id,
      scoreBefore: "0.0000",
      scoreAfter: "85.0100",
    });

    const refundHold = await buyerOrg.client.jobs.create({
      buyerAgentId: buyer.id,
      query: "parse receipts",
      amountUsdc: "1.00",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["rows"],
        properties: { rows: { type: "integer", minimum: 1 } },
      },
      tags: ["receipt"],
    });
    const refunded = await sellerOrg.client.jobs.submit(refundHold.id, { rows: 0 });
    expect(refunded.status).toBe("refunded");
    expect(refunded.validationErrors).toEqual(["result.rows: expected >= 1."]);
    expect(refunded.buyerBalanceUsdc).toBe("4.000000");
    expect(refunded.sellerBalanceUsdc).toBe("0.990000");
    expect(refunded.passport?.scoreBefore).toBe("85.0100");
    expect(refunded.passport?.scoreAfter).toBe("52.5100");
  });

  it("expires a job past the listing SLA and refunds the buyer", async () => {
    let current = Date.parse("2026-09-30T12:00:00.000Z");
    const app = createApp({ mode: "sandbox", now: () => new Date(current) });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const buyerOrg = await createSandboxOrganization({
      name: "Northwind",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });
    const sellerOrg = await createSandboxOrganization({
      name: "Harbor",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });
    const buyer = await buyerOrg.client.agents.create({
      name: "buyer",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    const seller = await sellerOrg.client.agents.create({
      name: "seller",
      dailySpendLimitUsdc: "10.00",
      vendorAllowlist: [],
    });
    await buyerOrg.client.agents.fund(buyer.id, "1.00");
    const listing = await sellerOrg.client.registry.register({
      name: "Receipt parser",
      description: "Parse receipts and invoices into a structured total.",
      inputSchema: { type: "object", properties: { documentUrl: { type: "string" } } },
      outputSchema: { type: "object", properties: { total: { type: "string" } } },
      pricing: { model: "per_call", amountUsdc: "0.02" },
      latency: { p95Ms: 400 },
      tags: ["receipt"],
    });
    await sellerOrg.client.jobs.bindSeller(listing.id, seller.id);
    const held = await buyerOrg.client.jobs.create({
      buyerAgentId: buyer.id,
      query: "parse receipts",
      amountUsdc: "1.00",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["total"],
        properties: { total: { type: "string", minLength: 1 } },
      },
      tags: ["receipt"],
    });
    expect(held.status).toBe("held");
    expect(held.slaMs).toBe(400);
    expect(held.deadlineAt).toBe(new Date(current + 400).toISOString());
    expect(await buyerOrg.client.jobs.expire()).toEqual([]);

    current += 400;
    const timedOut = await sellerOrg.client.jobs.expire();
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({
      id: held.id,
      status: "timed_out",
      buyerBalanceUsdc: "1.000000",
      sellerBalanceUsdc: "0.000000",
      validationErrors: ["SLA deadline passed before a valid result."],
      passport: { agentId: seller.id, scoreBefore: "0.0000", scoreAfter: "20.0000" },
    });
    const passport = await buyerOrg.client.reputation.passport(seller.id);
    expect(passport.metrics.failureCount).toBe(1);
    expect(passport.metrics.volumeSettledUsdc).toBe("0.000000");
    expect(await buyerOrg.client.jobs.expire()).toEqual([]);
  });

  it("finds a listing with need() and buys it in one call", async () => {
    const app = createApp({ mode: "sandbox", autofill: "sync" });
    await bootstrapSandboxFleet(app);
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.request(input, init));
    const { client } = await createSandboxAccount({
      email: "need@example.com",
      password: "sandbox-passphrase-9",
      name: "Need",
      baseUrl: "http://albesa.test",
      fetch: fetchImpl,
    });
    const found = await client.need("summarize a long document into bullet points");
    expect(found.matched).toBe(true);
    const top = found.matches[0]!;
    expect(top.buy.path).toBe("/v1/need/buy");
    const bought = await client.buy({ listingId: top.listingId });
    expect(bought.status).toBe("released");
    expect(bought.delivered).toBe(true);
    expect(bought.receipt.listingId).toBe(top.listingId);

    const missing = await client.need({ need: "live seat map for a specific concert tonight" });
    expect(missing.matched).toBe(false);
    expect(missing.unmet?.logged).toBe(true);
    const hits = await client.registry.search({ q: "summarize", kinds: ["service"] });
    expect(hits.every((hit) => (hit.listing.kind ?? "service") === "service")).toBe(true);
  });
});
