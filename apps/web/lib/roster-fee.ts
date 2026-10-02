/**
 * Display math for the gasless Roster fee.
 * The settlement source of truth is `quoteRosterNetworkFee` in `@albesa/solana`.
 * This copy stays in the browser bundle and does not import `@solana/web3.js`.
 * Schedule: 1% of the job price, truncated to micro-USDC, plus 0.003 USDC.
 */

export const ROSTER_PERCENT_FEE = 0.01;
export const ROSTER_BASE_FEE_USDC = "0.003000";
export const ROSTER_FEE_SCHEDULE_LABEL = "1% + 0.003 USDC";

const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.(\d{1,6}))?$/;
const ZERO_COLLECTED = "0.000000";

export interface RosterFeeQuote {
  jobPriceUsdc: string;
  percentFee: number;
  baseFeeUsdc: string;
  rosterFeeUsdc: string;
  providerPayoutUsdc: string;
}

export type RosterFeeQuoteResult =
  | { ok: true; quote: RosterFeeQuote }
  | { ok: false; code: "invalid_request" | "fee_exceeds_price"; message: string };

export interface RosterFeeView {
  priceUsdc: string;
  schedule: string;
  quotedFeeUsdc: string;
  collectedFeeUsdc: string;
  providerPayoutUsdc: string;
  buyerRefundUsdc: string;
  settle: boolean;
  note: string;
}

export type SolanaJobPhase =
  | "skip-fee"
  | "prepare-lock"
  | "await-verification"
  | "settle"
  | "refund-without-fee"
  | "settled";

function parseUsdc(value: string): bigint | null {
  const trimmed = value.trim();
  if (!AMOUNT_RE.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = `${frac}000000`.slice(0, 6);
  return BigInt(whole ?? "0") * 1_000_000n + BigInt(fracPadded);
}

function formatUsdc(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction}`;
}

export function quoteRosterFee(jobPriceUsdc: string): RosterFeeQuoteResult {
  const price = parseUsdc(jobPriceUsdc);
  if (price === null) {
    return { ok: false, code: "invalid_request", message: `Invalid USDC amount: ${jobPriceUsdc}` };
  }
  if (price <= 0n) {
    return { ok: false, code: "invalid_request", message: "Job price must be greater than zero." };
  }

  const bps = BigInt(Math.round(ROSTER_PERCENT_FEE * 10_000));
  const percentMicros = (price * bps) / 10_000n;
  const baseMicros = parseUsdc(ROSTER_BASE_FEE_USDC);
  if (baseMicros === null) {
    return { ok: false, code: "invalid_request", message: "Roster base fee is not a USDC amount." };
  }
  const rosterFee = percentMicros + baseMicros;
  if (rosterFee >= price) {
    return {
      ok: false,
      code: "fee_exceeds_price",
      message: "Job price must be greater than the Roster fee (1% + 0.003 USDC).",
    };
  }

  return {
    ok: true,
    quote: {
      jobPriceUsdc: formatUsdc(price),
      percentFee: ROSTER_PERCENT_FEE,
      baseFeeUsdc: formatUsdc(baseMicros),
      rosterFeeUsdc: formatUsdc(rosterFee),
      providerPayoutUsdc: formatUsdc(price - rosterFee),
    },
  };
}

/** A fee is collected only when the job releases. Timeout, refund, and failure collect nothing. */
export function collectedOnRelease(status: string, quotedUsdc: string): string {
  return status === "released" ? quotedUsdc : ZERO_COLLECTED;
}

export function describeRosterFee(quote: RosterFeeQuote, status: string): RosterFeeView {
  const released = status === "released";
  const refunded = status === "timed_out" || status === "refunded" || status === "failed";
  let note = "Quoted until the result is verified. Settle runs only after verification.";
  if (released) {
    note = "Verified result. Settle pays the provider and collects the Roster fee. The mock cluster does not broadcast.";
  } else if (status === "timed_out") {
    note = "SLA timeout refunds the buyer in full. The Roster fee is not collected.";
  } else if (refunded) {
    note = "The buyer is refunded in full. The Roster fee is not collected.";
  }

  return {
    priceUsdc: quote.jobPriceUsdc,
    schedule: ROSTER_FEE_SCHEDULE_LABEL,
    quotedFeeUsdc: quote.rosterFeeUsdc,
    collectedFeeUsdc: released ? quote.rosterFeeUsdc : ZERO_COLLECTED,
    providerPayoutUsdc: released ? quote.providerPayoutUsdc : refunded ? ZERO_COLLECTED : quote.providerPayoutUsdc,
    buyerRefundUsdc: refunded ? quote.jobPriceUsdc : ZERO_COLLECTED,
    settle: released,
    note,
  };
}

export function solanaJobPhase(input: {
  quoteOk: boolean;
  hasLock: boolean;
  hasSettlement: boolean;
  status: string;
}): SolanaJobPhase {
  if (!input.quoteOk) return "skip-fee";
  if (!input.hasLock) return "prepare-lock";
  if (input.hasSettlement) return "settled";
  if (input.status === "released") return "settle";
  if (input.status === "timed_out" || input.status === "refunded" || input.status === "failed") {
    return "refund-without-fee";
  }
  return "await-verification";
}

/** The console continues only when the API stayed on the default mock cluster. */
export function sandboxRailProblem(receipt: { cluster: string; broadcast: boolean }): string | null {
  if (receipt.cluster === "mock" && receipt.broadcast === false) return null;
  return `Sandbox requires cluster mock and broadcast false. This response was cluster ${receipt.cluster}, broadcast ${String(receipt.broadcast)}.`;
}
