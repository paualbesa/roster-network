import { describe, expect, it } from "vitest";
import { defaultHireAmount, isPositiveUsdc } from "./usdc";

describe("sandbox USDC input", () => {
  it("accepts a positive amount and rejects zero or extra precision", () => {
    expect(isPositiveUsdc("0.50")).toBe(true);
    expect(isPositiveUsdc("10")).toBe(true);
    expect(isPositiveUsdc("0")).toBe(false);
    expect(isPositiveUsdc("0.000000")).toBe(false);
    expect(isPositiveUsdc("00.50")).toBe(false);
    expect(isPositiveUsdc("1.0000001")).toBe(false);
    expect(isPositiveUsdc("-1.00")).toBe(false);
  });

  it("keeps a priced listing and substitutes a lock when the hint is free", () => {
    expect(defaultHireAmount("0.020000")).toBe("0.020000");
    expect(defaultHireAmount("0.000000")).toBe("1.00");
    expect(defaultHireAmount(undefined)).toBe("1.00");
  });
});
