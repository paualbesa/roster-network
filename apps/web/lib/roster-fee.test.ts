import { quoteRosterNetworkFee } from "@albesa/solana";
import { describe, expect, it } from "vitest";
import {
  collectedOnRelease,
  describeRosterFee,
  quoteRosterFee,
  ROSTER_BASE_FEE_USDC,
  ROSTER_PERCENT_FEE,
  sandboxRailProblem,
  solanaJobPhase,
} from "./roster-fee";

describe("Roster fee display", () => {
  it("uses the gasless schedule of 1% plus 0.003 USDC", () => {
    expect(ROSTER_PERCENT_FEE).toBe(0.01);
    expect(ROSTER_BASE_FEE_USDC).toBe("0.003000");
    const quoted = quoteRosterFee("1");
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.quote).toEqual({
      jobPriceUsdc: "1.000000",
      percentFee: 0.01,
      baseFeeUsdc: "0.003000",
      rosterFeeUsdc: "0.013000",
      providerPayoutUsdc: "0.987000",
    });
    expect(quoteRosterFee("10")).toMatchObject({
      ok: true,
      quote: { rosterFeeUsdc: "0.103000", providerPayoutUsdc: "9.897000" },
    });
    expect(quoteRosterFee("0.15")).toMatchObject({
      ok: true,
      quote: { rosterFeeUsdc: "0.004500", providerPayoutUsdc: "0.145500" },
    });
    expect(quoteRosterFee("1.234567")).toMatchObject({
      ok: true,
      quote: { jobPriceUsdc: "1.234567", rosterFeeUsdc: "0.015345", providerPayoutUsdc: "1.219222" },
    });
  });

  it("matches the Solana fee engine for the same prices", () => {
    for (const price of ["1", "10", "0.15", "1.234567", "0.02", "0.005", "0.50"]) {
      const quoted = quoteRosterFee(price);
      expect(quoted.ok).toBe(true);
      if (!quoted.ok) continue;
      expect(quoted.quote).toEqual(quoteRosterNetworkFee(price));
    }
  });

  it("rejects a non-positive price and a price that cannot cover the fee", () => {
    expect(quoteRosterFee("0")).toMatchObject({ ok: false, code: "invalid_request" });
    expect(quoteRosterFee("nope")).toMatchObject({ ok: false, code: "invalid_request" });
    expect(quoteRosterFee("0.003")).toMatchObject({ ok: false, code: "fee_exceeds_price" });
    expect(() => quoteRosterNetworkFee("0.003")).toThrow(/greater than the Roster fee/);
  });

  it("collects the fee only after release and drops it on an SLA timeout", () => {
    const quoted = quoteRosterFee("1.00");
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    const released = describeRosterFee(quoted.quote, "released");
    expect(released.collectedFeeUsdc).toBe("0.013000");
    expect(released.providerPayoutUsdc).toBe("0.987000");
    expect(released.buyerRefundUsdc).toBe("0.000000");
    expect(released.settle).toBe(true);

    const timedOut = describeRosterFee(quoted.quote, "timed_out");
    expect(timedOut.quotedFeeUsdc).toBe("0.013000");
    expect(timedOut.collectedFeeUsdc).toBe("0.000000");
    expect(timedOut.providerPayoutUsdc).toBe("0.000000");
    expect(timedOut.buyerRefundUsdc).toBe("1.000000");
    expect(timedOut.settle).toBe(false);
    expect(timedOut.note).toMatch(/SLA timeout/);

    expect(describeRosterFee(quoted.quote, "refunded").collectedFeeUsdc).toBe("0.000000");
    expect(describeRosterFee(quoted.quote, "failed").providerPayoutUsdc).toBe("0.000000");
    expect(describeRosterFee(quoted.quote, "held").collectedFeeUsdc).toBe("0.000000");
    expect(describeRosterFee(quoted.quote, "held").providerPayoutUsdc).toBe("0.987000");
    expect(collectedOnRelease("released", "0.010000")).toBe("0.010000");
    expect(collectedOnRelease("timed_out", "0.010000")).toBe("0.000000");
    expect(collectedOnRelease("refunded", "0.010000")).toBe("0.000000");
  });

  it("settles only after a verified release and skips the fee when the price is too small", () => {
    expect(solanaJobPhase({ quoteOk: false, hasLock: false, hasSettlement: false, status: "held" })).toBe("skip-fee");
    expect(solanaJobPhase({ quoteOk: true, hasLock: false, hasSettlement: false, status: "held" })).toBe("prepare-lock");
    expect(solanaJobPhase({ quoteOk: true, hasLock: true, hasSettlement: false, status: "held" })).toBe(
      "await-verification",
    );
    expect(solanaJobPhase({ quoteOk: true, hasLock: true, hasSettlement: false, status: "released" })).toBe("settle");
    expect(solanaJobPhase({ quoteOk: true, hasLock: true, hasSettlement: true, status: "released" })).toBe("settled");
    expect(solanaJobPhase({ quoteOk: true, hasLock: true, hasSettlement: false, status: "timed_out" })).toBe(
      "refund-without-fee",
    );
    expect(solanaJobPhase({ quoteOk: true, hasLock: true, hasSettlement: false, status: "refunded" })).toBe(
      "refund-without-fee",
    );
    expect(sandboxRailProblem({ cluster: "mock", broadcast: false })).toBeNull();
    expect(sandboxRailProblem({ cluster: "devnet", broadcast: false })).toMatch(/mock/);
    expect(sandboxRailProblem({ cluster: "mock", broadcast: true })).toMatch(/broadcast false/);
  });
});
