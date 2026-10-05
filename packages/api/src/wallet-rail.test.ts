import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

interface OrgBody {
  apiKey: string;
  treasury: { wallet: { address: string; chain: string }; balanceUsdc: string };
}

interface AgentBody {
  agent: { id: string };
  wallet: { address: string; chain: string };
  balanceUsdc: string;
}

interface PayBody {
  transaction: { status: string; chain: string; providerRef: string; feeUsdc: string; amountUsdc: string };
  balanceUsdc: string;
}

describe("simulated Base rail", () => {
  it("keeps mock as the default health rail", async () => {
    const app = createApp({ mode: "sandbox", walletRail: "mock" });
    expect(await (await app.request("/health")).json()).toMatchObject({ rail: "mock", product: "Roster" });
  });

  it("funds and settles on base-sim without changing the sandbox fee or principal", async () => {
    const app = createApp({ mode: "sandbox", walletRail: "base-sim" });
    expect(await (await app.request("/health")).json()).toMatchObject({
      ok: true,
      product: "Roster",
      mode: "sandbox",
      rail: "base-sim",
      asset: "USDC",
    storage: "memory",
    });

    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(created.status).toBe(201);
    const org = (await created.json()) as OrgBody;
    expect(org.treasury.balanceUsdc).toBe("1000.000000");
    expect(org.treasury.wallet.chain).toBe("base-sepolia-sim");
    expect(org.treasury.wallet.address).toMatch(/^base-sim:0x[0-9a-f]{40}$/);
    const auth = { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" };

    const agentResponse = await app.request("/v1/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "buyer",
        dailySpendLimitUsdc: "10.00",
        vendorAllowlist: ["vendor_data"],
      }),
    });
    expect(agentResponse.status).toBe(201);
    const agent = (await agentResponse.json()) as AgentBody;
    expect(agent.wallet.chain).toBe("base-sepolia-sim");
    expect(agent.wallet.address).toMatch(/^base-sim:0x[0-9a-f]{40}$/);
    expect(agent.wallet.address.includes(agent.agent.id)).toBe(false);

    const funded = await app.request(`/v1/agents/${agent.agent.id}/fund`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amountUsdc: "5.00" }),
    });
    expect(funded.status).toBe(200);
    const fundBody = (await funded.json()) as PayBody;
    expect(fundBody.transaction.chain).toBe("base-sepolia-sim");
    expect(fundBody.transaction.providerRef).toBe("base_sim_tx_1");
    expect(fundBody.balanceUsdc).toBe("5.000000");

    const paid = await app.request(`/v1/agents/${agent.agent.id}/payments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ vendorId: "vendor_data", amountUsdc: "0.15" }),
    });
    expect(paid.status).toBe(200);
    const payment = (await paid.json()) as PayBody;
    expect(payment.transaction.status).toBe("settled");
    expect(payment.transaction.chain).toBe("base-sepolia-sim");
    expect(payment.transaction.providerRef).toBe("base_sim_tx_2");
    expect(payment.transaction.amountUsdc).toBe("0.150000");
    expect(payment.transaction.feeUsdc).toBe("0.011500");
    expect(payment.balanceUsdc).toBe("4.838500");
  });

  it("reloads simulated Base balances and the recorded network fee", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-base-sim-"));
    const dataFile = join(dir, "sandbox.json");
    try {
      const first = createApp({ mode: "sandbox", dataFile, walletRail: "base-sim" });
      const created = await first.request("/v1/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      });
      const org = (await created.json()) as OrgBody;
      const auth = { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" };
      const agentResponse = await first.request("/v1/agents", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "buyer",
          dailySpendLimitUsdc: "10.00",
          vendorAllowlist: ["vendor_data"],
        }),
      });
      const agentId = ((await agentResponse.json()) as AgentBody).agent.id;
      await first.request(`/v1/agents/${agentId}/fund`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ amountUsdc: "2.00" }),
      });

      const onDisk = readFileSync(dataFile, "utf8");
      expect(onDisk.includes(org.apiKey)).toBe(false);
      expect(onDisk).toContain('"networkFeesCollectedUsdc": "0.000001"');
      expect(onDisk).not.toMatch(/privateKey|mnemonic|seed|rpcUrl/i);

      const second = createApp({ mode: "sandbox", dataFile, walletRail: "base-sim" });
      const balance = await second.request(`/v1/agents/${agentId}/balance`, { headers: auth });
      expect(balance.status).toBe(200);
      expect(await balance.json()).toMatchObject({
        balanceUsdc: "2.000000",
        chain: "base-sepolia-sim",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
