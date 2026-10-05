import type { ConsoleAgent, ConsoleJob } from "./roster-client";
import { isPositiveUsdc } from "./usdc";

export interface OnboardingStep {
  id: "agent" | "fund" | "hire" | "settle";
  label: string;
  done: boolean;
  href: string | null;
}

/** First-run checklist for the console dashboard. */
export function onboardingSteps(agents: readonly ConsoleAgent[], jobs: readonly ConsoleJob[]): OnboardingStep[] {
  const hasAgent = agents.length > 0;
  const funded = agents.some((agent) => isPositiveUsdc(agent.balanceUsdc));
  const hired = jobs.length > 0;
  const settled = jobs.some((job) => job.status === "released");
  return [
    { id: "agent", label: "Create a buyer agent", done: hasAgent, href: null },
    { id: "fund", label: "Fund it from the treasury", done: funded, href: null },
    { id: "hire", label: "Hire a listing in the marketplace", done: hired, href: "/console/marketplace" },
    { id: "settle", label: "Watch escrow release and the passport update", done: settled, href: "/console/marketplace" },
  ];
}
