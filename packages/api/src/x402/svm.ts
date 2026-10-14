/**
 * `exact` scheme on Solana (SVM), per coinbase/x402 specs/schemes/exact/scheme_exact_svm.md.
 * Verification is done locally (no third-party facilitator, no keys shared): Roster acts as its own facilitator
 * on solana-devnet. Settlement co-signs as fee payer and broadcasts through an injectable chain adapter so tests
 * never touch a real network.
 */
import { randomBytes } from "node:crypto";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { type PaymentRequirements, X402Error } from "./protocol.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xLWBoNdNe9wW8hbY";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
/** Reference implementation cap, in micro-lamports per CU (5 lamports). */
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 5_000_000n;

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram = new PublicKey(TOKEN_PROGRAM)): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], new PublicKey(ATA_PROGRAM))[0];
}

export interface VerifiedSvmPayment {
  /** Owner/authority that signed the token transfer (the paying agent). */
  payer: string;
  amount: string;
  source: string;
  destination: string;
  memo: string | null;
  transaction: VersionedTransaction;
}

function readU64(data: Uint8Array, offset: number): bigint {
  return Buffer.from(data).readBigUInt64LE(offset);
}

/** Enforce every MUST of the exact-SVM verification rules that can be checked offline. */
export function verifyExactSvmTransaction(transactionB64: string, requirement: PaymentRequirements, feePayer: string): VerifiedSvmPayment {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(transactionB64, "base64"));
  } catch {
    throw new X402Error("invalid_exact_svm_payload_transaction", "payload.transaction is not a serialized Solana transaction.");
  }
  const message = tx.message;
  if (message.addressTableLookups.length > 0) {
    throw new X402Error("invalid_exact_svm_payload_transaction", "Address lookup tables are not accepted.");
  }
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  if (keys[0] !== feePayer) {
    throw new X402Error("invalid_exact_svm_payload_transaction_fee_payer", `Fee payer must be ${feePayer} (requirements.extra.feePayer).`);
  }
  const ixs = message.compiledInstructions.map((ix) => ({
    program: keys[ix.programIdIndex] ?? "",
    accounts: ix.accountKeyIndexes.map((index) => keys[index] ?? ""),
    data: ix.data,
  }));
  if (ixs.length < 3 || ixs.length > 6) {
    throw new X402Error("invalid_exact_svm_payload_transaction_instructions_length", "Expected 3 to 6 instructions.");
  }
  for (const ix of ixs) {
    if (ix.accounts.includes(feePayer)) {
      throw new X402Error("invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts", "Fee payer must not appear in instruction accounts.");
    }
  }
  const [limit, price, transfer, ...optional] = ixs as [(typeof ixs)[number], (typeof ixs)[number], (typeof ixs)[number], ...(typeof ixs)[number][]];
  if (limit.program !== COMPUTE_BUDGET_PROGRAM || limit.data[0] !== 2 || limit.data.length !== 5) {
    throw new X402Error("invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction", "Instruction 1 must be SetComputeUnitLimit.");
  }
  if (price.program !== COMPUTE_BUDGET_PROGRAM || price.data[0] !== 3 || price.data.length !== 9) {
    throw new X402Error("invalid_exact_svm_payload_transaction_instructions_compute_price_instruction", "Instruction 2 must be SetComputeUnitPrice.");
  }
  if (readU64(price.data, 1) > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) {
    throw new X402Error("invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high", "Compute unit price is too high.");
  }
  if (transfer.program !== TOKEN_PROGRAM && transfer.program !== TOKEN_2022_PROGRAM) {
    throw new X402Error("invalid_exact_svm_payload_transaction_instructions", "Instruction 3 must be an SPL Token TransferChecked.");
  }
  if (transfer.data[0] !== 12 || transfer.data.length !== 10 || transfer.accounts.length < 4) {
    throw new X402Error("invalid_exact_svm_payload_transaction_instructions", "Instruction 3 must be TransferChecked.");
  }
  const [source, mint, destination, authority] = transfer.accounts as [string, string, string, string];
  if (mint !== requirement.asset) throw new X402Error("invalid_exact_svm_payload_transaction_asset_mismatch", "Transfer mint does not match requirements.asset.");
  if (authority === feePayer || source === feePayer) {
    throw new X402Error("invalid_exact_svm_payload_transaction_fee_payer_transferring_funds", "Fee payer must not transfer funds.");
  }
  const expectedDestination = associatedTokenAddress(new PublicKey(requirement.payTo), new PublicKey(requirement.asset), new PublicKey(transfer.program)).toBase58();
  if (destination !== expectedDestination) {
    throw new X402Error("invalid_exact_svm_payload_transaction_recipient_mismatch", "Transfer destination is not the payTo associated token account.");
  }
  const amount = readU64(transfer.data, 1).toString();
  if (amount !== requirement.amount) {
    throw new X402Error("invalid_exact_svm_payload_transaction_amount_mismatch", `Transfer amount must equal ${requirement.amount}.`);
  }
  let memo: string | null = null;
  let memoCount = 0;
  for (const ix of optional) {
    if (ix.program === MEMO_PROGRAM) {
      memoCount += 1;
      memo = Buffer.from(ix.data).toString("utf8");
    } else if (ix.program !== LIGHTHOUSE_PROGRAM) {
      throw new X402Error("invalid_exact_svm_payload_transaction_instructions", "Only Memo and Lighthouse instructions may follow the transfer.");
    }
  }
  const expectedMemo = typeof requirement.extra?.memo === "string" ? requirement.extra.memo : null;
  if (expectedMemo !== null && (memoCount !== 1 || memo !== expectedMemo)) {
    throw new X402Error("invalid_exact_svm_payload_transaction_memo_mismatch", "Memo must equal requirements.extra.memo.");
  }
  // The authority must have signed; the fee payer slot (index 0) is left for the facilitator.
  const signerCount = message.header.numRequiredSignatures;
  const authorityIndex = keys.indexOf(authority);
  if (authorityIndex < 1 || authorityIndex >= signerCount) {
    throw new X402Error("invalid_exact_svm_payload_transaction_signature", "Transfer authority must be a transaction signer.");
  }
  const sig = tx.signatures[authorityIndex];
  if (!sig || sig.every((byte) => byte === 0)) {
    throw new X402Error("invalid_exact_svm_payload_transaction_signature", "Transfer authority has not signed.");
  }
  return { payer: authority, amount, source, destination, memo, transaction: tx };
}

/** Broadcast adapter. The devnet one co-signs as fee payer; tests inject a fake. */
export interface SvmSettlementChain {
  readonly feePayer: string;
  readonly network: string;
  /** Co-sign as fee payer, submit, confirm. Returns the base58 transaction signature. */
  settle(transaction: VersionedTransaction): Promise<string>;
}

export class DevnetSvmChain implements SvmSettlementChain {
  readonly network = "solana-devnet";
  private readonly connection: Connection;
  constructor(
    private readonly keypair: Keypair,
    rpcUrl = "https://api.devnet.solana.com",
  ) {
    if (/mainnet/i.test(rpcUrl)) throw new Error("x402 settlement is devnet-only.");
    this.connection = new Connection(rpcUrl, "confirmed");
  }
  get feePayer(): string {
    return this.keypair.publicKey.toBase58();
  }
  async settle(transaction: VersionedTransaction): Promise<string> {
    transaction.sign([this.keypair]);
    const simulation = await this.connection.simulateTransaction(transaction, { sigVerify: true });
    if (simulation.value.err) throw new X402Error("transaction_simulation_failed", `Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const confirmed = await this.connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (confirmed.value.err) throw new X402Error("transaction_failed", `Transaction failed: ${JSON.stringify(confirmed.value.err)}`);
    return signature;
  }
}

/** Build the client side of an exact-SVM payment (used by Roster's outbound payer and by tests acting as an agent). */
export function buildExactSvmPayment(input: {
  requirement: PaymentRequirements;
  payer: Keypair;
  recentBlockhash: string;
  decimals?: number;
}): string {
  const feePayer = typeof input.requirement.extra?.feePayer === "string" ? new PublicKey(input.requirement.extra.feePayer) : input.payer.publicKey;
  const mint = new PublicKey(input.requirement.asset);
  const tokenProgram = new PublicKey(TOKEN_PROGRAM);
  const source = associatedTokenAddress(input.payer.publicKey, mint, tokenProgram);
  const destination = associatedTokenAddress(new PublicKey(input.requirement.payTo), mint, tokenProgram);
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(input.requirement.amount), 1);
  data.writeUInt8(input.decimals ?? 6, 9);
  const transfer = new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: input.payer.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const memoText = typeof input.requirement.extra?.memo === "string" ? input.requirement.extra.memo : randomBytes(16).toString("hex");
  const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memoText, "utf8") });
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      transfer,
      memo,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([input.payer]);
  return Buffer.from(tx.serialize()).toString("base64");
}
