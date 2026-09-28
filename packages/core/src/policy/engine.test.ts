import { describe, expect, it } from "vitest";
import type { Transaction } from "../types.js";
import { evaluateSpend, sumSpentTodayUsdc } from "./engine.js";

const policy = {
  dailySpendLimitUsdc: "10.00",
  vendorAllowlist: ["vendor_data", "vendor_gpu"],
};

describe("evaluateSpend", () => {
  it("allows a compliant send under the daily limit", () => {
    const decision = evaluateSpend({
      policy,
      amountUsdc: "0.15",
      vendorId: "vendor_data",
      spentTodayUsdc: "0.00",
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("allows a send that lands exactly on the daily limit", () => {
    const decision = evaluateSpend({
      policy,
      amountUsdc: "0.50",
      vendorId: "vendor_gpu",
      spentTodayUsdc: "9.50",
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks spends over the daily limit", () => {
    const decision = evaluateSpend({
      policy,
      amountUsdc: "2.00",
      vendorId: "vendor_data",
      spentTodayUsdc: "9.00",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("daily_limit_exceeded");
  });

  it("blocks a send that exceeds the limit by one micro-USDC", () => {
    const decision = evaluateSpend({
      policy,
      amountUsdc: "0.000001",
      vendorId: "vendor_data",
      spentTodayUsdc: "10.00",
    });
    expect(decision.reason).toBe("daily_limit_exceeded");
  });

  it("blocks vendors that are not allowlisted", () => {
    const decision = evaluateSpend({
      policy,
      amountUsdc: "0.15",
      vendorId: "vendor_unknown",
      spentTodayUsdc: "0",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("vendor_not_allowlisted");
  });

  it("fails closed when the allowlist is empty", () => {
    const decision = evaluateSpend({
      policy: { dailySpendLimitUsdc: "10", vendorAllowlist: [] },
      amountUsdc: "0.15",
      vendorId: "vendor_data",
      spentTodayUsdc: "0",
    });
    expect(decision.reason).toBe("vendor_not_allowlisted");
  });

  it("blocks zero, negative, and malformed amounts", () => {
    expect(
      evaluateSpend({
        policy,
        amountUsdc: "0",
        vendorId: "vendor_data",
        spentTodayUsdc: "0",
      }).reason,
    ).toBe("invalid_amount");
    expect(
      evaluateSpend({
        policy,
        amountUsdc: "-1",
        vendorId: "vendor_data",
        spentTodayUsdc: "0",
      }).reason,
    ).toBe("invalid_amount");
    expect(
      evaluateSpend({
        policy,
        amountUsdc: "nope",
        vendorId: "vendor_data",
        spentTodayUsdc: "0",
      }).reason,
    ).toBe("invalid_amount");
  });
});

describe("sumSpentTodayUsdc", () => {
  const agentId = "agt_test";

  function payment(overrides: Partial<Transaction> & Pick<Transaction, "createdAt" | "amountUsdc">): Transaction {
    return {
      id: "txn_test",
      organizationId: "org_test",
      agentId,
      type: "payment",
      status: "settled",
      fromWalletId: "wal_test",
      toAddress: "mock:vendor:vendor_data",
      vendorId: "vendor_data",
      feeUsdc: "0.010000",
      rejectionReason: null,
      providerRef: "mock_tx_1",
      chain: "mock",
      memo: null,
      ...overrides,
    };
  }

  it("sums settled payments for the agent inside the current UTC day", () => {
    const now = new Date("2026-09-28T18:00:00.000Z");
    const total = sumSpentTodayUsdc(
      [
        payment({ createdAt: "2026-09-28T01:00:00.000Z", amountUsdc: "0.150000" }),
        payment({ createdAt: "2026-09-28T12:00:00.000Z", amountUsdc: "1.000000", id: "txn_2" }),
        payment({
          createdAt: "2026-09-27T23:59:59.000Z",
          amountUsdc: "9.000000",
          id: "txn_yesterday",
        }),
        payment({
          createdAt: "2026-09-28T02:00:00.000Z",
          amountUsdc: "4.000000",
          status: "rejected",
          id: "txn_rejected",
        }),
        payment({
          createdAt: "2026-09-28T02:00:00.000Z",
          amountUsdc: "3.000000",
          type: "fund",
          id: "txn_fund",
        }),
        payment({
          createdAt: "2026-09-28T02:00:00.000Z",
          amountUsdc: "8.000000",
          agentId: "agt_other",
          id: "txn_other",
        }),
      ],
      agentId,
      now,
    );
    expect(total).toBe("1.150000");
  });
});
