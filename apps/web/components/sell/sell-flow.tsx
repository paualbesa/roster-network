"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { readBrowserSession } from "@/lib/session";
import {
  payoutHint,
  sellRequest,
  SellApiError,
  takeRateLabel,
  type ImportedDraft,
  type ImportResponse,
  type PublishResponse,
} from "@/lib/sell";

const field = "min-h-11 w-full border border-line/15 bg-panel-2 px-3 text-sm text-paper placeholder:text-muted";
const button =
  "inline-flex min-h-11 items-center justify-center bg-brass px-5 text-sm font-medium text-ink transition-colors hover:bg-brass-bright disabled:cursor-wait disabled:opacity-60";

const SAMPLES = [
  { label: "DeepWiki MCP", url: "https://mcp.deepwiki.com/mcp" },
  { label: "Petstore OpenAPI", url: "https://petstore3.swagger.io/api/v3/openapi.json" },
];

interface DraftState {
  draft: ImportedDraft;
  selected: boolean;
  name: string;
  description: string;
  priceUsdc: string;
  p95S: string;
  example: string;
  outputSchema: string;
}

function initialSelection(draft: ImportedDraft, index: number): boolean {
  if (index >= 8) return false;
  return draft.endpoint.type === "mcp" || draft.endpoint.method === "GET";
}

export function SellFlow({ need }: { need: string | null }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [drafts, setDrafts] = useState<DraftState[]>([]);
  const [chain, setChain] = useState<"solana" | "base">("solana");
  const [address, setAddress] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<PublishResponse | null>(null);

  useEffect(() => {
    setApiKey(readBrowserSession()?.apiKey ?? null);
    setReady(true);
  }, []);

  const selected = useMemo(() => drafts.filter((entry) => entry.selected), [drafts]);
  const hint = payoutHint(chain, address);

  async function runImport(target: string) {
    setError("");
    setPublished(null);
    if (!apiKey) {
      setError("Sign in first: listings are published under your sandbox account.");
      return;
    }
    setImporting(true);
    try {
      const response = await sellRequest<ImportResponse>("POST", "/v1/listings/import", apiKey, { url: target.trim() });
      setResult(response);
      setDrafts(
        response.drafts.map((draft, index) => ({
          draft,
          selected: initialSelection(draft, index),
          name: draft.name,
          description: draft.description,
          priceUsdc: draft.suggestedPriceUsdc,
          p95S: (draft.p95Ms / 1000).toString(),
          example: JSON.stringify(draft.example, null, 2),
          outputSchema: JSON.stringify(draft.outputSchema, null, 2),
        })),
      );
    } catch (caught) {
      setResult(null);
      setDrafts([]);
      setError(caught instanceof SellApiError ? caught.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  function update(index: number, patch: Partial<DraftState>) {
    setDrafts((current) => current.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));
  }

  async function publish() {
    setError("");
    if (!apiKey || selected.length === 0 || hint) return;
    const listings = [];
    for (const entry of selected) {
      let example: unknown;
      let outputSchema: unknown;
      try {
        example = JSON.parse(entry.example || "{}");
        outputSchema = JSON.parse(entry.outputSchema);
      } catch {
        setError(`"${entry.name}": example input and output schema must be valid JSON.`);
        return;
      }
      const hasExample = example && typeof example === "object" && Object.keys(example).length > 0;
      listings.push({
        name: entry.name.trim(),
        description: entry.description.trim(),
        inputSchema: hasExample ? { ...entry.draft.inputSchema, examples: [example] } : entry.draft.inputSchema,
        outputSchema,
        priceUsdc: entry.priceUsdc.trim(),
        p95Ms: Math.round(Number(entry.p95S) * 1000),
        tags: entry.draft.tags,
        endpoint: entry.draft.endpoint,
        sourceUrl: result?.source.url,
      });
    }
    setPublishing(true);
    try {
      setPublished(await sellRequest<PublishResponse>("POST", "/v1/listings/publish", apiKey, { listings, payout: { chain, address: address.trim() } }));
    } catch (caught) {
      setError(caught instanceof SellApiError ? caught.message : "Publishing failed.");
    } finally {
      setPublishing(false);
    }
  }

  if (published) {
    return (
      <div className="border border-sage/40 bg-panel p-6">
        <p className="font-mono text-[11px] tracking-[0.16em] text-sage uppercase">Published · sandbox</p>
        <h2 className="mt-2 font-serif text-3xl tracking-[-0.03em]">
          {published.listings.length.toString()} listing{published.listings.length === 1 ? "" : "s"} live on Roster
        </h2>
        {published.founding ? (
          <p className="mt-3 text-sm text-brass">
            Founding seller #{published.founding.number.toString()}: {takeRateLabel(published.takeRateBps)} take-rate until{" "}
            {new Date(published.founding.until).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted">Take-rate: {takeRateLabel(published.takeRateBps)} per settled job.</p>
        )}
        <ul className="mt-5 space-y-2">
          {published.listings.map((listing) => (
            <li key={listing.id}>
              <Link className="text-paper underline decoration-line/30 underline-offset-4 hover:text-brass" href={`/listings/${encodeURIComponent(listing.id)}`}>
                {listing.name}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/console/seller" className={button}>
            Open seller dashboard
          </Link>
          <button type="button" className="min-h-11 border border-line/20 px-5 text-sm text-paper hover:text-brass" onClick={() => { setPublished(null); setResult(null); setDrafts([]); setUrl(""); }}>
            Import another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {need ? (
        <div className="border border-brass/40 bg-panel p-4 text-sm leading-6">
          <span className="font-mono text-[11px] tracking-[0.16em] text-brass uppercase">Agents are asking for</span>
          <p className="mt-1 text-paper">“{need}”</p>
          <p className="mt-1 text-muted">Import an MCP server or API that answers this, and it shows up for those requests.</p>
        </div>
      ) : null}

      <form
        className="border border-line/10 bg-panel p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void runImport(url);
        }}
      >
        <label htmlFor="sell-url" className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
          1 · MCP server URL or OpenAPI URL
        </label>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            id="sell-url"
            className={field}
            type="url"
            inputMode="url"
            required
            placeholder="https://your-server.com/mcp  or  https://api.you.com/openapi.json"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" className={button} disabled={importing || !ready}>
            {importing ? "Reading…" : "Import"}
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Try:{" "}
          {SAMPLES.map((sample, index) => (
            <span key={sample.url}>
              {index > 0 ? " · " : ""}
              <button type="button" className="underline decoration-line/30 underline-offset-4 hover:text-paper" onClick={() => setUrl(sample.url)}>
                {sample.label}
              </button>
            </span>
          ))}
          . Public https endpoints only. Your endpoint URL stays private: buyers only see the listing.
        </p>
        {ready && !apiKey ? (
          <p className="mt-3 text-sm text-paper">
            <Link href="/console/login" className="text-brass underline underline-offset-4">Sign in</Link> or{" "}
            <Link href="/console" className="text-brass underline underline-offset-4">create a sandbox account</Link> to import and publish.
          </p>
        ) : null}
      </form>

      {error ? (
        <p role="alert" className="text-sm text-brass-bright">
          {error}
        </p>
      ) : null}

      {result ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
              2 · Review {drafts.length.toString()} {result.source.type === "mcp" ? "tools" : "operations"} from {result.source.title}
            </h2>
            <p className="text-xs text-muted">{selected.length.toString()} selected</p>
          </div>
          {result.skipped.length > 0 ? (
            <p className="text-xs text-muted">Skipped: {result.skipped.slice(0, 4).map((entry) => `${entry.item} (${entry.reason})`).join(" · ")}</p>
          ) : null}
          <ul className="space-y-3">
            {drafts.map((entry, index) => (
              <li key={`${entry.draft.name}-${index.toString()}`} className={`border bg-panel p-4 ${entry.selected ? "border-brass/40" : "border-line/10 opacity-70"}`}>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Publish ${entry.name}`}
                    className="mt-3 size-4 accent-[#c4a36a]"
                    checked={entry.selected}
                    onChange={(event) => update(index, { selected: event.target.checked })}
                  />
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="grid gap-3 md:grid-cols-[1fr_8rem_7rem]">
                      <input className={field} aria-label="Name" maxLength={80} value={entry.name} onChange={(event) => update(index, { name: event.target.value })} />
                      <label className="flex items-center gap-2 text-xs text-muted">
                        <input className={field} aria-label="Price in USDC" inputMode="decimal" value={entry.priceUsdc} onChange={(event) => update(index, { priceUsdc: event.target.value })} />
                        USDC
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted">
                        <input className={field} aria-label="SLA in seconds" inputMode="numeric" value={entry.p95S} onChange={(event) => update(index, { p95S: event.target.value })} />
                        s SLA
                      </label>
                    </div>
                    <textarea className={`${field} min-h-20 py-2`} aria-label="Description" maxLength={4000} value={entry.description} onChange={(event) => update(index, { description: event.target.value })} />
                    <p className="font-mono text-[11px] text-muted">
                      {entry.draft.endpoint.type === "mcp" ? `MCP tool ${entry.draft.endpoint.toolName}` : `${entry.draft.endpoint.method} ${new URL(entry.draft.endpoint.url.replace(/[{}]/g, "")).pathname}`} · price{" "}
                      {entry.draft.priceBasis}
                      {entry.draft.similar.length > 0 ? ` (${entry.draft.similar.slice(0, 2).map((item) => item.name).join(", ")})` : ""}
                    </p>
                    {entry.draft.warnings.map((warning) => (
                      <p key={warning} className="text-xs text-brass-bright">{warning}</p>
                    ))}
                    <details className="text-sm">
                      <summary className="cursor-pointer text-xs text-muted hover:text-paper">Example input and output schema</summary>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="text-xs text-muted">
                          Example input (buyers start from it)
                          <textarea className={`${field} mt-1 min-h-32 py-2 font-mono text-xs`} value={entry.example} onChange={(event) => update(index, { example: event.target.value })} />
                        </label>
                        <label className="text-xs text-muted">
                          Output schema (escrow releases only when the response matches)
                          <textarea className={`${field} mt-1 min-h-32 py-2 font-mono text-xs`} value={entry.outputSchema} onChange={(event) => update(index, { outputSchema: event.target.value })} />
                        </label>
                      </div>
                    </details>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="border border-line/10 bg-panel p-5">
            <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">3 · Payout wallet</p>
            <p className="mt-2 text-sm text-muted">Roster never holds your keys. Earnings accrue to this address (sandbox: mock USDC, no transfers yet).</p>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <select className={`${field} sm:w-36`} aria-label="Chain" value={chain} onChange={(event) => setChain(event.target.value === "base" ? "base" : "solana")}>
                <option value="solana">Solana</option>
                <option value="base">Base</option>
              </select>
              <input className={`${field} font-mono`} aria-label="Wallet address" placeholder={chain === "solana" ? "Solana address" : "0x… Base address"} value={address} onChange={(event) => setAddress(event.target.value)} />
            </div>
            {address && hint ? <p className="mt-2 text-xs text-brass-bright">{hint}</p> : null}
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <button type="button" className={button} disabled={publishing || selected.length === 0 || Boolean(hint) || !apiKey} onClick={() => void publish()}>
                {publishing ? "Publishing…" : `Publish ${selected.length.toString()} listing${selected.length === 1 ? "" : "s"}`}
              </button>
              {result.founding.eligible ? (
                <span className="text-sm text-brass">
                  Founding seat available: {takeRateLabel(0)} take-rate for {result.founding.days.toString()} days ({result.founding.remaining.toString()} of {result.founding.limit.toString()} left).
                </span>
              ) : result.founding.badge ? (
                <span className="text-sm text-brass">Founding seller #{result.founding.badge.number.toString()}</span>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
