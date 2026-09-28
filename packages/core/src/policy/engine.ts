import { formatUsdc, MoneyError, parseUsdc } from "../money.js";
import type { Policy, PolicyBlockReason, Transaction } from "../types.js";

export interface PolicyDecision {
  allowed: boolean;
  reason?: PolicyBlockReason;
  message?: string;
}

export interface SpendEvaluationInput {
  policy: Pick<Policy, "dailySpendLimitUsdc" | "vendorAllowlist">;
  amountUsdc: string;
  vendorId: string;
  spentTodayUsdc: string;
}

export function evaluateSpend(input: SpendEvaluationInput): PolicyDecision {
  let amount: bigint;
  let spent: bigint;
  let limit: bigint;
  try {
    amount = parseUsdc(input.amountUsdc);
    spent = parseUsdc(input.spentTodayUsdc);
    limit = parseUsdc(input.policy.dailySpendLimitUsdc);
  } catch (error) {
    const message = error instanceof MoneyError ? error.message : "Amount is not a valid USDC value.";
    return { allowed: false, reason: "invalid_amount", message };
  }

  if (amount <= 0n || spent < 0n || limit < 0n) {
    return {
      allowed: false,
      reason: "invalid_amount",
      message: "Amount must be greater than zero and within the daily limit.",
    };
  }

  if (!input.policy.vendorAllowlist.includes(input.vendorId)) {
    return {
      allowed: false,
      reason: "vendor_not_allowlisted",
      message: `Vendor "${input.vendorId}" is not on the agent allowlist.`,
    };
  }

  if (spent + amount > limit) {
    return {
      allowed: false,
      reason: "daily_limit_exceeded",
      message: `Payment of ${formatUsdc(amount)} USDC plus ${formatUsdc(spent)} already spent exceeds the daily limit of ${formatUsdc(limit)} USDC.`,
    };
  }

  return { allowed: true };
}

type SpendTransaction = Pick<
  Transaction,
  "type" | "status" | "agentId" | "amountUsdc" | "createdAt"
>;

export function sumSpentTodayUsdc(
  transactions: readonly SpendTransaction[],
  agentId: string,
  now: Date,
): string {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let total = 0n;
  for (const tx of transactions) {
    if (tx.agentId !== agentId || tx.type !== "payment" || tx.status !== "settled") continue;
    const createdAt = Date.parse(tx.createdAt);
    if (Number.isNaN(createdAt) || createdAt < start) continue;
    total += parseUsdc(tx.amountUsdc);
  }
  return formatUsdc(total);
}
