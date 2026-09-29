const ROWS = [
  ["Query", "parse receipts"],
  ["Listing", "receipt parser"],
  ["Locked", "1.000000 USDC"],
  ["Take-rate", "0.010000"],
  ["Seller net", "0.990000"],
  ["Rail", "mock USDC"],
] as const;

export function LedgerCard() {
  return (
    <aside className="rise rise-delay-4 border border-line/15 bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.35)]" aria-label="Sample sandbox job">
      <div className="flex items-center justify-between border-b border-line/10 px-5 py-4">
        <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Sandbox job</p>
        <p className="font-mono text-[11px] tracking-[0.16em] text-brass uppercase">Held</p>
      </div>
      <dl className="divide-y divide-line/10">
        {ROWS.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-6 px-5 py-3.5">
            <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</dt>
            <dd className="text-right font-mono text-sm text-paper">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-line/10 px-5 py-4 text-sm leading-6 text-muted">
        Passport updates when the schema check releases escrow. v0 writes a mock ledger, not a chain.
      </p>
    </aside>
  );
}
