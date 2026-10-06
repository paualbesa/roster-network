import { mockSolanaEngineConfig, quoteRosterNetworkFee, ROSTER_BASE_FEE_USDC, ROSTER_PERCENT_FEE } from "@albesa/solana";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const BUYER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PROVIDER = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

interface OrgBody {
  apiKey: string;
}

interface LockBody {
  broadcast: boolean;
  buyerSigned: boolean;
  feePayer: string;
  feePayerSignature: string;
  escrowId: string;
  escrowAta: string;
  escrowPda: string;
  transaction: string;
  quote: { rosterFeeUsdc: string; providerPayoutUsdc: string; percentFee: number; baseFeeUsdc: string };
}

interface SettleBody extends LockBody {
  submitted: boolean;
  signature: string | null;
  treasuryUsdcAta: string;
  programAuthority: string;
  broadcastNote: string | null;
}

interface ErrorBody {
  error: { code: string; message: string };
}

async function authedApp() {
  const app = createApp({ mode: "sandbox", solana: mockSolanaEngineConfig() });
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme" }),
  });
  expect(created.status).toBe(201);
  const org = (await created.json()) as OrgBody;
  const auth = { authorization: `Bearer ${org.apiKey}`, "content-type": "application/json" };
  return { app, auth };
}

describe("gasless USDC escrow", () => {
  it("prepares a fee-payer lock and settles the hybrid fee in mock mode", async () => {
    const { app, auth } = await authedApp();
    expect(ROSTER_PERCENT_FEE).toBe(0.01);
    expect(ROSTER_BASE_FEE_USDC).toBe(0.003);

    const lockedResponse = await app.request("/v1/escrow/prepare-lock", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        buyerPubkey: BUYER,
        amountUsdc: "1.00",
        escrowId: "escrow_api",
        jobId: "job_api",
      }),
    });
    expect(lockedResponse.status).toBe(201);
    const locked = (await lockedResponse.json()) as LockBody;
    expect(locked.broadcast).toBe(false);
    expect(locked.buyerSigned).toBe(false);
    expect(locked.feePayerSignature).toBe("sandbox");
    expect(locked.feePayer.length).toBeGreaterThan(30);
    expect(locked.escrowAta).not.toBe(locked.escrowPda);
    expect(locked.transaction.length).toBeGreaterThan(40);
    expect(locked.quote).toEqual(quoteRosterNetworkFee("1.00"));
    expect(locked.quote.rosterFeeUsdc).toBe("0.013000");
    expect(locked.quote.providerPayoutUsdc).toBe("0.987000");

    const settledResponse = await app.request("/v1/escrow/settle", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        escrowId: locked.escrowId,
        buyerPubkey: BUYER,
        providerPubkey: PROVIDER,
        amountUsdc: "1.00",
        jobId: "job_api",
        verified: true,
      }),
    });
    expect(settledResponse.status).toBe(200);
    const settled = (await settledResponse.json()) as SettleBody;
    expect(settled.broadcast).toBe(false);
    expect(settled.submitted).toBe(false);
    expect(settled.broadcastNote).toBeNull();
    expect(settled.signature).toBeTruthy();
    expect(settled.feePayer).toBe(locked.feePayer);
    expect(settled.escrowAta).toBe(locked.escrowAta);
    expect(settled.escrowPda).toBe(locked.escrowPda);
    expect(settled.treasuryUsdcAta.length).toBeGreaterThan(30);
    expect(settled.programAuthority).not.toBe(settled.feePayer);
    expect(settled.quote).toEqual(locked.quote);
    expect(settled.transaction).not.toBe(locked.transaction);
  });

  it("requires an API key and verified work", async () => {
    const { app, auth } = await authedApp();
    const anonymous = await app.request("/v1/escrow/prepare-lock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerPubkey: BUYER, amountUsdc: "1" }),
    });
    expect(anonymous.status).toBe(401);

    const early = await app.request("/v1/escrow/settle", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        escrowId: "escrow_api",
        buyerPubkey: BUYER,
        providerPubkey: PROVIDER,
        amountUsdc: "1",
        verified: false,
      }),
    });
    expect(early.status).toBe(409);
    expect(((await early.json()) as ErrorBody).error.code).toBe("invalid_state");

    const tiny = await app.request("/v1/escrow/prepare-lock", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ buyerPubkey: BUYER, amountUsdc: "0.001" }),
    });
    expect(tiny.status).toBe(400);
    expect(((await tiny.json()) as ErrorBody).error.code).toBe("price_too_low");
  });
});
