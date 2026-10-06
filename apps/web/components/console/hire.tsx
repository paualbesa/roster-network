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
  type SolanaLockReceipt,
  type SolanaSettleReceipt,
} from "@/lib/roster-client";
import {
  collectedOnRelease,
  describeRosterFee,
  quoteRosterFee,
  sandboxRailProblem,
  solanaJobPhase,
  type SolanaJobPhase,
} from "@/lib/roster-fee";
import { sampleResult } from "@/lib/sample-result";
import { sandboxParticipantPubkey } from "@/lib/sandbox-pubkey";
import { defaultHireAmount, isPositiveUsdc } from "@/lib/usdc";
import { FeeQuote } from "./fee-quote";
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
      lede="Shows the job price, the Roster fee (1% + 0.003 USDC), and the provider payout. Creating a job locks mock USDC, then prepares a sandbox Solana lock. Settle runs after a verified release. The mock cluster does not broadcast. A listing SLA timeout refunds the buyer and collects no fee."
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
  const [inputText, setInputText] = useState("{}");
  const [tags, setTags] = useState<string[]>([]);
  const [job, setJob] = useState<ConsoleJob | null>(null);
  const [lock, setLock] = useState<SolanaLockReceipt | null>(null);
  const [settlement, setSettlement] = useState<SolanaSettleReceipt | null>(null);
  const [solanaNotice, setSolanaNotice] = useState("");
  const [settleAttempt, setSettleAttempt] = useState(0);
  const [settleFailed, setSettleFailed] = useState(false);
  const settleStarted = useRef<string | null>(null);
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
        setInputText(JSON.stringify(exampleInput(nextListing.inputSchema), null, 2));
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

  const quoted = quoteRosterFee(job?.amountUsdc || amount);
  const phase: SolanaJobPhase = solanaJobPhase({
    quoteOk: quoted.ok,
    hasLock: lock !== null,
    hasSettlement: settlement !== null,
    status: job?.status ?? "held",
  });

  useEffect(() => {
    if (phase !== "refund-without-fee" || !job) return;
    setSolanaNotice("The buyer is refunded in full. Settle was skipped, so the Roster fee was not collected.");
  }, [phase, job]);

  const settleJobId = job?.id ?? "";
  const settleStatus = job?.status ?? "";
  const settleAmount = job?.amountUsdc ?? "";
  const settleBuyerId = job?.buyerAgentId ?? "";
  const settleSellerId = job?.sellerAgentId ?? "";
  const settleEscrowId = lock?.escrowId ?? "";
  const settleCluster = lock?.cluster ?? "";
  const settleBroadcast = lock?.broadcast ?? true;

  useEffect(() => {
    if (!session || phase !== "settle" || !settleJobId || !settleEscrowId) return;
    const railProblem = sandboxRailProblem({ cluster: settleCluster, broadcast: settleBroadcast });
    if (railProblem) return;
    const attemptKey = `${settleJobId}:${settleAttempt.toString()}`;
    if (settleStarted.current === attemptKey) return;
    settleStarted.current = attemptKey;
    let cancelled = false;
    const client = createRosterClient({ apiKey: session.apiKey });
    void (async () => {
      try {
        const [buyerPubkey, providerPubkey] = await Promise.all([
          sandboxParticipantPubkey(`buyer:${settleBuyerId}`),
          sandboxParticipantPubkey(`provider:${settleSellerId}`),
        ]);
        const settled = await client.settleEscrow({
          escrowId: settleEscrowId,
          jobId: settleJobId,
          buyerPubkey,
          providerPubkey,
          amountUsdc: settleAmount,
          verified: true,
        });
        if (cancelled) return;
        const settledRail = sandboxRailProblem(settled);
        if (settledRail) {
          settleStarted.current = null;
          setSettleFailed(true);
          setError(settledRail);
          return;
        }
        setSettleFailed(false);
        setSettlement(settled);
        setSolanaNotice("Settle signed on the mock cluster. The Roster fee is collected. Nothing was broadcast.");
      } catch (cause) {
        if (cancelled) return;
        settleStarted.current = null;
        setSettleFailed(true);
        setError(rosterErrorMessage(cause));
      }
    })();
    return () => {
      cancelled = true;
      if (settleStarted.current === attemptKey) settleStarted.current = null;
    };
  }, [
    phase,
    session,
    settleAmount,
    settleAttempt,
    settleBroadcast,
    settleBuyerId,
    settleCluster,
    settleEscrowId,
    settleJobId,
    settleSellerId,
    settleStatus,
  ]);

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
    let jobInput: unknown;
    try {
      jobInput = inputText.trim() ? (JSON.parse(inputText) as unknown) : {};
    } catch {
      setError("Input must be JSON.");
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
        input: jobInput,
        memo: listing ? `Sandbox console hire ${listing.id}` : "Sandbox console hire",
        ...(listing ? { listingId: listing.id } : {}),
      });
      settleStarted.current = null;
      setSettleAttempt(0);
      setSettleFailed(false);
      setLock(null);
      setSettlement(null);
      setSolanaNotice("");
      setJob(created);
      setResultText(JSON.stringify(sampleResult(schema), null, 2));
      setNotice("Mock escrow is held. Polling for release, timeout, or failure.");
      setPollToken((value) => value + 1);
      const preview = quoteRosterFee(created.amountUsdc);
      if (!preview.ok) {
        setSolanaNotice(`${preview.message} Prepare-lock was skipped. Mock escrow is still held.`);
      } else {
        try {
          const buyerPubkey = await sandboxParticipantPubkey(`buyer:${created.buyerAgentId}`);
          const prepared = await client.prepareLock({
            buyerPubkey,
            amountUsdc: created.amountUsdc,
            escrowId: created.escrowId,
            jobId: created.id,
          });
          const preparedRail = sandboxRailProblem(prepared);
          if (preparedRail) {
            setError(preparedRail);
          } else {
            setLock(prepared);
            setSolanaNotice("Prepare-lock signed on the mock cluster. Nothing was broadcast.");
          }
        } catch (cause) {
          setError(rosterErrorMessage(cause));
        }
      }
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
        <FeeQuote amountUsdc={amount} />
        <p className="text-xs leading-5 text-muted">
          The Roster fee is 1% of the price plus 0.003 USDC. Provider payout is the price minus that fee. Timeout and refund collect nothing.
        </p>
        <div className="flex flex-col gap-2">
          <label htmlFor="hire-input" className="text-sm text-paper">
            Input (JSON)
          </label>
          <textarea
            id="hire-input"
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            rows={6}
            className={`${fieldClass} min-h-32 py-3 font-mono text-sm`}
          />
          <p className="text-xs leading-5 text-muted">Prefilled from the listing&apos;s example input. The provider receives this payload.</p>
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
        <p className="text-xs leading-5 text-muted">
          This locks mock USDC with the existing job route, then calls prepare-lock on the mock cluster.
        </p>
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
        {solanaNotice ? <StatusLine tone="muted">{solanaNotice}</StatusLine> : null}
        {polling ? <p className="text-sm text-muted">Polling job status…</p> : null}
        {job ? <Receipt job={job} lock={lock} settlement={settlement} phase={phase} /> : null}
        {job && settleFailed && phase === "settle" && !settlement ? (
          <button type="button" className={ghostClass} onClick={() => setSettleAttempt((value) => value + 1)}>
            Retry sandbox settle
          </button>
        ) : null}
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

function Receipt({
  job,
  lock,
  settlement,
  phase,
}: {
  job: ConsoleJob;
  lock: SolanaLockReceipt | null;
  settlement: SolanaSettleReceipt | null;
  phase: SolanaJobPhase;
}) {
  const parsed = quoteRosterFee(job.amountUsdc);
  const quote = lock?.quote ?? (parsed.ok ? parsed.quote : null);
  const view = quote ? describeRosterFee(quote, job.status) : null;
  const solanaRows = [
    ["Price", view ? `${view.priceUsdc} USDC` : job.amountUsdc],
    ["Roster fee", view ? `${view.quotedFeeUsdc} USDC` : "—"],
    ["Fee schedule", view?.schedule ?? "1% + 0.003 USDC"],
    ["Roster fee collected", view ? `${view.collectedFeeUsdc} USDC` : "0.000000 USDC"],
    ["Provider payout", view ? `${view.providerPayoutUsdc} USDC` : "—"],
    ["Buyer refund", view ? `${view.buyerRefundUsdc} USDC` : "0.000000 USDC"],
    ["Solana cluster", settlement?.cluster ?? lock?.cluster ?? job.chain ?? "mock"],
    ["Escrow mode", job.escrowMode ?? "—"],
    ["Vault PDA (devnet)", job.vaultAddress ?? job.holdAddress ?? "—"],
    ["Vault explorer (devnet)", job.vaultExplorerUrl ?? "—"],
    ["Escrow program (devnet)", job.programId ?? "—"],
    ["Program explorer (devnet)", job.programExplorerUrl ?? "—"],
    ["Lock explorer (devnet)", job.lockExplorerUrl ?? "—"],
    ["Settle explorer (devnet)", job.settlementExplorerUrl ?? "—"],
    ["Broadcast", settlement ? String(settlement.broadcast) : lock ? String(lock.broadcast) : "false"],
    ["Prepare-lock", lock ? "Signed" : phase === "skip-fee" ? "Skipped" : "Pending"],
    ["Settle", settlement ? "Signed" : phase === "refund-without-fee" ? "Skipped" : phase === "settle" ? "Signing" : "Waiting"],
  ] as const;
  const ledgerRows = [
    ["Status", jobStatusLabel(job.status)],
    ["Listing", job.listingName || job.listingId],
    ["Mock take-rate quoted", job.takeRateUsdc],
    ["Mock take-rate collected", collectedOnRelease(job.status, job.takeRateUsdc)],
    ["Buyer balance", job.buyerBalanceUsdc],
    ["Seller balance", job.sellerBalanceUsdc],
  ] as const;
  return (
    <section className="border border-line/15 bg-panel" aria-label="Job receipt">
      <div className="border-b border-line/10 px-5 py-4">
        <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Roster fee</p>
        <p className="mt-2 font-mono text-xs break-all text-paper">{job.id}</p>
      </div>
      <dl className="divide-y divide-line/10">
        {solanaRows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-6 px-5 py-3">
            <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</dt>
            <dd className="text-right font-mono text-sm text-paper">{value}</dd>
          </div>
        ))}
      </dl>
      {view ? <p className="border-t border-line/10 px-5 py-4 text-sm leading-6 text-muted">{view.note}</p> : null}
      <div className="border-t border-line/10 px-5 py-4">
        <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Mock USDC ledger</p>
      </div>
      <dl className="divide-y divide-line/10 border-t border-line/10">
        {ledgerRows.map(([label, value]) => (
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

function exampleInput(schema: unknown): unknown {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const examples = (schema as { examples?: unknown }).examples;
    if (Array.isArray(examples) && examples.length > 0) return examples[0];
  }
  return {};
}
