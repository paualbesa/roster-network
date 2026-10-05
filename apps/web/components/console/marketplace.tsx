"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createRosterClient,
  formatPassport,
  rosterErrorMessage,
  type ConsoleAgent,
  type MarketplaceHit,
} from "@/lib/roster-client";
import { kindLabel } from "@/lib/need";
import { FeeQuoteLine } from "./fee-quote";
import { NeedSearch } from "@/components/need-search";
import { RequireSession } from "./require-session";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass, ghostClass } from "./ui";

export function Marketplace() {
  return (
    <ConsolePage
      eyebrow="Marketplace"
      title="Discover a listing."
      lede="Search the capability registry by query. Turn on semantic search or passport ranking when you want those signals in the request. Price, latency, and passport are on each result."
    >
      <RequireSession>
        <div className="mb-10">
          <NeedSearch variant="console" />
        </div>
        <MarketplaceBody />
      </RequireSession>
    </ConsolePage>
  );
}

function MarketplaceBody() {
  const { session } = useSandboxSession();
  const [query, setQuery] = useState("");
  const [semantic, setSemantic] = useState(false);
  const [withReputation, setWithReputation] = useState(true);
  const [hits, setHits] = useState<MarketplaceHit[]>([]);
  const [agents, setAgents] = useState<ConsoleAgent[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const search = useCallback(
    async (input: { q: string; semantic: boolean; withReputation: boolean }) => {
      if (!session) return;
      const client = createRosterClient({ apiKey: session.apiKey });
      const [nextHits, nextAgents, account] = await Promise.all([
        client.search(input),
        client.listAgents(),
        client.account(),
      ]);
      setHits(nextHits);
      setAgents(nextAgents);
      setOrganizationId(account.organizationId);
    },
    [session],
  );

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    void search({ q: "", semantic: false, withReputation: true })
      .catch((cause: unknown) => {
        if (!cancelled) setError(rosterErrorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, session]);

  async function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setNotice("");
    try {
      await search({ q: query, semantic, withReputation });
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function seed() {
    if (!session) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const client = createRosterClient({ apiKey: session.apiKey });
      const listings = await client.seed();
      setNotice(`Sample catalog ready (${listings.length.toString()} listings). Bind a seller before hiring.`);
      await search({ q: query, semantic, withReputation });
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function bind(listingId: string, sellerAgentId: string) {
    if (!session || !sellerAgentId) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const client = createRosterClient({ apiKey: session.apiKey });
      await client.bindSeller(listingId, sellerAgentId);
      setNotice("Seller bound. A different agent can now lock a job against this listing.");
      await search({ q: query, semantic, withReputation });
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={onSearch} className="grid gap-4 border border-line/10 bg-panel p-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="registry-q" className="text-sm text-paper">
            Query
          </label>
          <input
            id="registry-q"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="parse receipts"
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <label className="inline-flex min-h-12 items-center gap-3 text-sm text-paper">
            <input
              type="checkbox"
              checked={semantic}
              onChange={(event) => setSemantic(event.target.checked)}
              className="size-4 accent-brass"
            />
            Semantic search
          </label>
          <label className="inline-flex min-h-12 items-center gap-3 text-sm text-paper">
            <input
              type="checkbox"
              checked={withReputation}
              onChange={(event) => setWithReputation(event.target.checked)}
              className="size-4 accent-brass"
            />
            Include passport
          </label>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="submit" className={buttonClass} disabled={pending}>
            {pending ? "Searching…" : "Search registry"}
          </button>
          <button type="button" className={ghostClass} disabled={pending} onClick={() => void seed()}>
            Publish sample catalog
          </button>
        </div>
        <p className="text-xs leading-5 text-muted">
          Semantic adds <code className="font-mono text-paper">semantic=1</code>. Passport adds{" "}
          <code className="font-mono text-paper">withReputation=1</code>. An empty query browses active listings.
        </p>
      </form>

      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {notice ? <StatusLine tone="ok">{notice}</StatusLine> : null}
      {loading ? <p className="text-sm text-muted">Loading the registry…</p> : null}

      {!loading && hits.length === 0 ? (
        <p className="text-sm leading-6 text-muted">
          No listings matched. Publish the sample catalog, or widen the query. This is not a waitlist.
        </p>
      ) : null}

      <ul className="grid gap-4">
        {hits.map((hit) => {
          const owned = hit.listing.organizationId !== "" && hit.listing.organizationId === organizationId;
          return (
            <li key={hit.listing.id} className="border border-line/10 bg-panel p-5 md:p-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-mono text-[10px] tracking-[0.12em] uppercase">
                    <span className={`rounded-full px-2.5 py-1 ${hit.listing.kind === "service" ? "bg-line/10 text-muted" : "bg-sage/15 text-sage"}`}>
                      {kindLabel(hit.listing.kind)}
                    </span>
                    {hit.listing.data ? (
                      <span className="text-muted normal-case tracking-normal">
                        {hit.listing.data.refreshCadence} · {hit.listing.data.source} · {hit.listing.data.license}
                      </span>
                    ) : null}
                  </p>
                  <h2 className="mt-2 font-serif text-3xl tracking-[-0.03em]">
                    <Link href={`/listings/${encodeURIComponent(hit.listing.id)}`} className="hover:text-brass">
                      {hit.listing.name}
                    </Link>
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{hit.listing.description}</p>
                  {hit.listing.tags.length > 0 ? (
                    <p className="mt-3 font-mono text-[11px] tracking-[0.14em] text-brass uppercase">
                      {hit.listing.tags.join(" · ")}
                    </p>
                  ) : null}
                </div>
                <Link
                  href={`/console/hire?listing=${encodeURIComponent(hit.listing.id)}`}
                  className={buttonClass}
                >
                  Hire
                </Link>
              </div>
              <dl className="mt-6 grid gap-px bg-line/10 sm:grid-cols-3">
                <Metric label="Price" value={`${hit.listing.pricing.amountUsdc} USDC`} />
                <Metric label="Latency" value={`${hit.listing.latency.p95Ms.toString()} ms`} />
                <Metric label="Passport" value={formatPassport(hit.reputationScore)} />
              </dl>
              <FeeQuoteLine amountUsdc={hit.listing.pricing.amountUsdc} />
              <p className="mt-4 font-mono text-xs break-all text-muted">
                {hit.listing.agentId ? `Seller ${hit.listing.agentId}` : "No seller bound"}
              </p>
              {owned ? (
                <BindSeller
                  listingId={hit.listing.id}
                  agents={agents}
                  disabled={pending}
                  onBind={(sellerAgentId) => void bind(hit.listing.id, sellerAgentId)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel px-4 py-3">
      <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-paper">{value}</dd>
    </div>
  );
}

function BindSeller({
  listingId,
  agents,
  disabled,
  onBind,
}: {
  listingId: string;
  agents: ConsoleAgent[];
  disabled: boolean;
  onBind: (sellerAgentId: string) => void;
}) {
  const [sellerAgentId, setSellerAgentId] = useState(agents[0]?.id ?? "");
  const selectId = `seller-${listingId}`;

  useEffect(() => {
    if (sellerAgentId && agents.some((agent) => agent.id === sellerAgentId)) return;
    setSellerAgentId(agents[0]?.id ?? "");
  }, [agents, sellerAgentId]);

  return (
    <form
      className="mt-4 flex flex-col gap-3 border-t border-line/10 pt-4 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        onBind(sellerAgentId);
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <label htmlFor={selectId} className="text-sm text-paper">
          Bind your seller agent
        </label>
        <select
          id={selectId}
          value={sellerAgentId}
          onChange={(event) => setSellerAgentId(event.target.value)}
          className={fieldClass}
        >
          {agents.length === 0 ? <option value="">Create an agent first</option> : null}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className={ghostClass} disabled={disabled || !sellerAgentId}>
        Bind seller
      </button>
    </form>
  );
}
