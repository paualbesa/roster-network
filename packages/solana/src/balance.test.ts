import { describe, expect, it } from "vitest";
import { readFeePayerSolBalance, formatSol, parseSol } from "./balance.js";
import { FEE_PAYER_MIN_LAMPORTS } from "./constants.js";
import { mockSolanaEngineConfig } from "./config.js";

describe("fee payer SOL balance", () => {
  it("formats lamports and treats 0.02 SOL as the top-up line", () => {
    expect(formatSol(FEE_PAYER_MIN_LAMPORTS)).toBe("0.020000000");
    expect(parseSol("0.02")).toBe(FEE_PAYER_MIN_LAMPORTS);
    expect(parseSol("1")).toBe(1_000_000_000n);
  });

  it("simulates a healthy balance in mock mode and flags anything under 0.02 SOL", async () => {
    const healthy = await readFeePayerSolBalance(mockSolanaEngineConfig());
    expect(healthy).toMatchObject({ sol: "1.000000000", source: "simulated", belowMinimum: false });

    const low = await readFeePayerSolBalance(mockSolanaEngineConfig({ simulatedFeePayerSol: "0.019" }));
    expect(low.belowMinimum).toBe(true);
    expect(low.sol).toBe("0.019000000");

    const exact = await readFeePayerSolBalance(mockSolanaEngineConfig(), { lamports: FEE_PAYER_MIN_LAMPORTS });
    expect(exact.belowMinimum).toBe(false);
  });
});
