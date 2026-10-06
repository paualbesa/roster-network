import { describe, expect, it } from "vitest";
import { payoutHint, relativeTime, takeRateLabel, trimUsdc } from "./sell";

describe("sell helpers", () => {
  it("checks payout address formats", () => {
    expect(payoutHint("solana", "So11111111111111111111111111111111111111112")).toBeNull();
    expect(payoutHint("solana", "0xabc")).toMatch(/base58/);
    expect(payoutHint("base", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBeNull();
    expect(payoutHint("base", "So11111111111111111111111111111111111111112")).toMatch(/0x/);
    expect(payoutHint("base", " ")).toMatch(/Paste/);
  });

  it("formats take-rates, amounts and ages", () => {
    expect(takeRateLabel(0)).toBe("0%");
    expect(takeRateLabel(100)).toBe("1%");
    expect(takeRateLabel(150)).toBe("1.50%");
    expect(trimUsdc("0.020000")).toBe("0.02");
    expect(trimUsdc("1.000000")).toBe("1.00");
    expect(trimUsdc("0.002500")).toBe("0.0025");
    const now = Date.parse("2026-10-06T10:00:00Z");
    expect(relativeTime("2026-10-06T09:59:30Z", now)).toBe("30s ago");
    expect(relativeTime("2026-10-06T09:00:00Z", now)).toBe("1h ago");
    expect(relativeTime("2026-10-01T10:00:00Z", now)).toBe("5d ago");
  });
});
