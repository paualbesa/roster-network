import { formatUsdc, MoneyError, parseUsdc } from "@albesa/core";
import { ROSTER_BASE_FEE_USDC, ROSTER_PERCENT_FEE } from "./constants.js";
import { SolanaFeeError } from "./errors.js";

export interface RosterNetworkFeeQuote {
  jobPriceUsdc: string;
  percentFee: number;
  baseFeeUsdc: string;
  rosterFeeUsdc: string;
  providerPayoutUsdc: string;
}

/**
 * Roster Fee = 1% of the job price + 0.003 USDC.
 * The percent leg truncates toward zero at micro-USDC.
 * Provider payout = job price - Roster Fee, and must stay positive.
 */
export function quoteRosterNetworkFee(jobPriceUsdc: string): RosterNetworkFeeQuote {
  let price: bigint;
  try {
    price = parseUsdc(jobPriceUsdc);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new SolanaFeeError(400, "invalid_request", error.message);
    }
    throw error;
  }
  if (price <= 0n) {
    throw new SolanaFeeError(400, "invalid_request", "Job price must be greater than zero.");
  }

  const bps = BigInt(Math.round(ROSTER_PERCENT_FEE * 10_000));
  const percentMicros = (price * bps) / 10_000n;
  const baseMicros = parseUsdc(ROSTER_BASE_FEE_USDC.toFixed(6));
  const rosterFee = percentMicros + baseMicros;
  if (rosterFee >= price) {
    throw new SolanaFeeError(
      400,
      "fee_exceeds_price",
      "Job price must be greater than the Roster fee (1% + 0.003 USDC).",
    );
  }

  return {
    jobPriceUsdc: formatUsdc(price),
    percentFee: ROSTER_PERCENT_FEE,
    baseFeeUsdc: formatUsdc(baseMicros),
    rosterFeeUsdc: formatUsdc(rosterFee),
    providerPayoutUsdc: formatUsdc(price - rosterFee),
  };
}

export function jobPriceMicros(jobPriceUsdc: string): bigint {
  return parseUsdc(quoteRosterNetworkFee(jobPriceUsdc).jobPriceUsdc);
}
