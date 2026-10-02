"use client";

import { quoteRosterFee } from "@/lib/roster-fee";

export function FeeQuote({ amountUsdc }: { amountUsdc: string }) {
  const quoted = quoteRosterFee(amountUsdc);
  if (!quoted.ok) {
    return <p className="text-sm leading-6 text-muted">{quoted.message}</p>;
  }
  const { quote } = quoted;
  return (
    <dl className="grid gap-px bg-line/10 sm:grid-cols-3" aria-label="Roster fee">
      <FeeCell label="Price" value={`${quote.jobPriceUsdc} USDC`} />
      <FeeCell label="Roster fee" value={`${quote.rosterFeeUsdc} USDC`} hint="1% + 0.003 USDC" />
      <FeeCell label="Provider payout" value={`${quote.providerPayoutUsdc} USDC`} />
    </dl>
  );
}

export function FeeQuoteLine({ amountUsdc }: { amountUsdc: string }) {
  const quoted = quoteRosterFee(amountUsdc);
  if (!quoted.ok) {
    if (quoted.code !== "fee_exceeds_price") return null;
    return <p className="mt-4 text-sm leading-6 text-muted">{quoted.message}</p>;
  }
  return (
    <p className="mt-4 font-mono text-xs text-muted">
      Roster fee {quoted.quote.rosterFeeUsdc} USDC · provider payout {quoted.quote.providerPayoutUsdc} USDC
    </p>
  );
}

function FeeCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-panel px-4 py-3">
      <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-paper">{value}</dd>
      {hint ? <p className="mt-1 font-mono text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}
