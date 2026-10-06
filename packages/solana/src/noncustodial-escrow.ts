/**
 * Client helpers for the native `roster-escrow` program (PDA vault, non-custodial).
 * Instruction layouts must stay in lockstep with programs/roster-escrow/src/instruction.rs.
 */
import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID_BASE58 } from "./constants.js";

/** Devnet program id (matches declare_id! / deploy keypair). */
export const ROSTER_ESCROW_PROGRAM_ID_DEVNET = "9kEkd18dibRCwMS7tesWE2nYgg5zR4QqqS7oYYeCFL61";

/** Prepared mainnet config — DO NOT enable until audit + go-live checklist. */
export const ROSTER_ESCROW_MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const ROSTER_ESCROW_MAINNET_PER_JOB_CAP_USDC = "100.000000";

export const CONFIG_SEED = Buffer.from("config");
export const ESCROW_SEED = Buffer.from("escrow");
export const VAULT_SEED = Buffer.from("vault");

export function rosterEscrowProgramId(env: Record<string, string | undefined> = process.env): PublicKey {
  const raw = env.ROSTER_ESCROW_PROGRAM_ID?.trim() || ROSTER_ESCROW_PROGRAM_ID_DEVNET;
  return new PublicKey(raw);
}

export function configPda(programId: PublicKey = rosterEscrowProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

/** escrow_id is a 32-byte seed (sha256 of the API escrow string when longer). */
export function escrowIdBytes(escrowId: string): Buffer {
  const raw = Buffer.from(escrowId, "utf8");
  if (raw.length === 32) return raw;
  return createHash("sha256").update(raw).digest();
}

export function escrowPda(
  buyer: PublicKey,
  escrowId: string,
  programId: PublicKey = rosterEscrowProgramId(),
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, buyer.toBuffer(), escrowIdBytes(escrowId)],
    programId,
  );
}

export function vaultPda(escrow: PublicKey, programId: PublicKey = rosterEscrowProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, escrow.toBuffer()], programId);
}

function tokenProgram(): PublicKey {
  return new PublicKey(TOKEN_PROGRAM_ID_BASE58);
}

/** Borsh enum discriminant (u8) + payload — matches borsh 0.10 enum encoding. */
function ixData(variant: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from([variant]), payload]);
}

export function initializeConfigIx(input: {
  authority: PublicKey;
  feeRecipientToken: PublicKey;
  mint: PublicKey;
  arbiter: PublicKey;
  feeBps: number;
  flatFee: bigint;
  disputeWindowSecs: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = input.programId ?? rosterEscrowProgramId();
  const [config] = configPda(programId);
  const body = Buffer.alloc(32 + 2 + 8 + 8);
  input.arbiter.toBuffer().copy(body, 0);
  body.writeUInt16LE(input.feeBps, 32);
  body.writeBigUInt64LE(input.flatFee, 34);
  body.writeBigInt64LE(input.disputeWindowSecs, 42);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: input.feeRecipientToken, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData(0, body),
  });
}

export function createAndFundIx(input: {
  buyer: PublicKey;
  buyerAta: PublicKey;
  seller: PublicKey;
  mint: PublicKey;
  escrowId: string;
  amount: bigint;
  schemaHash: Buffer;
  deadlineTs: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = input.programId ?? rosterEscrowProgramId();
  const [config] = configPda(programId);
  const id = escrowIdBytes(input.escrowId);
  const [escrow] = escrowPda(input.buyer, input.escrowId, programId);
  const [vault] = vaultPda(escrow, programId);
  if (input.schemaHash.length !== 32) throw new Error("schemaHash must be 32 bytes");
  const body = Buffer.alloc(32 + 8 + 32 + 8);
  id.copy(body, 0);
  body.writeBigUInt64LE(input.amount, 32);
  input.schemaHash.copy(body, 40);
  body.writeBigInt64LE(input.deadlineTs, 72);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.buyer, isSigner: true, isWritable: true },
      { pubkey: input.buyerAta, isSigner: false, isWritable: true },
      { pubkey: input.seller, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: tokenProgram(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: ixData(1, body),
  });
}

export function releaseIx(input: {
  authority: PublicKey;
  escrow: PublicKey;
  vault: PublicKey;
  sellerAta: PublicKey;
  feeAta: PublicKey;
  mint: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = input.programId ?? rosterEscrowProgramId();
  const [config] = configPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.escrow, isSigner: false, isWritable: true },
      { pubkey: input.vault, isSigner: false, isWritable: true },
      { pubkey: input.sellerAta, isSigner: false, isWritable: true },
      { pubkey: input.feeAta, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: tokenProgram(), isSigner: false, isWritable: false },
    ],
    data: ixData(2),
  });
}

export function refundIx(input: {
  authority: PublicKey;
  escrow: PublicKey;
  vault: PublicKey;
  buyerAta: PublicKey;
  mint: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = input.programId ?? rosterEscrowProgramId();
  const [config] = configPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: input.escrow, isSigner: false, isWritable: true },
      { pubkey: input.vault, isSigner: false, isWritable: true },
      { pubkey: input.buyerAta, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: tokenProgram(), isSigner: false, isWritable: false },
    ],
    data: ixData(3),
  });
}

export function disputeIx(input: {
  party: PublicKey;
  escrow: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = input.programId ?? rosterEscrowProgramId();
  const [config] = configPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.party, isSigner: true, isWritable: false },
      { pubkey: input.escrow, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
    ],
    data: ixData(4),
  });
}

export function arbiterResolveIx(input: {
  authority: PublicKey;
  escrow: PublicKey;
  vault: PublicKey;
  sellerAta: PublicKey;
  feeAta: PublicKey;
  buyerAta: PublicKey;
  mint: PublicKey;
  release: boolean;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = input.programId ?? rosterEscrowProgramId();
  // ArbiterResolve reuses Release/Refund account metas; encode variant 5 + bool
  const body = Buffer.from([input.release ? 1 : 0]);
  if (input.release) {
    return new TransactionInstruction({
      programId,
      keys: releaseIx(input).keys,
      data: ixData(5, body),
    });
  }
  return new TransactionInstruction({
    programId,
    keys: refundIx({
      authority: input.authority,
      escrow: input.escrow,
      vault: input.vault,
      buyerAta: input.buyerAta,
      mint: input.mint,
      programId,
    }).keys,
    data: ixData(5, body),
  });
}

/** On-chain fee: 1% + 0.003 USDC (micro), rejects fee >= amount. */
export function computeOnChainFeeMicros(amountMicros: bigint, feeBps = 100n, flatFee = 3000n): bigint {
  if (amountMicros <= 0n) throw new Error("amount must be > 0");
  const fee = (amountMicros * feeBps) / 10_000n + flatFee;
  if (fee >= amountMicros) throw new Error("fee exceeds amount");
  return fee;
}

/** String-friendly vault address for custody records. */
export function noncustodialVaultAddress(
  buyerAddress: string,
  escrowId: string,
  programIdStr: string = ROSTER_ESCROW_PROGRAM_ID_DEVNET,
): string {
  const programId = new PublicKey(programIdStr);
  const buyer = new PublicKey(buyerAddress);
  const [escrow] = escrowPda(buyer, escrowId, programId);
  const [vault] = vaultPda(escrow, programId);
  return vault.toBase58();
}
