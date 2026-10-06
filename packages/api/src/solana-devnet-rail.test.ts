import { SolanaDevnetWalletProvider, testFeePayerSecret } from "@albesa/solana";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { sandboxJobSchema, sandboxReceiptListing } from "./jobs.js";

const PASSWORD = "sandbox-pass-1";

afterEach(() => {
  delete process.env.ROSTER_ADMIN_TOKEN;
});

describe("solana-devnet rail (offline ledger)", () => {
  it("locks and releases a job with Devnet-looking settlement signatures", async () => {
    const signatures: string[] = [];
    const wallets = new SolanaDevnetWalletProvider({
      feePayerSecret: testFeePayerSecret(),
      skipAirdrop: true,
      offlineLedger: true,
      sender: async () => {
        const sig = `Dn${signatures.length.toString(10)}${"A".repeat(80)}`;
        signatures.push(sig);
        return sig;
      },
    });
    const app = createApp({
      mode: "sandbox",
      walletRail: "solana-devnet",
      wallets,
      autofill: "sync",
    });

    const signup = await app.request("/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "devnet-buyer@example.com", password: PASSWORD, name: "Devnet" }),
    });
    expect(signup.status).toBe(201);
    const { apiKey } = (await signup.json()) as { apiKey: string };
    const auth = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

    const buyer = await app.request("/v1/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "buyer", dailySpendLimitUsdc: "1000.00", vendorAllowlist: [] }),
    });
    const buyerId = ((await buyer.json()) as { agent: { id: string } }).agent.id;
    const seller = await app.request("/v1/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "seller", dailySpendLimitUsdc: "1000.00", vendorAllowlist: [] }),
    });
    const sellerId = ((await seller.json()) as { agent: { id: string } }).agent.id;
    await app.request(`/v1/agents/${buyerId}/fund`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amountUsdc: "5.00" }),
    });

    const listed = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(sandboxReceiptListing()),
    });
    const listingId = ((await listed.json()) as { listing: { id: string } }).listing.id;
    await app.request(`/v1/jobs/listings/${listingId}/seller`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ sellerAgentId: sellerId }),
    });

    const created = await app.request("/v1/jobs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerAgentId: buyerId,
        query: "parse receipts",
        amountUsdc: "1.00",
        schema: sandboxJobSchema("Receipt parser"),
        tags: ["receipt"],
        listingId,
        input: { documentUrl: "https://example.com/r.pdf" },
      }),
    });
    expect(created.status).toBe(201);
    const locked = (await created.json()) as {
      job: {
        id: string;
        status: string;
        chain: string;
        lockProviderRef: string;
        slaMs: number;
        createdAt: string;
        deadlineAt: string;
      };
    };
    expect(locked.job.chain).toBe("solana-devnet");
    expect(locked.job.lockProviderRef.length).toBeGreaterThan(60);
    expect(locked.job.status).toBe("held");
    // Listing p95 stays 400; deadline adds Devnet settlement buffer.
    expect(locked.job.slaMs).toBe(400);
    expect(Date.parse(locked.job.deadlineAt!) - Date.parse(locked.job.createdAt)).toBe(400 + 60_000);

    const delivered = await app.request(`/v1/jobs/${locked.job.id}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ result: { total: "12.00" }, latencyMs: 100 }),
    });
    expect(delivered.status).toBe(200);
    const body = (await delivered.json()) as {
      job: {
        status: string;
        settlementProviderRef: string | null;
        settlementExplorerUrl: string | null;
      };
    };
    expect(body.job.status).toBe("released");
    expect(body.job.settlementProviderRef).toBeTruthy();
    expect(body.job.settlementExplorerUrl).toContain("cluster=devnet");

    const health = await app.request("/health");
    const healthBody = (await health.json()) as { rail: string; asset: string; solana?: { rail: string } };
    expect(healthBody.rail).toBe("solana-devnet");
    expect(healthBody.solana?.rail).toBe("solana-devnet");
  });
});
