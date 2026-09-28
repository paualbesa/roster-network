import { createApp } from "@albesa/api";
import { describe, expect, it } from "vitest";
import { Albesa, AlbesaError, createSandboxOrganization } from "./index.js";

describe("Albesa SDK", () => {
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
});
