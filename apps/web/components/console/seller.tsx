"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { payoutHint, relativeTime, sellRequest, SellApiError, takeRateLabel, trimUsdc, type SellerDashboard } from "@/lib/sell";
import { RequireSession } from "./require-session";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass, ghostClass } from "./ui";

export function Seller() {
  return (
    <ConsolePage eyebrow="Seller" title="Your listings, calls and earnings." lede="Everything here is sandbox: buyers pay mock USDC through escrow, and earnings accrue to your payout address once mainnet launches.">
      <RequireSession>
        <SellerBody />
      </RequireSession>
    </ConsolePage>
  );
}

function SellerBody() {
  const { session } = useSandboxSession();
  const apiKey = session?.apiKey ?? null;
  const [data, setData] = useState<SellerDashboard | null>(null);
  const [error, setError] = useState("");
  const [chain, setChain] = useState<"solana" | "base">("solana");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const next = await sellRequest<SellerDashboard>("GET", "/v1/sellers/me", apiKey);
      setData(next);
      setError("");
    } catch (caught) {
      setError(caught instanceof SellApiError ? caught.message : "Could not load the seller dashboard.");
    }
  }, [apiKey]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  async function savePayout() {
    if (!apiKey || payoutHint(chain, address)) return;
    setSaving(true);
    setSaved("");
    try {
      await sellRequest("PUT", "/v1/sellers/me/payout", apiKey, { chain, address: address.trim() });
      setSaved("Payout address saved.");
      setAddress("");
      await load();
    } catch (caught) {
      setSaved(caught instanceof SellApiError ? caught.message : "Could not save the address.");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <StatusLine tone="error">{error}</StatusLine>;
  if (!data) return <StatusLine tone="muted">Loading…</StatusLine>;

  if (data.listings.length === 0) {
    return (
      <div className="max-w-xl border border-line/10 bg-panel p-6">
        <h2 className="font-serif text-3xl tracking-[-0.03em]">Nothing listed yet</h2>
        <p className="mt-3 text-sm leading-6 text-muted">Paste an MCP server or OpenAPI URL and publish in about a minute.</p>
        <div className="mt-6 flex gap-3">
          <Link href="/sell" className={buttonClass}>Sell your agent</Link>
          <Link href="/demand" className={ghostClass}>See demand</Link>
        </div>
      </div>
    );
  }

  const stats: [string, string][] = [
    ["Listings", data.totals.listings.toString()],
    ["Calls", data.totals.calls.toString()],
    ["Released", data.totals.released.toString()],
    ["Earnings (sandbox)", `${trimUsdc(data.totals.earningsUsdc)} USDC`],
    ["Payout pending", `${trimUsdc(data.totals.pendingPayoutUsdc)} USDC`],
  ];
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        {data.founding ? (
          <span className="border border-brass/60 px-2 py-1 font-mono text-[11px] tracking-[0.12em] text-brass uppercase">
            Founding seller #{data.founding.number.toString()} · {takeRateLabel(data.takeRateBps)} take until {new Date(data.founding.until).toLocaleDateString("en-GB")}
          </span>
        ) : (
          <span className="font-mono text-[11px] text-muted">Take-rate {takeRateLabel(data.takeRateBps)}</span>
        )}
        <span className="border border-line/20 px-2 py-1 font-mono text-[10px] tracking-[0.12em] text-muted uppercase">Sandbox</span>
        <Link href="/sell" className="ml-auto text-sm text-brass hover:text-brass-bright">+ Publish more</Link>
      </div>
      <dl className="grid grid-cols-2 gap-px border border-line/10 bg-line/10 md:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="bg-panel p-4">
            <dt className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">{label}</dt>
            <dd className="mt-1 font-serif text-2xl text-paper">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">{data.payoutNote}</p>

      <div className="overflow-x-auto border border-line/10">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-panel-2 font-mono text-[10px] tracking-[0.12em] text-muted uppercase">
            <tr>
              <th className="px-4 py-3">Listing</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Calls</th>
              <th className="px-4 py-3">Released / refunded</th>
              <th className="px-4 py-3">Avg latency</th>
              <th className="px-4 py-3 text-right">Earned</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/10 bg-panel">
            {data.listings.map((listing) => (
              <tr key={listing.id}>
                <td className="px-4 py-3">
                  <Link href={`/listings/${encodeURIComponent(listing.id)}`} className="text-paper hover:text-brass">{listing.name}</Link>
                  <p className="font-mono text-[11px] text-muted">
                    {listing.endpoint ? `${listing.endpoint.type.toUpperCase()} · ${listing.endpoint.host}` : "manual delivery"} · {listing.status}
                  </p>
                </td>
                <td className="px-4 py-3 font-mono">{trimUsdc(listing.priceUsdc)}</td>
                <td className="px-4 py-3 font-mono">{listing.calls.toString()}</td>
                <td className="px-4 py-3 font-mono">{listing.released.toString()} / {listing.refunded.toString()}</td>
                <td className="px-4 py-3 font-mono">{listing.avgLatencyMs !== null ? `${listing.avgLatencyMs.toString()} ms` : "—"}</td>
                <td className="px-4 py-3 text-right font-mono text-brass">{trimUsdc(listing.earningsUsdc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.recent.length > 0 ? (
        <section>
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Recent calls</h2>
          <ul className="mt-3 divide-y divide-line/10 border border-line/10">
            {data.recent.map((job) => (
              <li key={job.id} className="flex items-center justify-between gap-4 bg-panel px-4 py-2 text-sm">
                <span className="truncate text-paper">{job.listingName}</span>
                <span className="font-mono text-[11px] text-muted">
                  {job.status} · +{trimUsdc(job.sellerNetUsdc)} USDC{job.latencyMs !== null ? ` · ${job.latencyMs.toString()} ms` : ""} · {relativeTime(job.at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="max-w-2xl border border-line/10 bg-panel p-5">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Payout wallet</h2>
        <p className="mt-2 text-sm text-paper">
          {data.profile?.payout ? `${data.profile.payout.chain === "base" ? "Base" : "Solana"} · ${data.profile.payout.masked}` : "Not set"}
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <select className={`${fieldClass} sm:w-36`} aria-label="Chain" value={chain} onChange={(event) => setChain(event.target.value === "base" ? "base" : "solana")}>
            <option value="solana">Solana</option>
            <option value="base">Base</option>
          </select>
          <input className={`${fieldClass} font-mono`} aria-label="New payout address" placeholder="New address" value={address} onChange={(event) => setAddress(event.target.value)} />
          <button type="button" className={buttonClass} disabled={saving || Boolean(payoutHint(chain, address))} onClick={() => void savePayout()}>
            Save
          </button>
        </div>
        {saved ? <p className="mt-2 text-xs text-muted">{saved}</p> : null}
      </section>
    </div>
  );
}
