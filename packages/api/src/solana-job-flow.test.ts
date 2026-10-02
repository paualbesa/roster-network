import { MockWalletProvider } from "@albesa/core";
import { mockSolanaEngineConfig, quoteRosterNetworkFee } from "@albesa/solana";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { sandboxReceiptListing } from "./jobs.js";
import { AgentFinanceService } from "./service.js";

const BUYER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PROVIDER = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const totalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["total"],
  properties: { total: { type: "string", minLength: 1 } },
};

interface OrgBody {
  apiKey: string;
  organization: { id: string };
}

interface AgentBody {
  agent: { id: string };
}

interface ListingBody {
  listing: { id: string };
}

interface JobBody {
  job: {
    id: string;
    status: string;
    escrowId: string;
    amountUsdc: string;
    takeRateUsdc: string;
    sellerNetUsdc: string;
    buyerBalanceUsdc: string;
    sellerBalanceUsdc: string;
  };
}

interface LockBody {
  cluster: string;
  broadcast: boolean;
  escrowId: string;
  jobId: string | null;
  quote: { rosterFeeUsdc: string; providerPayoutUsdc: string };
}

interface ErrorBody {
  error: { code: string };
}

async function organization(app: ReturnType<typeof createApp>, name = "Acme") {
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(created.status).toBe(201);
  const org = (await created.json()) as OrgBody;
  return {
    organizationId: org.organization.id,
    auth: { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" },
  };
}

async function createAgent(app: ReturnType<typeof createApp>, auth: Record<string, string>, name: string) {
  const response = await app.request("/v1/agents", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, dailySpendLimitUsdc: "10.00", vendorAllowlist: [] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as AgentBody).agent.id;
}

describe("marketplace job with gasless prepare-lock and settle", () => {
  it("keeps mock escrow on the 1% schedule while the Solana quote adds 0.003 USDC", async () => {
    const wallets = new MockWalletProvider();
    const app = createApp({
      mode: "sandbox",
      solana: mockSolanaEngineConfig(),
      service: new AgentFinanceService({ mode: "sandbox", wallets }),
    });
    const org = await organization(app);
    const buyerId = await createAgent(app, org.auth, "buyer");
    const sellerId = await createAgent(app, org.auth, "seller");
    const funded = await app.request(`/v1/agents/${buyerId}/fund`, {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ amountUsdc: "5.00" }),
    });
    expect(funded.status).toBe(200);
    const listed = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify(sandboxReceiptListing()),
    });
    expect(listed.status).toBe(201);
    const listingId = ((await listed.json()) as ListingBody).listing.id;
    const bound = await app.request(`/v1/jobs/listings/${listingId}/seller`, {
      method: "PUT",
      headers: org.auth,
      body: JSON.stringify({ sellerAgentId: sellerId }),
    });
    expect(bound.status).toBe(200);

    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: totalSchema,
        tags: ["receipt"],
      }),
    });
    expect(created.status).toBe(201);
    const held = (await created.json()) as JobBody;
    expect(held.job.status).toBe("held");
    expect(held.job.takeRateUsdc).toBe("0.010000");
    expect(held.job.sellerNetUsdc).toBe("0.990000");

    const prepared = await app.request("/v1/escrow/prepare-lock", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({
        buyerPubkey: BUYER,
        amountUsdc: held.job.amountUsdc,
        escrowId: held.job.escrowId,
        jobId: held.job.id,
      }),
    });
    expect(prepared.status).toBe(201);
    const lock = (await prepared.json()) as LockBody;
    expect(lock.cluster).toBe("mock");
    expect(lock.broadcast).toBe(false);
    expect(lock.escrowId).toBe(held.job.escrowId);
    expect(lock.jobId).toBe(held.job.id);
    expect(lock.quote).toEqual(quoteRosterNetworkFee("1.00"));
    expect(lock.quote.rosterFeeUsdc).toBe("0.013000");
    expect(lock.quote.providerPayoutUsdc).toBe("0.987000");

    const escrowHeld = await app.request(`/v1/escrows/${held.job.escrowId}`, { headers: org.auth });
    expect(escrowHeld.status).toBe(200);
    expect(((await escrowHeld.json()) as { escrow: { status: string } }).escrow.status).toBe("held");

    const delivered = await app.request(`/v1/jobs/${held.job.id}/result`, {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ result: { total: "12.50" } }),
    });
    expect(delivered.status).toBe(200);
    const released = (await delivered.json()) as JobBody;
    expect(released.job.status).toBe("released");
    expect(released.job.takeRateUsdc).toBe("0.010000");
    expect(released.job.sellerNetUsdc).toBe("0.990000");
    expect(released.job.sellerBalanceUsdc).toBe("0.990000");

    const settled = await app.request("/v1/escrow/settle", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({
        escrowId: lock.escrowId,
        buyerPubkey: BUYER,
        providerPubkey: PROVIDER,
        amountUsdc: released.job.amountUsdc,
        jobId: released.job.id,
        verified: true,
      }),
    });
    expect(settled.status).toBe(200);
    const settleBody = (await settled.json()) as LockBody & { submitted: boolean; broadcast: boolean };
    expect(settleBody.broadcast).toBe(false);
    expect(settleBody.submitted).toBe(false);
    expect(settleBody.quote.rosterFeeUsdc).toBe("0.013000");
    expect(settleBody.quote.providerPayoutUsdc).toBe("0.987000");

    const escrow = await app.request(`/v1/escrows/${held.job.escrowId}`, { headers: org.auth });
    const escrowBody = (await escrow.json()) as { escrow: { status: string; takeRateUsdc: string; sellerNetUsdc: string } };
    expect(escrowBody.escrow.status).toBe("released");
    expect(escrowBody.escrow.takeRateUsdc).toBe("0.010000");
    expect(escrowBody.escrow.sellerNetUsdc).toBe("0.990000");

    const direct = await app.request("/v1/escrows", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        amountUsdc: "1.00",
        schema: totalSchema,
      }),
    });
    expect(direct.status).toBe(201);
    expect(((await direct.json()) as { escrow: { status: string; takeRateUsdc: string } }).escrow).toMatchObject({
      status: "held",
      takeRateUsdc: "0.010000",
    });
  });

  it("refunds the mock principal on SLA timeout and does not require a Solana settle", async () => {
    let current = Date.parse("2026-10-02T12:00:00.000Z");
    const now = () => new Date(current);
    const wallets = new MockWalletProvider();
    const app = createApp({
      mode: "sandbox",
      now,
      solana: mockSolanaEngineConfig(),
      service: new AgentFinanceService({ mode: "sandbox", wallets, now }),
    });
    const org = await organization(app, "Northwind");
    const buyerId = await createAgent(app, org.auth, "buyer");
    const sellerId = await createAgent(app, org.auth, "seller");
    const funded = await app.request(`/v1/agents/${buyerId}/fund`, {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ amountUsdc: "1.00" }),
    });
    expect(funded.status).toBe(200);
    const listed = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify(sandboxReceiptListing()),
    });
    const listingId = ((await listed.json()) as ListingBody).listing.id;
    expect(
      (
        await app.request(`/v1/jobs/listings/${listingId}/seller`, {
          method: "PUT",
          headers: org.auth,
          body: JSON.stringify({ sellerAgentId: sellerId }),
        })
      ).status,
    ).toBe(200);

    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: totalSchema,
        tags: ["receipt"],
      }),
    });
    const held = (await created.json()) as JobBody;
    const prepared = await app.request("/v1/escrow/prepare-lock", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({
        buyerPubkey: BUYER,
        amountUsdc: "1.00",
        escrowId: held.job.escrowId,
        jobId: held.job.id,
      }),
    });
    expect(prepared.status).toBe(201);
    expect(((await prepared.json()) as LockBody).broadcast).toBe(false);

    current += 400;
    const expired = await app.request("/v1/jobs/expire", { method: "POST", headers: org.auth });
    expect(expired.status).toBe(200);
    const timedOut = ((await expired.json()) as { jobs: JobBody["job"][] }).jobs;
    expect(timedOut[0]).toMatchObject({
      status: "timed_out",
      buyerBalanceUsdc: "1.000000",
      sellerBalanceUsdc: "0.000000",
      takeRateUsdc: "0.010000",
    });
    expect(await wallets.getBalance(`mock:fees:${org.organizationId}`)).toBe("0.000000");

    const unverified = await app.request("/v1/escrow/settle", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({
        escrowId: held.job.escrowId,
        buyerPubkey: BUYER,
        providerPubkey: PROVIDER,
        amountUsdc: "1.00",
        jobId: held.job.id,
        verified: false,
      }),
    });
    expect(unverified.status).toBe(409);
    expect(((await unverified.json()) as ErrorBody).error.code).toBe("invalid_state");
    expect(await wallets.getBalance(`mock:fees:${org.organizationId}`)).toBe("0.000000");

    const direct = await app.request("/v1/escrows", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        amountUsdc: "0.25",
        schema: totalSchema,
      }),
    });
    expect(direct.status).toBe(201);
  });
});
