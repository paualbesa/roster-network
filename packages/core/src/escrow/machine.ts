import { formatUsdc, parseUsdc } from "../money.js";
import { validateResult } from "./schema.js";
import type { EscrowSettlementQuote, EscrowStatus, ResultSchema, SchemaValidationHook } from "./types.js";
import { ESCROW_TAKE_RATE_BPS } from "./types.js";

export class EscrowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowTransitionError";
  }
}

export interface SettlementDecision {
  status: "released" | "refunded";
  validationErrors: string[] | null;
}

/**
 * Quote the seller's net after the sandbox take-rate.
 * The rate truncates to the nearest micro-USDC and is deducted from the locked amount.
 */
export function quoteEscrowSettlement(amountUsdc: string, takeRateBps = ESCROW_TAKE_RATE_BPS): EscrowSettlementQuote {
  if (!Number.isInteger(takeRateBps) || takeRateBps < 0 || takeRateBps > 10_000) {
    throw new EscrowTransitionError("Take rate must be an integer from 0 to 10000 basis points.");
  }
  const amount = parseUsdc(amountUsdc);
  if (amount <= 0n) throw new EscrowTransitionError("Escrow amount must be greater than zero.");
  const take = (amount * BigInt(takeRateBps)) / 10_000n;
  return {
    takeRateBps,
    takeRateUsdc: formatUsdc(take),
    sellerNetUsdc: formatUsdc(amount - take),
  };
}

export function assertEscrowHeld(status: EscrowStatus): void {
  if (status === "held") return;
  throw new EscrowTransitionError(`Escrow is already ${status} and cannot accept a delivery.`);
}

/**
 * held + schema match → released
 * held + schema mismatch (or a hook that reports failure) → refunded
 * released and refunded are terminal
 */
export function decideSettlement(
  status: EscrowStatus,
  schema: ResultSchema,
  result: unknown,
  validate: SchemaValidationHook = validateResult,
): SettlementDecision {
  assertEscrowHeld(status);
  const verdict = validate(schema, result);
  if (verdict.ok && verdict.errors.length === 0) {
    return { status: "released", validationErrors: null };
  }
  const validationErrors = verdict.errors.length > 0 ? verdict.errors : ["Result did not match the escrow schema."];
  return { status: "refunded", validationErrors };
}
