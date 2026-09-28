import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

interface ErrorBody {
  error: { code: string; message: string };
  transaction?: { status: string; rejectionReason: string | null };
}

interface OrgBody {
  apiKey: string;
  treasury: { balanceUsdc: string };
}

interface AgentBody {
  agent: { id: string };
  wallet: { address: string };
  balanceUsdc: string;
}

interface PayBody {
  transaction: { status: string; amountUsdc: string; feeUsdc: string; vendorId: string };
  balanceUsdc: string;
}

async function bootstrap(now?: Date) {
  const app = createApp(now ? { mode: "sandbox", now: () => now } : { mode: "sandbox" });
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme" }),
  });
  expect(created.status).toBe(201);
  const org = (await created.json()) as OrgBody;
  const auth = { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" };
  return { app, org, auth };
}

describe("agent finance API", () => {
  it("funds an agent from the sandbox treasury and settles an allowlisted payment", async () => {
    const { app, org, auth } = await bootstrap();
    expect(org.treasury.balanceUsdc).toBe("1000.000000");

    const created = await app.request("/v1/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "buyer",
        dailySpendLimitUsdc: "10.00",
        vendorAllowlist: ["vendor_data"],
      }),
    });
    expect(created.status).toBe(201);
    const agent = (await created.json()) as AgentBody;
    expect(agent.wallet.address.startsWith("mock:agent:")).toBe(true);
    expect(agent.balanceUsdc).toBe("0.000000");

    const funded = await app.request(`/v1/agents/${agent.agent.id}/fund`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amountUsdc: "5.00" }),
    });
    expect(funded.status).toBe(200);
    expect(((await funded.json()) as { balanceUsdc: string }).balanceUsdc).toBe("5.000000");

    const paid = await app.request(`/v1/agents/${agent.agent.id}/payments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ vendorId: "vendor_data", amountUsdc: "0.15", memo: "dataset" }),
    });
    expect(paid.status).toBe(200);
    const payment = (await paid.json()) as PayBody;
    expect(payment.transaction.status).toBe("settled");
    expect(payment.transaction.amountUsdc).toBe("0.150000");
    expect(payment.transaction.feeUsdc).toBe("0.011500");
    expect(payment.balanceUsdc).toBe("4.838500");

    const history = await app.request(`/v1/agents/${agent.agent.id}/transactions`, { headers: auth });
    const transactions = ((await history.json()) as { transactions: { type: string; status: string }[] }).transactions;
    expect(transactions.map((tx) => tx.type)).toEqual(["payment", "fund"]);

    const ledger = await app.request(`/v1/agents/${agent.agent.id}/ledger`, { headers: auth });
    const entries = ((await ledger.json()) as { entries: { direction: string; amountUsdc: string }[] }).entries;
    expect(entries.map((entry) => `${entry.direction}:${entry.amountUsdc}`)).toEqual([
      "credit:5.000000",
      "debit:0.150000",
      "debit:0.011500",
    ]);

    const treasury = await app.request("/v1/treasury", { headers: auth });
    expect(((await treasury.json()) as { balanceUsdc: string }).balanceUsdc).toBe("995.000000");
  });

  it("blocks non-allowlisted vendors and spends over the daily limit", async () => {
    const { app, auth } = await bootstrap(new Date("2026-09-28T12:00:00.000Z"));
    const created = await app.request("/v1/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "buyer",
        dailySpendLimitUsdc: "0.20",
        vendorAllowlist: ["vendor_data"],
      }),
    });
    const agentId = ((await created.json()) as AgentBody).agent.id;
    await app.request(`/v1/agents/${agentId}/fund`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amountUsdc: "5" }),
    });

    const blockedVendor = await app.request(`/v1/agents/${agentId}/payments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ vendorId: "vendor_unknown", amountUsdc: "0.10" }),
    });
    expect(blockedVendor.status).toBe(403);
    const vendorBody = (await blockedVendor.json()) as ErrorBody;
    expect(vendorBody.error.code).toBe("vendor_not_allowlisted");
    expect(vendorBody.transaction?.status).toBe("rejected");

    const first = await app.request(`/v1/agents/${agentId}/payments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ vendorId: "vendor_data", amountUsdc: "0.15" }),
    });
    expect(first.status).toBe(200);

    const overLimit = await app.request(`/v1/agents/${agentId}/payments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ vendorId: "vendor_data", amountUsdc: "0.10" }),
    });
    expect(overLimit.status).toBe(403);
    expect(((await overLimit.json()) as ErrorBody).error.code).toBe("daily_limit_exceeded");

    const balance = await app.request(`/v1/agents/${agentId}/balance`, { headers: auth });
    expect(((await balance.json()) as { balanceUsdc: string }).balanceUsdc).toBe("4.838500");
  });

  it("does not let one organization spend another agent's wallet", async () => {
    const { app, auth } = await bootstrap();
    const other = await app.request("/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Other" }),
    });
    const otherKey = ((await other.json()) as OrgBody).apiKey;
    const created = await app.request("/v1/agents", {
      method: "POST",
      headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "secret", dailySpendLimitUsdc: "1", vendorAllowlist: ["vendor_data"] }),
    });
    const agentId = ((await created.json()) as AgentBody).agent.id;
    const peek = await app.request(`/v1/agents/${agentId}/balance`, { headers: auth });
    expect(peek.status).toBe(404);
  });

  it("caps sandbox organizations at five active agents", async () => {
    const { app, auth } = await bootstrap();
    for (let index = 0; index < 5; index += 1) {
      const response = await app.request("/v1/agents", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: `agent-${index.toString()}`, dailySpendLimitUsdc: "1", vendorAllowlist: [] }),
      });
      expect(response.status).toBe(201);
    }
    const extra = await app.request("/v1/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "sixth", dailySpendLimitUsdc: "1", vendorAllowlist: [] }),
    });
    expect(extra.status).toBe(403);
    expect(((await extra.json()) as ErrorBody).error.code).toBe("agent_limit");
  });

  it("rejects missing and unknown API keys on org-scoped routes", async () => {
    const { app, auth } = await bootstrap();
    const missing = await app.request("/v1/treasury");
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ErrorBody).error.code).toBe("unauthorized");

    const malformed = await app.request("/v1/agents", {
      method: "POST",
      headers: { authorization: "Token secret", "content-type": "application/json" },
      body: JSON.stringify({ name: "buyer", dailySpendLimitUsdc: "1", vendorAllowlist: [] }),
    });
    expect(malformed.status).toBe(401);

    const unknown = await app.request("/v1/agents/agt_missing/balance", {
      headers: { authorization: "Bearer sk_sandbox_not_a_real_key" },
    });
    expect(unknown.status).toBe(401);

    const treasury = await app.request("/v1/treasury", { headers: auth });
    expect(treasury.status).toBe(200);
    const health = await app.request("/health");
    expect(health.status).toBe(200);
  });
});

describe("durable sandbox file", () => {
  it("reloads organizations, balances, and transactions after a new app opens the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "albesa-sandbox-"));
    const dataFile = join(dir, "sandbox.json");
    try {
      const first = createApp({ mode: "sandbox", dataFile });
      const created = await first.request("/v1/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      });
      expect(created.status).toBe(201);
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
        body: JSON.stringify({ amountUsdc: "5.00" }),
      });
      const paid = await first.request(`/v1/agents/${agentId}/payments`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ vendorId: "vendor_data", amountUsdc: "0.15", memo: "dataset" }),
      });
      expect(paid.status).toBe(200);
      const blocked = await first.request(`/v1/agents/${agentId}/payments`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ vendorId: "vendor_other", amountUsdc: "0.10" }),
      });
      expect(blocked.status).toBe(403);

      const other = await first.request("/v1/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Other" }),
      });
      const otherKey = ((await other.json()) as OrgBody).apiKey;
      const otherAgent = await first.request("/v1/agents", {
        method: "POST",
        headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "secret", dailySpendLimitUsdc: "1", vendorAllowlist: ["vendor_data"] }),
      });
      const otherAgentId = ((await otherAgent.json()) as AgentBody).agent.id;

      const onDisk = readFileSync(dataFile, "utf8");
      expect(onDisk.includes(org.apiKey)).toBe(false);
      expect(onDisk.includes(otherKey)).toBe(false);
      expect(onDisk.includes(createHash("sha256").update(org.apiKey, "utf8").digest("hex"))).toBe(true);
      expect(onDisk.includes("sk_sandbox_")).toBe(false);

      const second = createApp({ mode: "sandbox", dataFile });
      const denied = await second.request(`/v1/agents/${agentId}/balance`);
      expect(denied.status).toBe(401);
      const wrongOrg = await second.request(`/v1/agents/${otherAgentId}/balance`, { headers: auth });
      expect(wrongOrg.status).toBe(404);

      const balance = await second.request(`/v1/agents/${agentId}/balance`, { headers: auth });
      expect(balance.status).toBe(200);
      expect(((await balance.json()) as { balanceUsdc: string }).balanceUsdc).toBe("4.838500");

      const treasury = await second.request("/v1/treasury", { headers: auth });
      expect(((await treasury.json()) as { balanceUsdc: string }).balanceUsdc).toBe("995.000000");

      const history = await second.request(`/v1/agents/${agentId}/transactions`, { headers: auth });
      const transactions = ((await history.json()) as { transactions: { type: string; status: string }[] }).transactions;
      expect(transactions.map((tx) => `${tx.type}:${tx.status}`)).toEqual([
        "payment:rejected",
        "payment:settled",
        "fund:settled",
      ]);

      const ledger = await second.request(`/v1/agents/${agentId}/ledger`, { headers: auth });
      const entries = ((await ledger.json()) as { entries: { direction: string; amountUsdc: string }[] }).entries;
      expect(entries.map((entry) => `${entry.direction}:${entry.amountUsdc}`)).toEqual([
        "credit:5.000000",
        "debit:0.150000",
        "debit:0.011500",
      ]);

      const otherBalance = await second.request(`/v1/agents/${otherAgentId}/balance`, {
        headers: { authorization: `Bearer ${otherKey}` },
      });
      expect(otherBalance.status).toBe(200);
      expect(((await otherBalance.json()) as { balanceUsdc: string }).balanceUsdc).toBe("0.000000");

      const fundedAgain = await second.request(`/v1/agents/${otherAgentId}/fund`, {
        method: "POST",
        headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" },
        body: JSON.stringify({ amountUsdc: "1.00" }),
      });
      expect(fundedAgain.status).toBe(200);
      const again = (await fundedAgain.json()) as { transaction: { providerRef: string }; balanceUsdc: string };
      expect(again.balanceUsdc).toBe("1.000000");
      expect(again.transaction.providerRef).toBe("mock_tx_4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a sandbox file that is not version 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "albesa-bad-"));
    const dataFile = join(dir, "sandbox.json");
    try {
      writeFileSync(dataFile, JSON.stringify({ version: 2 }));
      expect(() => createApp({ mode: "sandbox", dataFile })).toThrow(/version 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
