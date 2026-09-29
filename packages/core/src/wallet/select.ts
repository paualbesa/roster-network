import { BaseUsdcWalletProvider } from "./base.js";
import { MockWalletProvider } from "./mock.js";
import { SolanaUsdcWalletProvider } from "./solana.js";
import type { WalletProvider } from "./types.js";

/** Opt-in settlement adapter. `mock` is the API default. */
export type WalletRail = "mock" | "base-sim" | "solana-sim";

function readWalletRail(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim().toLowerCase();
  return value ? value : undefined;
}

/**
 * `ROSTER_WALLET` selects the sandbox settlement adapter.
 * `ALBESA_WALLET` is the same switch. When both are set they must match.
 * Unset means `mock`. `base-sim` is the in-process Base rail. `solana-sim` is a stub.
 */
export function resolveWalletRail(env: Record<string, string | undefined> = process.env): WalletRail {
  const roster = readWalletRail(env, "ROSTER_WALLET");
  const albesa = readWalletRail(env, "ALBESA_WALLET");
  if (roster !== undefined && albesa !== undefined && roster !== albesa) {
    throw new Error(
      `ROSTER_WALLET (${roster}) and ALBESA_WALLET (${albesa}) disagree. Set only one, or set them to the same value.`,
    );
  }
  const raw = roster ?? albesa ?? "mock";
  if (raw === "mock") return "mock";
  if (raw === "base-sim") return "base-sim";
  if (raw === "solana-sim") return "solana-sim";
  throw new Error(
    `Unsupported wallet rail "${raw}". Set ROSTER_WALLET to "mock", "base-sim", or "solana-sim".`,
  );
}

export function createWalletProvider(rail: WalletRail): WalletProvider {
  if (rail === "base-sim") return new BaseUsdcWalletProvider();
  if (rail === "solana-sim") return new SolanaUsdcWalletProvider();
  return new MockWalletProvider();
}
