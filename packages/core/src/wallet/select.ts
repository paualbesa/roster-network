import { BaseUsdcWalletProvider } from "./base.js";
import { MockWalletProvider } from "./mock.js";
import { SolanaUsdcWalletProvider } from "./solana.js";
import type { WalletProvider } from "./types.js";

/** Opt-in settlement adapter. `mock` is the API default. */
export type WalletRail = "mock" | "base-sim" | "solana-sim" | "solana-devnet";

function readWalletRail(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim().toLowerCase();
  return value ? value : undefined;
}

function normalizeRail(raw: string): WalletRail | null {
  if (raw === "mock") return "mock";
  if (raw === "base-sim") return "base-sim";
  if (raw === "solana-sim") return "solana-sim";
  if (raw === "solana-devnet" || raw === "solana_devnet" || raw === "devnet") return "solana-devnet";
  return null;
}

/**
 * `ROSTER_WALLET` / `ROSTER_RAIL` select the sandbox settlement adapter.
 * `ALBESA_WALLET` is accepted as an alias of `ROSTER_WALLET`.
 * Unset means `mock`. `solana-devnet` settles with real Devnet SPL transfers
 * (wired by the API via `@albesa/solana`, not this factory).
 */
export function resolveWalletRail(env: Record<string, string | undefined> = process.env): WalletRail {
  const roster = readWalletRail(env, "ROSTER_WALLET") ?? readWalletRail(env, "ROSTER_RAIL");
  const albesa = readWalletRail(env, "ALBESA_WALLET");
  if (roster !== undefined && albesa !== undefined && roster !== albesa) {
    throw new Error(
      `ROSTER_WALLET/ROSTER_RAIL (${roster}) and ALBESA_WALLET (${albesa}) disagree. Set only one, or set them to the same value.`,
    );
  }
  const raw = roster ?? albesa ?? "mock";
  const rail = normalizeRail(raw);
  if (rail) return rail;
  throw new Error(
    `Unsupported wallet rail "${raw}". Set ROSTER_WALLET or ROSTER_RAIL to "mock", "base-sim", "solana-sim", or "solana-devnet".`,
  );
}

/**
 * In-process rails only. `solana-devnet` must be constructed by the API with
 * a fee-payer secret (see `createSolanaDevnetWallet` in `@albesa/solana`).
 */
export function createWalletProvider(rail: WalletRail): WalletProvider {
  if (rail === "base-sim") return new BaseUsdcWalletProvider();
  if (rail === "solana-sim") return new SolanaUsdcWalletProvider();
  if (rail === "solana-devnet") {
    throw new Error(
      'Wallet rail "solana-devnet" cannot be created from core alone. The API opens it with the fee-payer key material from roster-data.',
    );
  }
  return new MockWalletProvider();
}
