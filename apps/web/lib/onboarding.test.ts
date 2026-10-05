import { describe, expect, it } from "vitest";
import { onboardingSteps } from "./onboarding";
import type { ConsoleAgent, ConsoleJob } from "./roster-client";

const agent = (balanceUsdc: string) => ({ id: "agt_1", name: "buyer", balanceUsdc }) as unknown as ConsoleAgent;
const job = (status: string) => ({ id: "job_1", status }) as unknown as ConsoleJob;

describe("console onboarding", () => {
  it("starts with nothing done", () => {
    expect(onboardingSteps([], []).map((step) => step.done)).toEqual([false, false, false, false]);
  });

  it("tracks agent, funding, hire, and settlement", () => {
    expect(onboardingSteps([agent("0.000000")], []).map((step) => step.done)).toEqual([true, false, false, false]);
    expect(onboardingSteps([agent("5.000000")], [job("held")]).map((step) => step.done)).toEqual([true, true, true, false]);
    expect(onboardingSteps([agent("4.000000")], [job("released")]).every((step) => step.done)).toBe(true);
  });
});
