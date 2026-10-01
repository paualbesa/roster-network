/**
 * Gasless escrow fee. Roster pays the SOL network fee and collects this
 * hybrid USDC fee on each successful settle.
 * Arithmetic uses micro-USDC integers; these two values are the schedule.
 */
export const ROSTER_PERCENT_FEE = 0.01;
export const ROSTER_BASE_FEE_USDC = 0.003;

/** 0.02 SOL. The treasury worker tops up the fee payer when balance is under this. */
export const FEE_PAYER_MIN_SOL = 0.02;
export const FEE_PAYER_MIN_LAMPORTS = 20_000_000n;

/** ~10 USDC swapped to SOL when the fee payer is under the minimum. */
export const FEE_PAYER_TOP_UP_USDC = 10;
export const FEE_PAYER_TOP_UP_USDC_MICROS = 10_000_000n;

export const TREASURY_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const TOKEN_PROGRAM_ID_BASE58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID_BASE58 = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
export const JUPITER_SWAP_URL = "https://quote-api.jup.ag/v6/swap";

if (Math.round(ROSTER_PERCENT_FEE * 10_000) !== 100) {
  throw new Error("ROSTER_PERCENT_FEE must stay 0.01.");
}
if (ROSTER_BASE_FEE_USDC.toFixed(6) !== "0.003000") {
  throw new Error("ROSTER_BASE_FEE_USDC must stay 0.003.");
}
if (FEE_PAYER_MIN_SOL !== 0.02 || FEE_PAYER_MIN_LAMPORTS !== 20_000_000n) {
  throw new Error("Fee payer minimum must stay 0.02 SOL.");
}
if (FEE_PAYER_TOP_UP_USDC !== 10 || FEE_PAYER_TOP_UP_USDC_MICROS !== 10_000_000n) {
  throw new Error("Fee payer top-up must stay 10 USDC.");
}
