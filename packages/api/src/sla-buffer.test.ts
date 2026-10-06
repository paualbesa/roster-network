import { describe, expect, it } from "vitest";
import { DEVNET_SETTLEMENT_SLA_BUFFER_MS, effectiveJobSlaMs } from "./jobs.js";

describe("effectiveJobSlaMs", () => {
  it("keeps listing p95 on mock", () => {
    expect(effectiveJobSlaMs(400, "mock")).toBe(400);
    expect(effectiveJobSlaMs(400, null)).toBe(400);
  });

  it("adds Devnet settlement buffer without changing relative ranking", () => {
    expect(effectiveJobSlaMs(400, "solana-devnet")).toBe(400 + DEVNET_SETTLEMENT_SLA_BUFFER_MS);
    expect(effectiveJobSlaMs(1200, "solana-devnet")).toBe(1200 + DEVNET_SETTLEMENT_SLA_BUFFER_MS);
    expect(effectiveJobSlaMs(1200, "solana-devnet")).toBeGreaterThan(effectiveJobSlaMs(400, "solana-devnet"));
  });
});
