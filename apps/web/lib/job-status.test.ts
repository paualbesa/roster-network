import { describe, expect, it } from "vitest";
import { isTerminalJobStatus, jobStatusLabel, pollUntilTerminal } from "./job-status";

describe("job status", () => {
  it("stops on release, timeout, failure, and refund", () => {
    expect(isTerminalJobStatus("released")).toBe(true);
    expect(isTerminalJobStatus("timed_out")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
    expect(isTerminalJobStatus("refunded")).toBe(true);
    expect(isTerminalJobStatus("held")).toBe(false);
    expect(jobStatusLabel("timed_out")).toBe("Timed out");
    expect(jobStatusLabel("released")).toBe("Released");
  });

  it("polls until a terminal status and counts each read", async () => {
    const statuses = ["held", "held", "released"];
    const sleeps: number[] = [];
    const snapshot = await pollUntilTerminal({
      read: async () => ({ status: statuses.shift() ?? "held", amountUsdc: "1.000000" }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      intervalMs: 25,
      maxAttempts: 5,
    });
    expect(snapshot.done).toBe(true);
    expect(snapshot.attempts).toBe(3);
    expect(snapshot.value.status).toBe("released");
    expect(sleeps).toEqual([25, 25]);
  });

  it("stops after the attempt cap while escrow is still held", async () => {
    const snapshot = await pollUntilTerminal({
      read: async () => ({ status: "held" }),
      sleep: async () => undefined,
      intervalMs: 1,
      maxAttempts: 2,
    });
    expect(snapshot.done).toBe(false);
    expect(snapshot.attempts).toBe(2);
    expect(snapshot.value.status).toBe("held");
  });
});
