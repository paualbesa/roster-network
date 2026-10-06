/**
 * DEVNET non-custodial escrow helpers.
 * - `buildCreateAndFundTransaction`: returns a partially prepared instruction set for buyer signature.
 * - `signAndSendWithServerBuyer`: sandbox/Fleet path — server-held buyer keypair co-signs; fee payer sponsors.
 *
 * Keep `ROSTER_ESCROW_MODE=custodial-mock|noncustodial-sim` as fallback when this is unset/unavailable.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  createAndFundIx,
  noncustodialEscrowPda,
  refundIx,
  releaseIx,
  rosterEscrowProgramId,
  vaultPda,
} from "@albesa/solana";

export function schemaHashBytes(schema: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(schema)).digest();
}

export function buildFundInstructions(input: {
  buyer: PublicKey;
  buyerAta: PublicKey;
  seller: PublicKey;
  mint: PublicKey;
  escrowId: string;
  amountMicros: bigint;
  schema: unknown;
  deadlineTs: bigint;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? rosterEscrowProgramId();
  const ix = createAndFundIx({
    buyer: input.buyer,
    buyerAta: input.buyerAta,
    seller: input.seller,
    mint: input.mint,
    escrowId: input.escrowId,
    amount: input.amountMicros,
    schemaHash: schemaHashBytes(input.schema),
    deadlineTs: input.deadlineTs,
    programId,
  });
  const [escrow] = noncustodialEscrowPda(input.buyer, input.escrowId, programId);
  const [vault] = vaultPda(escrow, programId);
  return { ix, escrow, vault, programId };
}

/** Sandbox/Fleet: fee payer + server-held buyer wallet sign and broadcast. */
export async function signAndSendFund(input: {
  connection: Connection;
  feePayer: Keypair;
  buyer: Keypair;
  buyerAta: PublicKey;
  seller: PublicKey;
  mint: PublicKey;
  escrowId: string;
  amountMicros: bigint;
  schema: unknown;
  deadlineTs: bigint;
}): Promise<{ signature: string; escrow: string; vault: string }> {
  const { ix, escrow, vault } = buildFundInstructions({
    buyer: input.buyer.publicKey,
    buyerAta: input.buyerAta,
    seller: input.seller,
    mint: input.mint,
    escrowId: input.escrowId,
    amountMicros: input.amountMicros,
    schema: input.schema,
    deadlineTs: input.deadlineTs,
  });
  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(input.connection, tx, [input.feePayer, input.buyer]);
  return { signature, escrow: escrow.toBase58(), vault: vault.toBase58() };
}

export async function signAndSendRelease(input: {
  connection: Connection;
  feePayer: Keypair;
  authority: Keypair;
  escrow: PublicKey;
  vault: PublicKey;
  sellerAta: PublicKey;
  feeAta: PublicKey;
  mint: PublicKey;
}): Promise<string> {
  const ix = releaseIx({
    authority: input.authority.publicKey,
    escrow: input.escrow,
    vault: input.vault,
    sellerAta: input.sellerAta,
    feeAta: input.feeAta,
    mint: input.mint,
  });
  return sendAndConfirmTransaction(input.connection, new Transaction().add(ix), [
    input.feePayer,
    input.authority,
  ]);
}

export async function signAndSendRefund(input: {
  connection: Connection;
  feePayer: Keypair;
  authority: Keypair;
  escrow: PublicKey;
  vault: PublicKey;
  buyerAta: PublicKey;
  mint: PublicKey;
}): Promise<string> {
  const ix = refundIx({
    authority: input.authority.publicKey,
    escrow: input.escrow,
    vault: input.vault,
    buyerAta: input.buyerAta,
    mint: input.mint,
  });
  return sendAndConfirmTransaction(input.connection, new Transaction().add(ix), [
    input.feePayer,
    input.authority,
  ]);
}
