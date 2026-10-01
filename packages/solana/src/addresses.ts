import { createHash } from "node:crypto";
import { createId } from "@albesa/core";
import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID_BASE58,
  TOKEN_PROGRAM_ID_BASE58,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
} from "./constants.js";
import type { SolanaClusterMode, SolanaEngineConfig } from "./config.js";
import { SolanaFeeError } from "./errors.js";
import { requirePublicKey, sandboxTreasuryOwnerPublicKey } from "./keys.js";
import { sandboxEscrowProgramId } from "./program.js";

export function usdcMintForCluster(cluster: SolanaClusterMode): PublicKey {
  return new PublicKey(cluster === "mainnet-beta" ? USDC_MINT_MAINNET : USDC_MINT_DEVNET);
}

export function tokenProgramId(): PublicKey {
  return new PublicKey(TOKEN_PROGRAM_ID_BASE58);
}

export function associatedTokenProgramId(): PublicKey {
  return new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID_BASE58);
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId().toBuffer(), mint.toBuffer()],
    associatedTokenProgramId(),
  );
  return address;
}

function pdaSeed(id: string): Buffer {
  const raw = Buffer.from(id, "utf8");
  if (raw.length === 0) {
    throw new SolanaFeeError(400, "invalid_request", "escrowId is empty.");
  }
  if (raw.length <= 32) return raw;
  return createHash("sha256").update(raw).digest();
}

/** Escrow authority PDA. Seeds longer than 32 bytes are SHA-256 hashed. */
export function escrowPda(escrowId: string): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("roster-escrow", "utf8"), pdaSeed(escrowId)],
    sandboxEscrowProgramId(),
  );
  return address;
}

export function escrowUsdcAta(escrowId: string, cluster: SolanaClusterMode): PublicKey {
  return associatedTokenAddress(escrowPda(escrowId), usdcMintForCluster(cluster));
}

export function sandboxTreasuryUsdcAta(cluster: SolanaClusterMode): PublicKey {
  return associatedTokenAddress(sandboxTreasuryOwnerPublicKey(), usdcMintForCluster(cluster));
}

export function resolveTreasuryAta(config: SolanaEngineConfig): PublicKey {
  if (config.treasuryUsdcAta) return requirePublicKey(config.treasuryUsdcAta, "ROSTER_TREASURY_USDC_ATA");
  if (config.cluster === "mock") return sandboxTreasuryUsdcAta(config.cluster);
  throw new SolanaFeeError(
    400,
    "treasury_unconfigured",
    "Set ROSTER_TREASURY_USDC_ATA before settling on a live cluster.",
  );
}

export function resolveEscrowId(escrowId: string | undefined): string {
  const trimmed = escrowId?.trim();
  if (!trimmed) return createId("escrow");
  if (trimmed.length > 128) {
    throw new SolanaFeeError(400, "invalid_request", "escrowId must be at most 128 characters.");
  }
  return trimmed;
}
