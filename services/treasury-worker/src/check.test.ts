import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { FEE_PAYER_TOP_UP_USDC_MICROS, mockSolanaEngineConfig, USDC_MINT_MAINNET } from "@albesa/solana";
import {
  TREASURY_CHECK_INTERVAL_MS,
  jupiterUsdcToSolQuoteUrl,
  runTreasuryCheck,
  runTreasuryLoop,
  treasuryWillExecute,
} from "./check.js";

const LOW = 10_000_000n;

function armedEnv(feePayer: Keypair): Record<string, string> {
  return {
    ROSTER_SOLANA_CLUSTER: "mainnet-beta",
    ROSTER_SOLANA_ALLOW_MAINNET: "1",
    ROSTER_TREASURY_EXECUTE: "1",
    ROSTER_TREASURY_DRY_RUN: "0",
    ROSTER_FEE_PAYER_PUBKEY: feePayer.publicKey.toBase58(),
    ROSTER_FEE_PAYER_SECRET: JSON.stringify(Array.from(feePayer.secretKey)),
    SOLANA_RPC_URL: "http://127.0.0.1:9",
  };
}

describe("treasury worker", () => {
  it("checks every five minutes and leaves a healthy mock balance alone", async () => {
    expect(TREASURY_CHECK_INTERVAL_MS).toBe(300_000);
    const lines: string[] = [];
    const result = await runTreasuryLoop({
      once: true,
      env: { ROSTER_SOLANA_CLUSTER: "mock" },
      lamports: 1_000_000_000n,
      log: (line) => lines.push(line),
      fetchImpl: async () => {
        throw new Error("network");
      },
    });
    expect(result.action).toBe("ok");
    expect(result.dryRun).toBe(true);
    expect(result.jupiterQuoteUrl).toBeNull();
    expect(lines.join("\n")).toContain("action=ok");
  });

  it("dry-runs a 10 USDC Jupiter top-up when the fee payer is under 0.02 SOL", async () => {
    const lines: string[] = [];
    const result = await runTreasuryCheck({
      env: {
        ROSTER_SOLANA_CLUSTER: "mock",
        ROSTER_TREASURY_EXECUTE: "1",
        ROSTER_TREASURY_DRY_RUN: "0",
      },
      lamports: LOW,
      log: (line) => lines.push(line),
      fetchImpl: async () => {
        throw new Error("network");
      },
    });
    expect(result.action).toBe("dry-run-topup");
    expect(result.executed).toBe(false);
    expect(result.jupiterQuoteUrl).toContain(`amount=${FEE_PAYER_TOP_UP_USDC_MICROS.toString()}`);
    expect(result.jupiterQuoteUrl).toContain(USDC_MINT_MAINNET);
    expect(jupiterUsdcToSolQuoteUrl()).toBe(result.jupiterQuoteUrl);
    const text = lines.join("\n");
    expect(text).toContain("10 USDC");
    expect(text).toContain("dry-run: no Jupiter request was sent");
    expect(text).toContain("mock cluster never spends");
    expect(
      treasuryWillExecute(mockSolanaEngineConfig(), {
        ROSTER_TREASURY_EXECUTE: "1",
        ROSTER_TREASURY_DRY_RUN: "0",
      }),
    ).toBe(false);
  });

  it("calls Jupiter and the injected submitter only when mainnet execution is fully armed", async () => {
    const feePayer = Keypair.generate();
    const calls: string[] = [];
    let submitted = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "GET") {
        return new Response(JSON.stringify({ inAmount: "10000000", outAmount: "50000000" }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { userPublicKey?: string };
      expect(body.userPublicKey).toBe(feePayer.publicKey.toBase58());
      return new Response(JSON.stringify({ swapTransaction: "c3dhcA==" }), { status: 200 });
    };
    const result = await runTreasuryCheck({
      env: armedEnv(feePayer),
      lamports: LOW,
      fetchImpl,
      submitSwap: async (swapTransaction) => {
        submitted = swapTransaction;
        return "jupiter-test-signature";
      },
    });
    expect(result.action).toBe("topup");
    expect(result.dryRun).toBe(false);
    expect(result.executed).toBe(true);
    expect(result.signature).toBe("jupiter-test-signature");
    expect(submitted).toBe("c3dhcA==");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("quote-api.jup.ag");
    expect(calls[1]).toContain("POST");
    expect(treasuryWillExecute(
      {
        cluster: "mainnet-beta",
        allowMainnet: true,
        feePayerSecret: "present",
        rpcUrl: "http://127.0.0.1:9",
        feePayerPubkey: null,
        programAuthoritySecret: null,
        treasuryUsdcAta: null,
        send: false,
        simulatedFeePayerSol: null,
      },
      { ROSTER_TREASURY_EXECUTE: "1", ROSTER_TREASURY_DRY_RUN: "0" },
    )).toBe(true);
  });
});
