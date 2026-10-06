import { createHash } from "node:crypto";
import {
  DEVNET_ESCROW_PROGRAM_ID,
  formatUsdc,
  parseUsdc,
  SIM_ESCROW_PROGRAM_ID,
  type EscrowCustody,
  type EscrowMode,
  type ResultSchema,
} from "@albesa/core";
import { noncustodialVaultAddress } from "@albesa/solana";

/** On-chain Roster fee the escrow program would route at release: 1% + 0.003 USDC, capped at the price. */
export function quoteOnChainEscrowFee(amountUsdc: string): string {
  const amount = parseUsdc(amountUsdc);
  const fee = (amount * 100n) / 10_000n + 3_000n;
  return formatUsdc(fee > amount ? amount : fee);
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** Canonical lock intent the buyer wallet signs in the non-custodial design (see docs/ESCROW_NON_CUSTODIAL.md). */
export function escrowLockIntent(input: {
  escrowId: string;
  buyerAddress: string;
  sellerAddress: string;
  amountUsdc: string;
  schema: ResultSchema;
  programId: string;
  vault: string;
}): string {
  const schemaHash = digest(JSON.stringify(input.schema));
  return [
    "roster-escrow-lock:v1",
    `program=${input.programId}`,
    `escrow=${input.escrowId}`,
    `vault=${input.vault}`,
    `buyer=${input.buyerAddress}`,
    `seller=${input.sellerAddress}`,
    `amount=${input.amountUsdc}`,
    `fee=${quoteOnChainEscrowFee(input.amountUsdc)}`,
    `schema=${schemaHash}`,
  ].join("\n");
}

/** PDA-like vault address: seeds ("escrow", escrowId, buyer) under the simulated program. */
export function simulatedEscrowVault(escrowId: string, buyerAddress: string): string {
  return `sim-pda:${digest("escrow", SIM_ESCROW_PROGRAM_ID, escrowId, buyerAddress).slice(0, 40)}`;
}

/**
 * Custody record stored on each escrow.
 * `noncustodial-sim` still settles on the sandbox mock rail; the record models
 * who would control funds on-chain (the program, not Roster).
 */
export function buildEscrowCustody(
  mode: EscrowMode,
  input: {
    escrowId: string;
    buyerAddress: string;
    sellerAddress: string;
    amountUsdc: string;
    schema: ResultSchema;
    signedAt: string;
  },
): EscrowCustody {
  if (mode === "custodial-mock") {
    return {
      mode,
      custodian: "roster",
      programId: null,
      vault: null,
      buyerAuthorization: null,
      releaseAuthority: "roster-operator",
      onChainFeeUsdc: null,
    };
  }

  if (mode === "noncustodial-devnet") {
    const programId = process.env.ROSTER_ESCROW_PROGRAM_ID?.trim() || DEVNET_ESCROW_PROGRAM_ID;
    let vault: string;
    try {
      vault = noncustodialVaultAddress(input.buyerAddress, input.escrowId, programId);
    } catch {
      vault = `devnet-pda:${digest("vault", programId, input.escrowId, input.buyerAddress).slice(0, 40)}`;
    }
    const message = escrowLockIntent({ ...input, programId, vault });
    return {
      mode,
      custodian: "program",
      programId,
      vault,
      buyerAuthorization: {
        signer: input.buyerAddress,
        message,
        // Server-wallet path fills a real sig when broadcasting; placeholder until then.
        signature: `pending-buyer-sig:${digest("sig", input.buyerAddress, message).slice(0, 16)}`,
        signedAt: input.signedAt,
      },
      releaseAuthority: "program-rules",
      onChainFeeUsdc: quoteOnChainEscrowFee(input.amountUsdc),
    };
  }

  const vault = simulatedEscrowVault(input.escrowId, input.buyerAddress);
  const message = escrowLockIntent({ ...input, programId: SIM_ESCROW_PROGRAM_ID, vault });
  return {
    mode,
    custodian: "program",
    programId: SIM_ESCROW_PROGRAM_ID,
    vault,
    buyerAuthorization: {
      signer: input.buyerAddress,
      message,
      signature: `sim-ed25519:${digest("sig", input.buyerAddress, message)}`,
      signedAt: input.signedAt,
    },
    releaseAuthority: "program-rules",
    onChainFeeUsdc: quoteOnChainEscrowFee(input.amountUsdc),
  };
}
