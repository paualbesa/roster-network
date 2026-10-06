"use client";

import Link from "next/link";
import { useEffect, useId, useState, type FormEvent } from "react";
import {
  NEED_EXAMPLES,
  formatUsdc,
  freshnessLine,
  kindHint,
  kindLabel,
  sampleCell,
  sampleColumns,
  type NeedMatchView,
  type NeedResponseView,
} from "@/lib/need";
import { createRosterClient, rosterErrorMessage } from "@/lib/roster-client";
import { readBrowserSession } from "@/lib/session";
import { BuyReceipt, useBuy } from "./buy-receipt";

export function NeedSearch({ variant = "hero", autoFocus = false }: { variant?: "hero" | "console"; autoFocus?: boolean }) {
  const inputId = useId();
  const [need, setNeed] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [response, setResponse] = useState<NeedResponseView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setApiKey(readBrowserSession()?.apiKey ?? null);
  }, []);

  async function run(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < 2) return;
    setPending(true);
    setError("");
    try {
      const client = createRosterClient(apiKey ? { apiKey } : {});
      setResponse(await client.need({ need: trimmed, limit: 6 }));
    } catch (caught) {
      setError(rosterErrorMessage(caught));
      setResponse(null);
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(need);
  }

  const big = variant === "hero";
  return (
    <div className={big ? "w-full" : "w-full border border-line/10 bg-panel p-5 md:p-6"}>
      <form onSubmit={onSubmit} role="search" aria-label="What do you need?">
        <label htmlFor={inputId} className={big ? "block font-serif text-[clamp(2rem,4.4vw,3.4rem)] leading-[1.02] tracking-[-0.03em]" : "block font-serif text-2xl tracking-[-0.03em]"}>
          Què necessites? <span className="text-brass italic">What do you need?</span>
        </label>
        <p className={`mt-3 max-w-2xl text-muted ${big ? "text-base leading-7" : "text-sm leading-6"}`}>
          Ask in plain words. Roster answers with data it already collected and cleaned, and with agents that do the job. Often cheaper than finding it yourself.
        </p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <input
            id={inputId}
            type="search"
            value={need}
            onChange={(event) => setNeed(event.target.value)}
            placeholder="e.g. EUR/USD daily rates since 2020 as CSV"
            maxLength={500}
            autoFocus={autoFocus}
            autoComplete="off"
            className={`w-full border border-line/20 bg-panel-2 px-4 text-paper placeholder:text-muted focus:border-brass/70 ${big ? "min-h-16 text-lg" : "min-h-12 text-base"}`}
          />
          <button
            type="submit"
            disabled={pending || need.trim().length < 2}
            className={`inline-flex shrink-0 items-center justify-center bg-brass px-6 text-sm font-medium text-ink transition-colors hover:bg-brass-bright disabled:cursor-not-allowed disabled:opacity-60 ${big ? "min-h-16" : "min-h-12"}`}
          >
            {pending ? "Searching…" : "Find it"}
          </button>
        </div>
        <p className="mt-3 flex flex-wrap gap-2">
          {NEED_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setNeed(example);
                void run(example);
              }}
              className="border border-line/15 px-2.5 py-1 font-mono text-[11px] tracking-[0.06em] text-muted transition-colors hover:border-brass/60 hover:text-brass"
            >
              {example}
            </button>
          ))}
        </p>
      </form>

      <div aria-live="polite" className="mt-6">
        {error ? <p role="alert" className="text-sm text-brass-bright">{error}</p> : null}
        {response && response.matches.length === 0 ? (
          <p className="border border-dashed border-line/20 px-4 py-6 text-sm text-muted">
            {response.unmetMessage ?? "Nothing matches yet."}
          </p>
        ) : null}
        {response && response.matches.length > 0 ? (
          <>
            {!response.matched ? (
              <p className="mb-4 text-sm text-muted">
                No exact match yet. We logged this need so we can build it. Closest listings:
              </p>
            ) : null}
            <ul className="grid gap-px border border-line/10 bg-line/10 md:grid-cols-2">
              {response.matches.map((match) => (
                <NeedCard key={match.listingId} match={match} apiKey={apiKey} />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}

function NeedCard({ match, apiKey }: { match: NeedMatchView; apiKey: string | null }) {
  const [showSample, setShowSample] = useState(false);
  const buy = useBuy(apiKey);
  const fresh = freshnessLine(match.freshness);
  const columns = sampleColumns(match.sample, 5);
  return (
    <li className="flex flex-col bg-panel p-5">
      <div className="flex items-start justify-between gap-3">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] uppercase ${match.kind === "service" ? "bg-line/10 text-muted" : "bg-sage/15 text-sage"}`}>
          {kindLabel(match.kind)}
        </span>
        <span className="font-mono text-lg text-brass">{formatUsdc(match.priceUsdc)} USDC</span>
      </div>
      <h3 className="mt-3 font-serif text-2xl leading-tight tracking-[-0.02em] text-paper">
        <Link href={`/listings/${encodeURIComponent(match.listingId)}`} className="hover:text-brass">
          {match.name}
        </Link>
      </h3>
      <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted">{match.summary}</p>
      <p className="mt-3 font-mono text-[11px] tracking-[0.08em] text-muted">{kindHint(match.kind)}</p>
      {fresh ? <p className="mt-1 font-mono text-[11px] tracking-[0.08em] text-sage">{fresh}</p> : null}
      {match.source ? (
        <p className="mt-1 font-mono text-[11px] tracking-[0.08em] text-muted">
          Source: {match.source.name} · {match.source.license}
        </p>
      ) : null}
      {columns.length > 0 ? (
        <button type="button" onClick={() => setShowSample((open) => !open)} className="mt-3 w-fit text-xs text-brass underline decoration-brass/40 underline-offset-4">
          {showSample ? "Hide sample" : "Show sample"}
        </button>
      ) : null}
      {showSample ? (
        <div className="mt-3 overflow-x-auto border border-line/10">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="bg-panel-2 text-muted">
              <tr>{columns.map((column) => <th key={column} className="px-2 py-1.5 font-medium">{column}</th>)}</tr>
            </thead>
            <tbody>
              {match.sample.slice(0, 3).map((row, index) => (
                <tr key={index} className="border-t border-line/10">
                  {columns.map((column) => <td key={column} className="px-2 py-1.5 whitespace-nowrap text-paper">{sampleCell(row[column])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-3 pt-5">
        {apiKey ? (
          <button
            type="button"
            disabled={buy.pending}
            onClick={() => void buy.run(match.listingId, match.inputExample)}
            className="inline-flex min-h-11 items-center justify-center bg-brass px-5 text-sm font-medium text-ink transition-colors hover:bg-brass-bright disabled:cursor-wait disabled:opacity-70"
          >
            {buy.pending ? "Buying…" : `Buy · ${formatUsdc(match.priceUsdc)} USDC`}
          </button>
        ) : (
          <Link href="/console/login" className="inline-flex min-h-11 items-center justify-center bg-brass px-5 text-sm font-medium text-ink transition-colors hover:bg-brass-bright">
            Sign in to buy
          </Link>
        )}
        <Link href={`/listings/${encodeURIComponent(match.listingId)}`} className="text-sm text-paper underline decoration-line/30 underline-offset-4 hover:text-brass">
          Details
        </Link>
      </div>
      <BuyReceipt state={buy} />
    </li>
  );
}
