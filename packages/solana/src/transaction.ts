import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { encodeBase58 } from "./base58.js";
import { tokenProgramId } from "./addresses.js";
import { SolanaFeeError } from "./errors.js";
import type { SignerSlot } from "./keys.js";

const MOCK_SIGNATURE_BYTE = 0x11;

export function serializeVersionedTransaction(tx: VersionedTransaction): string {
  const bytes = tx.serialize();
  return Buffer.from(bytes).toString("base64");
}

export function deserializeVersionedTransaction(base64: string): VersionedTransaction {
  const trimmed = base64.trim();
  if (trimmed.length === 0) {
    throw new SolanaFeeError(400, "invalid_transaction", "Transaction is empty.");
  }
  try {
    return VersionedTransaction.deserialize(Buffer.from(trimmed, "base64"));
  } catch {
    throw new SolanaFeeError(400, "invalid_transaction", "Transaction is not a VersionedTransaction.");
  }
}

function tokenTransferInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amountMicros: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amountMicros, 1);
  return new TransactionInstruction({
    programId: tokenProgramId(),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function compile(payer: PublicKey, recentBlockhash: string, instructions: TransactionInstruction[]): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function applySignature(tx: VersionedTransaction, slot: SignerSlot): void {
  if (slot.keypair) {
    tx.sign([slot.keypair]);
    return;
  }
  const mock = new Uint8Array(64);
  mock.fill(MOCK_SIGNATURE_BYTE);
  tx.signatures[0] = mock;
}

export function signatureIsMock(signature: Uint8Array | undefined): boolean {
  if (!signature || signature.length !== 64) return true;
  if (signature.every((byte) => byte === 0)) return true;
  return signature.every((byte) => byte === MOCK_SIGNATURE_BYTE);
}

export function localSignature(tx: VersionedTransaction): string | null {
  const first = tx.signatures[0];
  if (signatureIsMock(first) || !first) return null;
  return encodeBase58(first);
}

export interface LockTransactionInput {
  feePayer: SignerSlot;
  buyer: PublicKey;
  sourceAta: PublicKey;
  escrowAta: PublicKey;
  amountMicros: bigint;
  recentBlockhash: string;
}

/** Buyer USDC → escrow ATA. Fee payer is signed; the buyer signature slot is left empty. */
export function buildLockTransaction(input: LockTransactionInput): VersionedTransaction {
  const tx = compile(input.feePayer.publicKey, input.recentBlockhash, [
    tokenTransferInstruction(input.sourceAta, input.escrowAta, input.buyer, input.amountMicros),
  ]);
  applySignature(tx, input.feePayer);
  return tx;
}

export interface SettleTransactionInput {
  feePayer: SignerSlot;
  authority: SignerSlot;
  escrowAta: PublicKey;
  providerAta: PublicKey;
  treasuryAta: PublicKey;
  providerPayoutMicros: bigint;
  rosterFeeMicros: bigint;
  recentBlockhash: string;
}

/**
 * Settle pays the provider, then the Roster fee, from the escrow ATA.
 * Both the fee payer and the program authority sign. Mock mode never broadcasts.
 */
export function buildSettleTransaction(input: SettleTransactionInput): VersionedTransaction {
  const tx = compile(input.feePayer.publicKey, input.recentBlockhash, [
    tokenTransferInstruction(input.escrowAta, input.providerAta, input.authority.publicKey, input.providerPayoutMicros),
    tokenTransferInstruction(input.escrowAta, input.treasuryAta, input.authority.publicKey, input.rosterFeeMicros),
  ]);
  const signers: Keypair[] = [];
  if (input.feePayer.keypair) signers.push(input.feePayer.keypair);
  if (input.authority.keypair && !signers.some((signer) => signer.publicKey.equals(input.authority.publicKey))) {
    signers.push(input.authority.keypair);
  }
  if (signers.length > 0) tx.sign(signers);
  if (!input.feePayer.keypair) applySignature(tx, input.feePayer);
  return tx;
}
