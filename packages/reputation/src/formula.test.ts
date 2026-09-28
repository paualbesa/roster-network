import { describe, expect, it } from "vitest";
import {
  applyReputationEvent,
  emptyReputationTotals,
  normalizeReputationEvent,
  projectPassport,
  ReputationInputError,
} from "./formula.js";
import type { NormalizedReputationEvent, ReputationTotals } from "./types.js";

const AT = "2026-09-28T12:00:00.000Z";

function totalsAfter(events: NormalizedReputationEvent[]): ReputationTotals {
  return events.reduce(
    (totals, event) => applyReputationEvent(totals, event, AT),
    emptyReputationTotals("agt_1", "org_1"),
  );
}

function event(input: {
  outcome: "success" | "failure";
  latencyMs: number;
  volumeUsdc: string;
  error?: boolean;
  hallucination?: boolean;
}): NormalizedReputationEvent {
  return normalizeReputationEvent(input);
}

describe("passport score", () => {
  it("stays at zero when the agent has no events", () => {
    const passport = projectPassport(emptyReputationTotals("agt_1", "org_1"));
    expect(passport.score).toBe("0.0000");
    expect(passport.components).toEqual({
      successRate: "0.000000",
      latencyFactor: "0.000000",
      reliabilityFactor: "0.000000",
      volumeFactor: "0.000000",
    });
    expect(passport.metrics.eventCount).toBe(0);
    expect(passport.metrics.volumeSettledUsdc).toBe("0.000000");
    expect(passport.updatedAt).toBeNull();
    expect(passport.formula.id).toBe("roster.passport.v1");
  });

  it("raises the score after a fast successful settlement", () => {
    const passport = projectPassport(
      totalsAfter([event({ outcome: "success", latencyMs: 500, volumeUsdc: "100" })]),
    );
    expect(passport.metrics).toMatchObject({
      eventCount: 1,
      successCount: 1,
      failureCount: 0,
      volumeSettledUsdc: "100.000000",
      avgLatencyMs: "500.000",
      successRate: "1.000000",
      errorIndex: "0.000000",
    });
    expect(passport.components).toEqual({
      successRate: "1.000000",
      latencyFactor: "0.750000",
      reliabilityFactor: "1.000000",
      volumeFactor: "0.100000",
    });
    expect(passport.score).toBe("84.7500");
  });

  it("lowers the score when a slow failure is flagged as an error and a hallucination", () => {
    const afterSuccess = projectPassport(
      totalsAfter([event({ outcome: "success", latencyMs: 500, volumeUsdc: "100" })]),
    );
    const afterFailure = projectPassport(
      totalsAfter([
        event({ outcome: "success", latencyMs: 500, volumeUsdc: "100" }),
        event({
          outcome: "failure",
          latencyMs: 3000,
          volumeUsdc: "50",
          error: true,
          hallucination: true,
        }),
      ]),
    );
    expect(afterFailure.metrics).toMatchObject({
      eventCount: 2,
      successCount: 1,
      failureCount: 1,
      errorCount: 1,
      hallucinationCount: 1,
      volumeSettledUsdc: "100.000000",
      avgLatencyMs: "1750.000",
      successRate: "0.500000",
      errorIndex: "1.000000",
    });
    expect(afterFailure.components).toEqual({
      successRate: "0.500000",
      latencyFactor: "0.125000",
      reliabilityFactor: "0.000000",
      volumeFactor: "0.100000",
    });
    expect(afterFailure.score).toBe("26.6250");
    expect(Number(afterFailure.score)).toBeLessThan(Number(afterSuccess.score));
  });

  it("ignores volume on failure and caps the volume term at the reference amount", () => {
    const passport = projectPassport(
      totalsAfter([
        event({ outcome: "failure", latencyMs: 0, volumeUsdc: "500" }),
        event({ outcome: "success", latencyMs: 0, volumeUsdc: "10000" }),
      ]),
    );
    expect(passport.metrics.volumeSettledUsdc).toBe("10000.000000");
    expect(passport.components.volumeFactor).toBe("1.000000");
    expect(passport.metrics.successRate).toBe("0.500000");
    expect(passport.components.latencyFactor).toBe("1.000000");
    expect(passport.score).toBe("77.5000");
  });

  it("zeroes the latency factor once average latency reaches the 2000ms budget", () => {
    const onBudget = projectPassport(
      totalsAfter([event({ outcome: "success", latencyMs: 2000, volumeUsdc: "0" })]),
    );
    const overBudget = projectPassport(
      totalsAfter([event({ outcome: "success", latencyMs: 2001, volumeUsdc: "0" })]),
    );
    expect(onBudget.components.latencyFactor).toBe("0.000000");
    expect(overBudget.components.latencyFactor).toBe("0.000000");
    expect(onBudget.score).toBe("65.0000");
    expect(overBudget.score).toBe("65.0000");
  });

  it("clamps the error index at 1 when a single event sets both flags", () => {
    const passport = projectPassport(
      totalsAfter([
        event({ outcome: "success", latencyMs: 0, volumeUsdc: "0", error: true, hallucination: true }),
      ]),
    );
    expect(passport.metrics.errorIndex).toBe("1.000000");
    expect(passport.components.reliabilityFactor).toBe("0.000000");
    expect(passport.score).toBe("70.0000");
  });
});

describe("normalizeReputationEvent", () => {
  it("rejects a negative latency and a malformed amount", () => {
    expect(() => normalizeReputationEvent({ outcome: "success", latencyMs: -1, volumeUsdc: "1" })).toThrow(
      ReputationInputError,
    );
    expect(() => normalizeReputationEvent({ outcome: "success", latencyMs: 1, volumeUsdc: "1.0000001" })).toThrow(
      ReputationInputError,
    );
    expect(() => normalizeReputationEvent({ outcome: "failure", latencyMs: 1.5, volumeUsdc: "0" })).toThrow(
      ReputationInputError,
    );
  });
});
