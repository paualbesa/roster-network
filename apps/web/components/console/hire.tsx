"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isTerminalJobStatus, jobStatusLabel, pollUntilTerminal } from "@/lib/job-status";
import {
  createRosterClient,
  rosterErrorMessage,
  type ConsoleAgent,
  type ConsoleJob,
  type MarketplaceListing,
} from "@/lib/roster-client";
import { sampleResult } from "@/lib/sample-result";
import { defaultHireAmount, isPositiveUsdc } from "@/lib/usdc";
import { RequireSession } from "./require-session";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass, ghostClass } from "./ui";

const POLL_INTERVAL_MS = 1500;
const POLL_ATTEMPTS = 12;

export function Hire({ listingId }: { listingId: string }) {
  return (
    <ConsolePage
      eyebrow="Hire"
      title="Lock escrow, then settle."
      lede="Creates a job against the registry, polls until it is released, timed out, failed, or refunded, and shows the receipt. If this account owns the seller, you can deliver a sandbox result without curl."
    >
      <RequireSession>
        <HireBody listingId={listingId} />
      </RequireSession>
    </ConsolePage>
  );
}

function HireBody({ listingId }: { listingId: string }) {
  const { session } = useSandboxSession();
  const [agents, setAgents] = useState<ConsoleAgent[]>([]);
  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [buyerAgentId, setBuyerAgentId] = useState("");
  const [query, setQuery] = useState("");
  const [amount, setAmount] = useState("1.00");
  const [schemaText, setSchemaText] = useState('{\n  "type": "object",\n  "properties": { "total": { "type": "string" } },\n  "required": ["total"]\n}');
  const [tags, setTags] = useState<string[]>([]);
  const [job, setJob] = useState<ConsoleJob | null>(null);
  const [resultText, setResultText] = useState("");
  const [polling, setPolling] = useState(false);
  const [pollToken, setPollToken] = useState(0);
  const pollGeneration = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const client = createRosterClient({ apiKey: session.apiKey });
    void (async () => {
      try {
        const nextAgents = await client.listAgents();
        if (cancelled) return;
        setAgents(nextAgents);
        setBuyerAgentId((current) => current || nextAgents[0]?.id || "");
        if (!listingId) return;
        const nextListing = await client.listing(listingId);
        if (cancelled) return;
        setListing(nextListing);
        setQuery(nextListing.name);
        setAmount(defaultHireAmount(nextListing.pricing.amountUsdc));
        setSchemaText(JSON.stringify(nextListing.outputSchema, null, 2));
        setTags(nextListing.tags);
        setResultText(JSON.stringify(sampleResult(nextListing.outputSchema), null, 2));
      } catch (cause) {
        if (!cancelled) setError(rosterErrorMessage(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listingId, session]);

  useEffect(() => {
    if (!session || !job || pollToken === 0) return;
    let cancelled = false;
    const client = createRosterClient({ apiKey: session.apiKey });
    const generation = pollGeneration.current;
    setPolling(true);
    void pollUntilTerminal({
      read: async () => {
        const next = await client.job(job.id);
        if (!cancelled && generation === pollGeneration.current) setJob(next);
        return next;
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      intervalMs: POLL_INTERVAL_MS,
      maxAttempts: POLL_ATTEMPTS,
    })
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot.done) {
          setNotice(`Job ${jobStatusLabel(snapshot.value.status).toLowerCase()}. Receipt amounts are below.`);
        } else {
          setNotice("Still held. The seller has not delivered a result yet. You can check again, or deliver a sandbox result if you own the seller.");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(rosterErrorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setPolling(false);
      });
    return () => {
      cancelled = true;
    };
  }, [job?.id, pollToken, session]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    if (!buyerAgentId) {
      setError("Create a buyer on the dashboard before hiring.");
      return;
    }
    if (!query.trim()) {
      setError("Enter the capability you want to hire.");
      return;
    }
    if (!isPositiveUsdc(amount)) {
      setError("Lock amount must be a positive USDC amount.");
      return;
    }
    let schema: unknown;
    try {
      schema = JSON.parse(schemaText) as unknown;
    } catch {
      setError("Result schema must be JSON.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const client = createRosterClient({ apiKey: session.apiKey });
      const created = await client.createJob({
        buyerAgentId,
        query,
        amountUsdc: amount,
        schema,
        tags,
        memo: listing ? `Sandbox console hire ${listing.id}` : "Sandbox console hire",
        ...(listing ? { listingId: listing.id } : {}),
      });
      setJob(created);
      setResultText(JSON.stringify(sampleResult(schema), null, 2));
      setNotice("Escrow is held. Polling for release, timeout, or failure.");
      setPollToken((value) => value + 1);
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function deliver() {
    if (!session || !job) return;
    let result: unknown;
    try {
      result = JSON.parse(resultText) as unknown;
    } catch {
      setError("Sandbox result must be JSON.");
      return;
    }
    setPending(true);
    setError("");
    pollGeneration.current += 1;
    try {
      const client = createRosterClient({ apiKey: session.apiKey });
      const settled = await client.submitResult(job.id, result);
      setJob(settled);
      if (isTerminalJobStatus(settled.status)) {
        setNotice(`Seller delivery recorded. Status: ${jobStatusLabel(settled.status)}.`);
        setPollToken(0);
      } else {
        setPollToken((value) => value + 1);
      }
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <form onSubmit={onCreate} className="flex flex-col gap-4 border border-line/10 bg-panel p-6">
        {listing ? (
          <p className="text-sm leading-6 text-muted">
            Listing <span className="text-paper">{listing.name}</span>. Escrow locks this listing, not whichever search hit ranks first.
          </p>
        ) : (
          <p className="text-sm leading-6 text-muted">
            No listing selected.{" "}
            <Link href="/console/marketplace" className="text-brass underline decoration-brass/40 underline-offset-4">
              Pick one in the marketplace
            </Link>{" "}
            or type a query. The API hires the top ranked listing.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <label htmlFor="buyer" className="text-sm text-paper">
            Buyer agent
          </label>
          <select
            id="buyer"
            value={buyerAgentId}
            onChange={(event) => setBuyerAgentId(event.target.value)}
            className={fieldClass}
          >
            {agents.length === 0 ? <option value="">No agents yet</option> : null}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {agent.balanceUsdc} USDC
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="hire-query" className="text-sm text-paper">
            Query
          </label>
          <input id="hire-query" value={query} onChange={(event) => setQuery(event.target.value)} className={fieldClass} />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="hire-amount" className="text-sm text-paper">
            Lock amount (mock USDC)
          </label>
          <input
            id="hire-amount"
            value={amount}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="hire-schema" className="text-sm text-paper">
            Result schema
          </label>
          <textarea
            id="hire-schema"
            value={schemaText}
            onChange={(event) => setSchemaText(event.target.value)}
            rows={8}
            className={`${fieldClass} min-h-40 py-3 font-mono text-sm`}
          />
        </div>
        <button type="submit" className={buttonClass} disabled={pending || polling}>
          {pending ? "Locking escrow…" : "Create job"}
        </button>
        {agents.length === 0 ? (
          <p className="text-sm text-muted">
            <Link href="/console/dashboard" className="text-brass underline decoration-brass/40 underline-offset-4">
              Create and fund a buyer
            </Link>{" "}
            first.
          </p>
        ) : null}
      </form>

      <div className="flex flex-col gap-4">
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
        {notice ? <StatusLine tone="ok">{notice}</StatusLine> : null}
        {polling ? <p className="text-sm text-muted">Polling job status…</p> : null}
        {job ? <Receipt job={job} /> : null}
        {job && !isTerminalJobStatus(job.status) ? (
          <div className="flex flex-col gap-3 border border-line/10 bg-panel p-5">
            <h2 className="font-serif text-2xl tracking-[-0.03em]">Deliver a sandbox result</h2>
            <p className="text-sm leading-6 text-muted">
              Use this when your account owns the seller. A schema match releases the seller net of the take-rate. A mismatch refunds the buyer.
            </p>
            <label htmlFor="sandbox-result" className="text-sm text-paper">
              Result JSON
            </label>
            <textarea
              id="sandbox-result"
              value={resultText}
              onChange={(event) => setResultText(event.target.value)}
              rows={6}
              className={`${fieldClass} min-h-32 py-3 font-mono text-sm`}
            />
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" className={buttonClass} disabled={pending} onClick={() => void deliver()}>
                Submit result
              </button>
              <button
                type="button"
                className={ghostClass}
                disabled={pending || polling}
                onClick={() => setPollToken((value) => value + 1)}
              >
                Check again
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Receipt({ job }: { job: ConsoleJob }) {
  const rows = [
    ["Status", jobStatusLabel(job.status)],
    ["Listing", job.listingName || job.listingId],
    ["Locked", `${job.amountUsdc} USDC`],
    ["Take-rate", job.takeRateUsdc],
    ["Seller net", job.sellerNetUsdc],
    ["Buyer balance", job.buyerBalanceUsdc],
    ["Seller balance", job.sellerBalanceUsdc],
  ] as const;
  return (
    <section className="border border-line/15 bg-panel" aria-label="Job receipt">
      <div className="border-b border-line/10 px-5 py-4">
        <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Receipt</p>
        <p className="mt-2 font-mono text-xs break-all text-paper">{job.id}</p>
      </div>
      <dl className="divide-y divide-line/10">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-6 px-5 py-3">
            <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</dt>
            <dd className="text-right font-mono text-sm text-paper">{value}</dd>
          </div>
        ))}
      </dl>
      {job.validationErrors && job.validationErrors.length > 0 ? (
        <p className="border-t border-line/10 px-5 py-4 text-sm leading-6 text-brass-bright">
          {job.validationErrors.join(" ")}
        </p>
      ) : null}
    </section>
  );
}
