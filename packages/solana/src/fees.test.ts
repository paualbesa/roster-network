import { describe, expect, it } from "vitest";
import { ROSTER_BASE_FEE_USDC, ROSTER_PERCENT_FEE } from "./constants.js";
import { quoteRosterNetworkFee } from "./fees.js";

describe("Roster network fee", () => {
  it("exports the gasless schedule", () => {
    expect(ROSTER_PERCENT_FEE).toBe(0.01);
    expect(ROSTER_BASE_FEE_USDC).toBe(0.003);
  });

  it("charges 1% plus 0.003 USDC and pays the provider the remainder", () => {
    expect(quoteRosterNetworkFee("1")).toEqual({
      jobPriceUsdc: "1.000000",
      percentFee: 0.01,
      baseFeeUsdc: "0.003000",
      rosterFeeUsdc: "0.013000",
      providerPayoutUsdc: "0.987000",
    });
    expect(quoteRosterNetworkFee("10")).toMatchObject({
      rosterFeeUsdc: "0.103000",
      providerPayoutUsdc: "9.897000",
    });
    expect(quoteRosterNetworkFee("0.15")).toMatchObject({
      rosterFeeUsdc: "0.004500",
      providerPayoutUsdc: "0.145500",
    });
  });

  it("truncates the percent leg to the nearest micro-USDC", () => {
    expect(quoteRosterNetworkFee("1.234567")).toMatchObject({
      jobPriceUsdc: "1.234567",
      rosterFeeUsdc: "0.015345",
      providerPayoutUsdc: "1.219222",
    });
  });

  it("rejects a non-positive price and a price that cannot cover the fee", () => {
    expect(() => quoteRosterNetworkFee("0")).toThrow(/greater than zero/);
    expect(() => quoteRosterNetworkFee("0.003")).toThrow(/greater than the Roster fee/);
    expect(() => quoteRosterNetworkFee("nope")).toThrow(/Invalid USDC amount/);
  });
});
