import { parseUsdc } from "@albesa/core";
import {
  associatedTokenAddress,
  escrowPda,
  escrowUsdcAta,
  resolveEscrowId,
  resolveTreasuryAta,
  usdcMintForCluster,
} from "./addresses.js";
import type { SolanaClusterMode, SolanaEngineConfig } from "./config.js";
import { resolveSolanaEngineConfig } from "./config.js";
import { SolanaFeeError } from "./errors.js";
import { jobPriceMicros, quoteRosterNetworkFee, type RosterNetworkFeeQuote } from "./fees.js";
import {
  feePayerSigner,
  keypairFromSecret,
  programAuthoritySigner,
  requirePublicKey,
  sandboxBlockhash,
  type SignerSlot,
} from "./keys.js";
import { rpcGetLatestBlockhash, rpcSendRawTransaction } from "./rpc.js";
import {
  buildLockTransaction,
  buildSettleTransaction,
  deserializeVersionedTransaction,
  localSignature,
  serializeVersionedTransaction,
} from "./transaction.js";

export interface SolanaCallOptions {
  fetchImpl?: typeof fetch;
  /** Replaces RPC sendTransaction. Tests use this so a live gate does not dial the network. */
  sender?: (bytes: Uint8Array) => Promise<string>;
}

export interface PrepareLockInput {
  buyerPubkey: string;
  amountUsdc: string;
  escrowId?: string;
  jobId?: string;
  buyerTokenAccount?: string;
}

export interface PrepareLockResult {
  cluster: SolanaClusterMode;
  broadcast: false;
  escrowId: string;
  jobId: string | null;
  feePayer: string;
  feePayerSignature: SignerSlot["mode"];
  buyerPubkey: string;
  buyerSigned: false;
  escrowPda: string;
  escrowAta: string;
  buyerTokenAccount: string;
  mint: string;
  amountUsdc: string;
  quote: RosterNetworkFeeQuote;
  recentBlockhash: string;
  blockhashSource: "sandbox" | "rpc";
  transaction: string;
}

export interface SettleInput {
  escrowId: string;
  buyerPubkey: string;
  providerPubkey: string;
  amountUsdc: string;
  verified: boolean;
  jobId?: string;
  providerTokenAccount?: string;
}

export interface SettleResult {
  cluster: SolanaClusterMode;
  broadcast: boolean;
  broadcastNote: string | null;
  submitted: boolean;
  signature: string | null;
  escrowId: string;
  jobId: string | null;
  feePayer: string;
  feePayerSignature: SignerSlot["mode"];
  programAuthority: string;
  programAuthoritySignature: SignerSlot["mode"];
  buyerPubkey: string;
  providerPubkey: string;
  providerTokenAccount: string;
  treasuryUsdcAta: string;
  escrowPda: string;
  escrowAta: string;
  mint: string;
  quote: RosterNetworkFeeQuote;
  recentBlockhash: string;
  blockhashSource: "sandbox" | "rpc";
  transaction: string;
}

function optionalId(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) throw new SolanaFeeError(400, "invalid_request", `${field} is empty.`);
  if (trimmed.length > 128) {
    throw new SolanaFeeError(400, "invalid_request", `${field} must be at most 128 characters.`);
  }
  return trimmed;
}

async function loadBlockhash(
  config: SolanaEngineConfig,
  options: SolanaCallOptions,
): Promise<{ blockhash: string; source: "sandbox" | "rpc" }> {
  if (config.cluster === "mock" || !config.rpcUrl) {
    return { blockhash: sandboxBlockhash(), source: "sandbox" };
  }
  const blockhash = await rpcGetLatestBlockhash(config.rpcUrl, options.fetchImpl ?? fetch);
  return { blockhash, source: "rpc" };
}

function broadcastBlockReason(config: SolanaEngineConfig): string | null {
  if (!config.send) return null;
  if (config.cluster === "mock") return "mock cluster never broadcasts";
  if (config.cluster === "mainnet-beta" && !config.allowMainnet) {
    return "mainnet broadcast requires ROSTER_SOLANA_ALLOW_MAINNET=1";
  }
  if (!config.rpcUrl) return "SOLANA_RPC_URL is unset";
  if (!config.feePayerSecret) return "ROSTER_FEE_PAYER_SECRET is unset";
  if (!config.programAuthoritySecret) return "ROSTER_PROGRAM_AUTHORITY_SECRET is unset";
  return null;
}

/**
 * Build a partially signed lock transaction.
 * The fee payer signature covers the SOL fee. The buyer co-signs and submits.
 * Mock mode does not contact a cluster.
 */
export async function prepareLock(
  input: PrepareLockInput,
  config: SolanaEngineConfig = resolveSolanaEngineConfig(),
  options: SolanaCallOptions = {},
): Promise<PrepareLockResult> {
  const quote = quoteRosterNetworkFee(input.amountUsdc);
  const feePayer = feePayerSigner(config);
  const buyer = requirePublicKey(input.buyerPubkey, "buyerPubkey");
  const escrowId = resolveEscrowId(input.escrowId);
  const mint = usdcMintForCluster(config.cluster);
  const source = input.buyerTokenAccount
    ? requirePublicKey(input.buyerTokenAccount, "buyerTokenAccount")
    : associatedTokenAddress(buyer, mint);
  const pda = escrowPda(escrowId);
  const destination = escrowUsdcAta(escrowId, config.cluster);
  const { blockhash, source: blockhashSource } = await loadBlockhash(config, options);
  const tx = buildLockTransaction({
    feePayer,
    buyer,
    sourceAta: source,
    escrowAta: destination,
    amountMicros: jobPriceMicros(input.amountUsdc),
    recentBlockhash: blockhash,
  });

  return {
    cluster: config.cluster,
    broadcast: false,
    escrowId,
    jobId: optionalId(input.jobId, "jobId"),
    feePayer: feePayer.publicKey.toBase58(),
    feePayerSignature: feePayer.mode,
    buyerPubkey: buyer.toBase58(),
    buyerSigned: false,
    escrowPda: pda.toBase58(),
    escrowAta: destination.toBase58(),
    buyerTokenAccount: source.toBase58(),
    mint: mint.toBase58(),
    amountUsdc: quote.jobPriceUsdc,
    quote,
    recentBlockhash: blockhash,
    blockhashSource,
    transaction: serializeVersionedTransaction(tx),
  };
}

/**
 * After work is verified, pay the provider and send the Roster fee to the treasury ATA.
 * The backend signs as fee payer and program authority. Broadcast stays off unless
 * ROSTER_SOLANA_SEND=1 and the live gates pass.
 */
export async function settleEscrow(
  input: SettleInput,
  config: SolanaEngineConfig = resolveSolanaEngineConfig(),
  options: SolanaCallOptions = {},
): Promise<SettleResult> {
  if (input.verified !== true) {
    throw new SolanaFeeError(409, "invalid_state", "Settle runs only after work is verified.");
  }
  const quote = quoteRosterNetworkFee(input.amountUsdc);
  const feePayer = feePayerSigner(config);
  const authority = programAuthoritySigner(config);
  const buyer = requirePublicKey(input.buyerPubkey, "buyerPubkey");
  const provider = requirePublicKey(input.providerPubkey, "providerPubkey");
  const escrowId = resolveEscrowId(input.escrowId);
  const mint = usdcMintForCluster(config.cluster);
  const providerAta = input.providerTokenAccount
    ? requirePublicKey(input.providerTokenAccount, "providerTokenAccount")
    : associatedTokenAddress(provider, mint);
  const treasury = resolveTreasuryAta(config);
  const pda = escrowPda(escrowId);
  const escrowAta = escrowUsdcAta(escrowId, config.cluster);
  const { blockhash, source: blockhashSource } = await loadBlockhash(config, options);
  const tx = buildSettleTransaction({
    feePayer,
    authority,
    escrowAta,
    providerAta,
    treasuryAta: treasury,
    providerPayoutMicros: parseUsdc(quote.providerPayoutUsdc),
    rosterFeeMicros: parseUsdc(quote.rosterFeeUsdc),
    recentBlockhash: blockhash,
  });

  const note = broadcastBlockReason(config);
  let signature = localSignature(tx);
  let broadcast = false;
  if (config.send && note === null) {
    const rpcUrl = config.rpcUrl;
    if (!rpcUrl) {
      throw new SolanaFeeError(400, "rpc_unconfigured", "SOLANA_RPC_URL is unset.");
    }
    const sender = options.sender ?? ((bytes: Uint8Array) => rpcSendRawTransaction(rpcUrl, bytes, options.fetchImpl ?? fetch));
    signature = await sender(tx.serialize());
    broadcast = true;
  }

  return {
    cluster: config.cluster,
    broadcast,
    broadcastNote: note,
    submitted: broadcast,
    signature,
    escrowId,
    jobId: optionalId(input.jobId, "jobId"),
    feePayer: feePayer.publicKey.toBase58(),
    feePayerSignature: feePayer.mode,
    programAuthority: authority.publicKey.toBase58(),
    programAuthoritySignature: authority.mode,
    buyerPubkey: buyer.toBase58(),
    providerPubkey: provider.toBase58(),
    providerTokenAccount: providerAta.toBase58(),
    treasuryUsdcAta: treasury.toBase58(),
    escrowPda: pda.toBase58(),
    escrowAta: escrowAta.toBase58(),
    mint: mint.toBase58(),
    quote,
    recentBlockhash: blockhash,
    blockhashSource,
    transaction: serializeVersionedTransaction(tx),
  };
}

/**
 * Sign a serialized transaction with the fee payer and submit it.
 * Mock mode and an unarmed mainnet cluster are refused. The treasury worker
 * still has to pass its own execute gates before it calls this.
 */
export async function submitSignedTransaction(
  base64: string,
  config: SolanaEngineConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (config.cluster === "mock") {
    throw new SolanaFeeError(403, "mock_broadcast_refused", "Mock mode does not submit transactions.");
  }
  if (config.cluster === "mainnet-beta" && !config.allowMainnet) {
    throw new SolanaFeeError(
      403,
      "mainnet_disabled",
      "mainnet-beta signing is disabled. Set ROSTER_SOLANA_ALLOW_MAINNET=1 to arm it. No funds were spent.",
    );
  }
  if (!config.feePayerSecret || !config.rpcUrl) {
    throw new SolanaFeeError(
      400,
      "fee_payer_unconfigured",
      "Refusing to submit without ROSTER_FEE_PAYER_SECRET and SOLANA_RPC_URL.",
    );
  }
  const tx = deserializeVersionedTransaction(base64);
  tx.sign([keypairFromSecret(config.feePayerSecret, "ROSTER_FEE_PAYER_SECRET")]);
  return rpcSendRawTransaction(config.rpcUrl, tx.serialize(), fetchImpl);
}
