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

/**
 * Who controls the locked funds.
 * - `custodial-mock`: the sandbox default. The lock moves to a Roster-minted mock hold address.
 * - `noncustodial-sim`: models the planned on-chain escrow. The buyer wallet signs a lock
 *   intent, funds sit in a program-derived vault (PDA) that no Roster key can spend, and
 *   release/refund follow program rules. Still the mock rail underneath; nothing is broadcast.
 * - `noncustodial-devnet`: real `roster-escrow` program on Solana DEVNET. Buyer-signed flows;
 *   sandbox/Fleet may use the server-held wallet path to co-sign as the buyer agent.
 */
export type EscrowMode = "custodial-mock" | "noncustodial-sim" | "noncustodial-devnet";

export const ESCROW_MODES: readonly EscrowMode[] = [
  "custodial-mock",
  "noncustodial-sim",
  "noncustodial-devnet",
];

/** Live DEVNET program id (programs/roster-escrow). */
export const DEVNET_ESCROW_PROGRAM_ID = "9kEkd18dibRCwMS7tesWE2nYgg5zR4QqqS7oYYeCFL61";

/** Simulated program that would own non-custodial escrow vaults (never deployed). */
export const SIM_ESCROW_PROGRAM_ID = "RosterEscrowSim111111111111111111111111111";

export interface EscrowBuyerAuthorization {
  /** Buyer wallet address that signed the lock intent. */
  signer: string;
  /** Canonical lock intent the buyer signs (escrow id, amount, seller, fee, schema hash, program). */
  message: string;
  /** Simulated ed25519 signature over `message`. Not a real signature. */
  signature: string;
  signedAt: string;
}

export interface EscrowCustody {
  mode: EscrowMode;
  /** `roster` for the custodial mock; `program` when a PDA vault holds the funds. */
  custodian: "roster" | "program";
  programId: string | null;
  /** Program-derived vault address for the lock. */
  vault: string | null;
  buyerAuthorization: EscrowBuyerAuthorization | null;
  /** Who may move the funds once held. */
  releaseAuthority: "roster-operator" | "program-rules";
  /** Fee the program would route to the Roster fee account at release (1% + flat). */
  onChainFeeUsdc: string | null;
}

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
  /** Custody model at lock time. Absent on escrows locked before escrow modes existed. */
  custody?: EscrowCustody;
}
