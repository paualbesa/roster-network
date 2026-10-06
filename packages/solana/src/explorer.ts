import type { SolanaClusterMode } from "./config.js";

/** Solana Explorer URL for a signature. Always labels the cluster in the query. */
export function solanaExplorerTxUrl(signature: string, cluster: SolanaClusterMode = "devnet"): string | null {
  const sig = signature.trim();
  if (!sig || sig.startsWith("mock_tx_") || sig.startsWith("base_sim_tx_")) return null;
  if (cluster === "mock") return null;
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(sig)}${q}`;
}

export function solanaExplorerAddressUrl(address: string, cluster: SolanaClusterMode = "devnet"): string | null {
  const addr = address.trim();
  if (!addr || addr.startsWith("mock:") || addr.startsWith("base-sim:")) return null;
  if (cluster === "mock") return null;
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/address/${encodeURIComponent(addr)}${q}`;
}

/** True when providerRef looks like a real Solana signature (base58, long). */
export function looksLikeSolanaSignature(ref: string | null | undefined): boolean {
  if (!ref) return false;
  if (ref.startsWith("mock_tx_") || ref.startsWith("base_sim_tx_") || ref.startsWith("sim-")) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(ref);
}
