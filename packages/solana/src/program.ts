import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * Stable sandbox program id. The matching secret is a public fixture and is
 * not used to sign. Live clusters never treat this as a deployed program.
 */
export function sandboxEscrowProgramId(): PublicKey {
  return Keypair.fromSeed(createHash("sha256").update("roster-sandbox-escrow-program-v1", "utf8").digest()).publicKey;
}
