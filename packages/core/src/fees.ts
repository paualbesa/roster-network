import { formatUsdc, parseUsdc } from "./money.js";

/** Sandbox plan: 1.0% + 0.01 USDC. Variable fee truncates to the nearest micro-USDC. */
export const SANDBOX_FEE_SCHEDULE = {
  bps: 100,
  fixedUsdc: "0.010000",
} as const;

export const SANDBOX_TREASURY_GRANT_USDC = "1000.000000";

export const SANDBOX_MAX_ACTIVE_AGENTS = 5;

export function quoteSandboxFee(amountUsdc: string): string {
  const amount = parseUsdc(amountUsdc);
  const variable = (amount * BigInt(SANDBOX_FEE_SCHEDULE.bps)) / 10_000n;
  const fixed = parseUsdc(SANDBOX_FEE_SCHEDULE.fixedUsdc);
  return formatUsdc(variable + fixed);
}
