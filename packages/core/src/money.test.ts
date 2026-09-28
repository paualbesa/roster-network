import { describe, expect, it } from "vitest";
import { addUsdc, compareUsdc, formatUsdc, parseUsdc } from "./money.js";
import { quoteSandboxFee } from "./fees.js";

describe("USDC amounts", () => {
  it("round-trips micro units without binary float error", () => {
    expect(parseUsdc("0.15")).toBe(150_000n);
    expect(formatUsdc(150_000n)).toBe("0.150000");
    expect(addUsdc("0.10", "0.05")).toBe("0.150000");
    expect(compareUsdc("10.00", "10.000000")).toBe(0);
  });

  it("rejects malformed amounts", () => {
    expect(() => parseUsdc("1.2.3")).toThrow(/Invalid USDC amount/);
    expect(() => parseUsdc("-1.00")).toThrow(/Invalid USDC amount/);
    expect(() => parseUsdc("abc")).toThrow(/Invalid USDC amount/);
  });
});

describe("sandbox fee", () => {
  it("charges 1% plus 0.01 USDC", () => {
    expect(quoteSandboxFee("0.15")).toBe("0.011500");
    expect(quoteSandboxFee("10")).toBe("0.110000");
  });
});
