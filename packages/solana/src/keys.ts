import { createHash, createPublicKey, verify } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodeBase58 } from "./base58.js";
import type { SolanaEngineConfig } from "./config.js";
import { SolanaFeeError } from "./errors.js";

const SANDBOX_FEE_PAYER_LABEL = "roster-sandbox-fee-payer-v1";
const SANDBOX_AUTHORITY_LABEL = "roster-sandbox-program-authority-v1";
const SANDBOX_TREASURY_LABEL = "roster-sandbox-treasury-v1";
const SANDBOX_BLOCKHASH_LABEL = "roster-sandbox-blockhash-v1";

/**
 * Public sandbox fixtures. The seed strings are not production secrets.
 * Callers may use the keypairs only when the cluster is mock.
 */
function sandboxKeypair(label: string): Keypair {
  return Keypair.fromSeed(createHash("sha256").update(label, "utf8").digest());
}

export function sandboxFeePayerKeypair(): Keypair {
  return sandboxKeypair(SANDBOX_FEE_PAYER_LABEL);
}

export function sandboxProgramAuthorityKeypair(): Keypair {
  return sandboxKeypair(SANDBOX_AUTHORITY_LABEL);
}

export function sandboxTreasuryOwnerKeypair(): Keypair {
  return sandboxKeypair(SANDBOX_TREASURY_LABEL);
}

export function sandboxFeePayerPublicKey(): PublicKey {
  return sandboxFeePayerKeypair().publicKey;
}

export function sandboxProgramAuthorityPublicKey(): PublicKey {
  return sandboxProgramAuthorityKeypair().publicKey;
}

export function sandboxTreasuryOwnerPublicKey(): PublicKey {
  return sandboxTreasuryOwnerKeypair().publicKey;
}

export function sandboxBlockhash(): string {
  return new PublicKey(createHash("sha256").update(SANDBOX_BLOCKHASH_LABEL, "utf8").digest()).toBase58();
}

export function requirePublicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new SolanaFeeError(400, "invalid_request", `${field} must be a Solana public key.`);
  }
}

export function keypairFromSecret(secret: string, field: string): Keypair {
  const trimmed = secret.trim();
  try {
    if (trimmed.startsWith("[")) {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "number" && entry >= 0 && entry <= 255)) {
        throw new SolanaFeeError(400, "invalid_request", `${field} JSON secret must be an array of bytes.`);
      }
      const bytes = Uint8Array.from(parsed);
      if (bytes.length !== 64) {
        throw new SolanaFeeError(400, "invalid_request", `${field} must be 64 bytes.`);
      }
      return Keypair.fromSecretKey(bytes);
    }
    const decoded = decodeBase58(trimmed);
    if (decoded.length !== 64) {
      throw new SolanaFeeError(400, "invalid_request", `${field} must be a base58 64-byte secret key.`);
    }
    return Keypair.fromSecretKey(decoded);
  } catch (error) {
    if (error instanceof SolanaFeeError) throw error;
    throw new SolanaFeeError(400, "invalid_request", `${field} could not be parsed.`);
  }
}

export interface SignerSlot {
  publicKey: PublicKey;
  keypair: Keypair | null;
  mode: "sandbox" | "mock" | "env";
}

export function feePayerSigner(config: SolanaEngineConfig): SignerSlot {
  assertMainnetArmed(config);
  if (config.cluster === "mock") {
    if (config.feePayerPubkey) {
      return { publicKey: requirePublicKey(config.feePayerPubkey, "ROSTER_FEE_PAYER_PUBKEY"), keypair: null, mode: "mock" };
    }
    const keypair = sandboxFeePayerKeypair();
    return { publicKey: keypair.publicKey, keypair, mode: "sandbox" };
  }
  if (!config.feePayerSecret) {
    throw new SolanaFeeError(
      400,
      "fee_payer_unconfigured",
      "Set ROSTER_FEE_PAYER_SECRET to sign on devnet or mainnet-beta. Mock mode signs with the sandbox fixture.",
    );
  }
  const keypair = keypairFromSecret(config.feePayerSecret, "ROSTER_FEE_PAYER_SECRET");
  if (config.feePayerPubkey && config.feePayerPubkey !== keypair.publicKey.toBase58()) {
    throw new SolanaFeeError(400, "fee_payer_mismatch", "ROSTER_FEE_PAYER_PUBKEY does not match ROSTER_FEE_PAYER_SECRET.");
  }
  return { publicKey: keypair.publicKey, keypair, mode: "env" };
}

export function programAuthoritySigner(config: SolanaEngineConfig): SignerSlot {
  assertMainnetArmed(config);
  if (config.cluster === "mock") {
    const keypair = sandboxProgramAuthorityKeypair();
    return { publicKey: keypair.publicKey, keypair, mode: "sandbox" };
  }
  if (!config.programAuthoritySecret) {
    throw new SolanaFeeError(
      400,
      "program_authority_unconfigured",
      "Set ROSTER_PROGRAM_AUTHORITY_SECRET to sign settle on a live cluster.",
    );
  }
  const keypair = keypairFromSecret(config.programAuthoritySecret, "ROSTER_PROGRAM_AUTHORITY_SECRET");
  return { publicKey: keypair.publicKey, keypair, mode: "env" };
}

export function assertMainnetArmed(config: SolanaEngineConfig): void {
  if (config.cluster === "mainnet-beta" && !config.allowMainnet) {
    throw new SolanaFeeError(
      403,
      "mainnet_disabled",
      "mainnet-beta signing is disabled. Set ROSTER_SOLANA_ALLOW_MAINNET=1 to arm it. No funds were spent.",
    );
  }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(message), key, Buffer.from(signature));
}
