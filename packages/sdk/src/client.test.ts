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
});
