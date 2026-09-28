import type { ChainId } from "../types.js";

/** Sandbox take-rate: 1% of escrow GMV (inside the 0.5–1.5% product band). */
export const ESCROW_TAKE_RATE_BPS = 100;

export type EscrowStatus = "held" | "released" | "refunded";

export type SchemaNodeType = "object" | "array" | "string" | "number" | "integer" | "boolean";

/**
 * JSON Schema subset stored on an escrow and checked when the seller delivers.
 * Unknown keywords are rejected at create time so a typo cannot skip a constraint.
 */
export interface SchemaNode {
  type: SchemaNodeType;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  enum?: (string | number | boolean)[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface ResultSchema extends SchemaNode {
  type: "object";
}

export interface SchemaHookResult {
  ok: boolean;
  errors: string[];
}

/** Pluggable check. The default hook is {@link validateResult}. A failure refunds the buyer. */
export type SchemaValidationHook = (schema: ResultSchema, result: unknown) => SchemaHookResult;

export interface EscrowSettlementQuote {
  takeRateBps: number;
  takeRateUsdc: string;
  sellerNetUsdc: string;
}

/**
 * Programmable escrow.
 * `held` means the buyer lock sits on a mock custody address (spendable balance reserved).
 * Delivery runs the schema hook: match releases net USDC to the seller, mismatch refunds the buyer.
 */
export interface Escrow {
  id: string;
  organizationId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  buyerWalletId: string;
  sellerWalletId: string;
  amountUsdc: string;
  takeRateBps: number;
  takeRateUsdc: string;
  sellerNetUsdc: string;
  status: EscrowStatus;
  schema: ResultSchema;
  result: unknown;
  validationErrors: string[] | null;
  holdAddress: string;
  chain: ChainId;
  asset: "USDC";
  lockProviderRef: string;
  settlementProviderRef: string | null;
  feeProviderRef: string | null;
  memo: string | null;
  createdAt: string;
  notifiedAt: string;
  settledAt: string | null;
}
