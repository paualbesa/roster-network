import { encodeBase58 } from "./base58";

/** Prefix hashed into a sandbox participant key. Keep in sync with the Solana package test. */
export const SANDBOX_PUBKEY_LABEL_PREFIX = "roster-sandbox-v1:";

/**
 * Deterministic 32-byte public key for a mock-cluster participant.
 * SHA-256 output is a valid Solana public-key encoding. It is not a secret and it is not a funded account.
 */
export async function sandboxParticipantPubkey(label: string): Promise<string> {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Sandbox pubkey label is empty.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${SANDBOX_PUBKEY_LABEL_PREFIX}${trimmed}`),
  );
  return encodeBase58(new Uint8Array(digest));
}
