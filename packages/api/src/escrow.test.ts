import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockWalletProvider } from "@albesa/core";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { AgentFinanceService } from "./service.js";

const deliverySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "rows"],
  properties: {
    status: { type: "string", enum: ["ok"] },
    rows: { type: "integer", minimum: 1 },
  },
};

interface OrgBody {
  apiKey: string;
  organization: { id: string };
}

interface AgentBody {
  agent: { id: string };
  balanceUsdc: string;
}

interface EscrowBody {
  escrow: {
    id: string;
    status: string;
    amountUsdc: string;
    takeRateUsdc: string;
    sellerNetUsdc: string;
    holdAddress: string;
    validationErrors: string[] | null;
    notifiedAt: string;
  };
  notification?: { type: string; sellerAgentId: string; amountUsdc: string };
  buyerBalanceUsdc: string;
  sellerBalanceUsdc: string;
}

interface ErrorBody {
  error: { code: string };
}

async function boot() {
  const wallets = new MockWalletProvider();
  const service = new AgentFinanceService({ mode: "sandbox", wallets });
  const app = createApp({ mode: "sandbox", service });
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme" }),
  });
  expect(created.status).toBe(201);
  const org = (await created.json()) as OrgBody;
  const auth = { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" };
  const buyer = await createAgent(app, auth, "buyer");
  const seller = await createAgent(app, auth, "seller");
  return { app, wallets, org, auth, buyerId: buyer.agent.id, sellerId: seller.agent.id };
}

async function createAgent(
  app: ReturnType<typeof createApp>,
  auth: { authorization: string; "content-type": string },
  name: string,
): Promise<AgentBody> {
  const response = await app.request("/v1/agents", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, dailySpendLimitUsdc: "10.00", vendorAllowlist: ["vendor_data"] }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as AgentBody;
}

async function fund(
  app: ReturnType<typeof createApp>,
  auth: { authorization: string; "content-type": string },
  agentId: string,
  amountUsdc: string,
): Promise<void> {
  const response = await app.request(`/v1/agents/${agentId}/fund`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ amountUsdc }),
  });
  expect(response.status).toBe(200);
}

describe("programmable escrow", () => {
  it("locks mock USDC, validates the delivery, and releases net of the take-rate", async () => {
    const { app, wallets, org, auth, buyerId, sellerId } = await boot();
    await fund(app, auth, buyerId, "10.00");

    const created = await app.request("/v1/escrows", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        amountUsdc: "4.00",
        memo: "extract rows",
        schema: deliverySchema,
      }),
    });
    expect(created.status).toBe(201);
    const locked = (await created.json()) as EscrowBody;
    expect(locked.escrow.status).toBe("held");
    expect(locked.escrow.notifiedAt).toBeTruthy();
    expect(locked.notification).toMatchObject({
      type: "escrow.held",
      sellerAgentId: sellerId,
      amountUsdc: "4.000000",
    });
    expect(locked.buyerBalanceUsdc).toBe("6.000000");
    expect(locked.sellerBalanceUsdc).toBe("0.000000");
    expect(await wallets.getBalance(locked.escrow.holdAddress)).toBe("4.000000");

    const overspend = await app.request(`/v1/agents/${buyerId}/payments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ vendorId: "vendor_data", amountUsdc: "6.00" }),
    });
    expect(overspend.status).toBe(409);
    expect(((await overspend.json()) as ErrorBody).error.code).toBe("insufficient_balance");

    const delivered = await app.request(`/v1/escrows/${locked.escrow.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ result: { status: "ok", rows: 4 } }),
    });
    expect(delivered.status).toBe(200);
    const released = (await delivered.json()) as EscrowBody;
    expect(released.escrow.status).toBe("released");
    expect(released.escrow.takeRateUsdc).toBe("0.040000");
    expect(released.escrow.sellerNetUsdc).toBe("3.960000");
    expect(released.escrow.validationErrors).toBeNull();
    expect(released.buyerBalanceUsdc).toBe("6.000000");
    expect(released.sellerBalanceUsdc).toBe("3.960000");
    expect(await wallets.getBalance(locked.escrow.holdAddress)).toBe("0.000000");
    expect(await wallets.getBalance(`mock:fees:${org.organization.id}`)).toBe("0.040000");

    const again = await app.request(`/v1/escrows/${locked.escrow.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ result: { status: "ok", rows: 4 } }),
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorBody).error.code).toBe("invalid_state");

    const sellerLedger = await app.request(`/v1/agents/${sellerId}/ledger`, { headers: auth });
    const credits = ((await sellerLedger.json()) as { entries: { direction: string; amountUsdc: string }[] }).entries;
    expect(credits.map((entry) => `${entry.direction}:${entry.amountUsdc}`)).toEqual(["credit:3.960000"]);
  });

  it("refunds the buyer when the delivery fails schema validation", async () => {
    const { app, wallets, org, auth, buyerId, sellerId } = await boot();
    await fund(app, auth, buyerId, "2.50");

    const created = await app.request("/v1/escrows", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        amountUsdc: "2.50",
        schema: deliverySchema,
      }),
    });
    const locked = (await created.json()) as EscrowBody;
    expect(locked.buyerBalanceUsdc).toBe("0.000000");

    const missing = await app.request(`/v1/escrows/${locked.escrow.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect(await wallets.getBalance(locked.escrow.holdAddress)).toBe("2.500000");

    const failed = await app.request(`/v1/escrows/${locked.escrow.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ result: { status: "ok", rows: 0 } }),
    });
    expect(failed.status).toBe(200);
    const refunded = (await failed.json()) as EscrowBody;
    expect(refunded.escrow.status).toBe("refunded");
    expect(refunded.escrow.validationErrors).toEqual(["result.rows: expected >= 1."]);
    expect(refunded.buyerBalanceUsdc).toBe("2.500000");
    expect(refunded.sellerBalanceUsdc).toBe("0.000000");
    expect(await wallets.getBalance(locked.escrow.holdAddress)).toBe("0.000000");
    expect(await wallets.getBalance(`mock:fees:${org.organization.id}`)).toBe("0.000000");

    const listed = await app.request("/v1/escrows", { headers: auth });
    const escrows = ((await listed.json()) as { escrows: { status: string }[] }).escrows;
    expect(escrows.map((escrow) => escrow.status)).toEqual(["refunded"]);
  });

  it("rejects a lock when the buyer cannot cover it and does not reserve funds", async () => {
    const { app, auth, buyerId, sellerId } = await boot();
    await fund(app, auth, buyerId, "0.40");

    const denied = await app.request("/v1/escrows", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        amountUsdc: "1.00",
        schema: deliverySchema,
      }),
    });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as ErrorBody).error.code).toBe("insufficient_balance");

    const balance = await app.request(`/v1/agents/${buyerId}/balance`, { headers: auth });
    expect(((await balance.json()) as { balanceUsdc: string }).balanceUsdc).toBe("0.400000");

    const listed = await app.request("/v1/escrows", { headers: auth });
    expect(((await listed.json()) as { escrows: unknown[] }).escrows).toEqual([]);

    const history = await app.request(`/v1/agents/${buyerId}/transactions`, { headers: auth });
    const transactions = ((await history.json()) as { transactions: { type: string }[] }).transactions;
    expect(transactions.map((tx) => tx.type)).toEqual(["fund"]);

    const malformed = await app.request("/v1/escrows", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        amountUsdc: "0.10",
        schema: { type: "object", properties: { rows: { type: "integer", minLenght: 1 } } },
      }),
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ErrorBody).error.code).toBe("invalid_schema");
    const still = await app.request(`/v1/agents/${buyerId}/balance`, { headers: auth });
    expect(((await still.json()) as { balanceUsdc: string }).balanceUsdc).toBe("0.400000");
  });

  it("requires the organization API key and hides another organization's escrow", async () => {
    const { app, auth, buyerId, sellerId } = await boot();
    await fund(app, auth, buyerId, "1.00");
    const created = await app.request("/v1/escrows", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        amountUsdc: "1.00",
        schema: deliverySchema,
      }),
    });
    const escrowId = ((await created.json()) as EscrowBody).escrow.id;

    const anonymous = await app.request("/v1/escrows", { method: "GET" });
    expect(anonymous.status).toBe(401);

    const other = await app.request("/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Other" }),
    });
    const otherKey = ((await other.json()) as OrgBody).apiKey;
    const peek = await app.request(`/v1/escrows/${escrowId}`, {
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(peek.status).toBe(404);
  });

  it("reloads a held escrow and its reserved balance from the sandbox file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-escrow-"));
    const dataFile = join(dir, "sandbox.json");
    try {
      const first = createApp({ mode: "sandbox", dataFile });
      const createdOrg = await first.request("/v1/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      });
      const org = (await createdOrg.json()) as OrgBody;
      const auth = { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" };
      const buyer = await createAgent(first, auth, "buyer");
      const seller = await createAgent(first, auth, "seller");
      await fund(first, auth, buyer.agent.id, "4.00");
      const created = await first.request("/v1/escrows", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          buyerAgentId: buyer.agent.id,
          sellerAgentId: seller.agent.id,
          amountUsdc: "1.50",
          schema: deliverySchema,
        }),
      });
      expect(created.status).toBe(201);
      const locked = (await created.json()) as EscrowBody;

      const second = createApp({ mode: "sandbox", dataFile });
      const loaded = await second.request(`/v1/escrows/${locked.escrow.id}`, { headers: auth });
      expect(loaded.status).toBe(200);
      const held = (await loaded.json()) as EscrowBody;
      expect(held.escrow.status).toBe("held");
      expect(held.escrow.holdAddress).toBe(locked.escrow.holdAddress);
      expect(held.buyerBalanceUsdc).toBe("2.500000");
      expect(held.sellerBalanceUsdc).toBe("0.000000");

      const delivered = await second.request(`/v1/escrows/${locked.escrow.id}/result`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ result: { status: "ok", rows: 2 } }),
      });
      expect(delivered.status).toBe(200);
      const released = (await delivered.json()) as EscrowBody;
      expect(released.escrow.status).toBe("released");
      expect(released.sellerBalanceUsdc).toBe("1.485000");
      expect(released.buyerBalanceUsdc).toBe("2.500000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
