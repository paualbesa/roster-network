import { keccak_256 } from "@noble/hashes/sha3";

/** Payout wallet: address only. Roster never holds keys or funds for sellers. */
export type PayoutChain = "solana" | "base";

export interface PayoutWallet {
  chain: PayoutChain;
  address: string;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function validatePayoutWallet(input: unknown): { ok: true; wallet: PayoutWallet } | { ok: false; message: string } {
  if (typeof input !== "object" || input === null) return { ok: false, message: "payout must be { chain, address }." };
  const { chain, address } = input as { chain?: unknown; address?: unknown };
  if (chain !== "solana" && chain !== "base") return { ok: false, message: 'payout.chain must be "solana" or "base".' };
  if (typeof address !== "string" || address.trim() === "") return { ok: false, message: "payout.address is required." };
  const trimmed = address.trim();
  if (chain === "solana") {
    return isSolanaAddress(trimmed) ? { ok: true, wallet: { chain, address: trimmed } } : { ok: false, message: "That is not a valid Solana address (base58, 32 bytes)." };
  }
  const base = normalizeEvmAddress(trimmed);
  return base ? { ok: true, wallet: { chain, address: base } } : { ok: false, message: "That is not a valid Base (EVM) address, or its checksum is wrong." };
}

export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  const bytes = decodeBase58(value);
  return bytes !== null && bytes.length === 32;
}

export function decodeBase58(value: string): Uint8Array | null {
  let num = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    num = num * 58n + BigInt(digit);
  }
  const out: number[] = [];
  while (num > 0n) {
    out.unshift(Number(num % 256n));
    num /= 256n;
  }
  for (const char of value) {
    if (char !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/** Returns the EIP-55 checksummed address, or null when invalid. Mixed-case input must already be checksummed. */
export function normalizeEvmAddress(value: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const hex = value.slice(2);
  const checksummed = toChecksum(hex.toLowerCase());
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixed && checksummed !== `0x${hex}`) return null;
  return checksummed;
}

function toChecksum(lower: string): string {
  const hash = keccak_256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i]!;
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    out += /[a-f]/.test(char) && nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

export function maskAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
