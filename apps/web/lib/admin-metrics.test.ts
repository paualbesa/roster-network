import { describe, expect, it } from "vitest";
import {
  formatOperatorTime,
  formatPercent,
  formatUsdcDisplay,
  jobActivity,
  jobMatchesFilter,
  summarizeReputation,
  weekdayLabel,
} from "./admin-metrics";

describe("admin dashboard metrics", () => {
  it("formats USDC for cards and leaves unknown strings alone", () => {
    expect(formatUsdcDisplay("1.000000")).toBe("1.00");
    expect(formatUsdcDisplay("0.010000")).toBe("0.01");
    expect(formatUsdcDisplay("1000.000000")).toBe("1,000.00");
    expect(formatUsdcDisplay("1.234500")).toBe("1.2345");
    expect(formatUsdcDisplay("not-money")).toBe("not-money");
  });

  it("formats operator timestamps in UTC", () => {
    expect(formatOperatorTime(null)).toBe("—");
    expect(formatOperatorTime("2026-10-02T21:04:00.000Z")).toBe("2026-10-02 21:04 UTC");
    expect(formatOperatorTime("soon")).toBe("soon");
  });

  it("matches the admin job status filter", () => {
    expect(jobMatchesFilter("held", "locked")).toBe(true);
    expect(jobMatchesFilter("locked", "locked")).toBe(true);
    expect(jobMatchesFilter("released", "locked")).toBe(false);
    expect(jobMatchesFilter("timed_out", "timed_out")).toBe(true);
    expect(jobMatchesFilter("refunded", "failed")).toBe(true);
    expect(jobMatchesFilter("failed", "failed")).toBe(true);
    expect(jobMatchesFilter("held", "all")).toBe(true);
  });

  it("summarizes passport scores and success rate", () => {
    expect(summarizeReputation([])).toEqual({
      passports: 0,
      averageScore: null,
      successRate: null,
      successes: 0,
      failures: 0,
    });
    const summary = summarizeReputation([
      { score: "90.0000", successCount: 3, failureCount: 1 },
      { score: "80.0000", successCount: 1, failureCount: 1 },
    ]);
    expect(summary.passports).toBe(2);
    expect(summary.averageScore).toBe("85.00");
    expect(summary.successRate).toBeCloseTo(4 / 6);
    expect(formatPercent(summary.successRate)).toBe("67%");
    expect(formatPercent(null)).toBe("—");
  });

  it("buckets released volume into the trailing UTC week", () => {
    const now = new Date("2026-10-02T21:00:00.000Z");
    const series = jobActivity(
      [
        { createdAt: "2026-10-02T10:00:00.000Z", status: "released", amountUsdc: "1.500000" },
        { createdAt: "2026-10-02T11:00:00.000Z", status: "held", amountUsdc: "2.000000" },
        { createdAt: "2026-09-20T11:00:00.000Z", status: "released", amountUsdc: "9.000000" },
        { createdAt: "not-a-date", status: "released", amountUsdc: "4.000000" },
      ],
      now,
      7,
    );
    expect(series).toHaveLength(7);
    expect(series[0]?.day).toBe("2026-09-26");
    expect(series[6]).toEqual({ day: "2026-10-02", jobs: 2, volumeUsdc: 1.5 });
    expect(series.slice(0, 6).every((point) => point.jobs === 0)).toBe(true);
    expect(weekdayLabel("2026-10-02")).toBe("Fri");
  });
});
