/**
 * Type guard + helpers for wallets that can settle via the on-chain roster-escrow program.
 */
import type { ChainId } from "@albesa/core";

export interface ProgramEscrowFundInput {
  escrowId: string;
  buyerAddress: string;
  sellerAddress: string;
  amountUsdc: string;
  schema: unknown;
  /** Absolute unix seconds deadline for permissionless refund. */
  deadlineTs: number;
}

export interface ProgramEscrowFundResult {
  providerRef: string;
  vault: string;
  escrowPda: string;
  programId: string;
  chain: ChainId;
  lockExplorerUrl: string | null;
  vaultExplorerUrl: string | null;
  programExplorerUrl: string | null;
}

export interface ProgramEscrowSettleInput {
  escrowId: string;
  buyerAddress: string;
  sellerAddress: string;
}

export interface ProgramEscrowSettleResult {
  providerRef: string;
  chain: ChainId;
  explorerUrl: string | null;
}

/** Optional capability on WalletProvider implementations (solana-devnet). */
export interface ProgramEscrowRail {
  readonly programEscrowEnabled: true;
  programFundEscrow(input: ProgramEscrowFundInput): Promise<ProgramEscrowFundResult>;
  programReleaseEscrow(input: ProgramEscrowSettleInput): Promise<ProgramEscrowSettleResult>;
  programRefundEscrow(input: ProgramEscrowSettleInput & { permissionless?: boolean }): Promise<ProgramEscrowSettleResult>;
  programDisputeEscrow(input: { escrowId: string; partyAddress: string; buyerAddress: string }): Promise<ProgramEscrowSettleResult>;
}

export function isProgramEscrowRail(wallets: unknown): wallets is ProgramEscrowRail {
  return (
    typeof wallets === "object" &&
    wallets !== null &&
    (wallets as { programEscrowEnabled?: boolean }).programEscrowEnabled === true &&
    typeof (wallets as ProgramEscrowRail).programFundEscrow === "function"
  );
}
