"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { jobStatusLabel } from "@/lib/job-status";
import { onboardingSteps } from "@/lib/onboarding";
import {
  createRosterClient,
  describeEscrowMode,
  kycUsagePercent,
  rosterErrorMessage,
  type AccountSnapshot,
  type KycSnapshot,
  type RosterHealth,
  type ConsoleAgent,
  type ConsoleJob,
  type TreasurySnapshot,
} from "@/lib/roster-client";
import { isPositiveUsdc } from "@/lib/usdc";
import { ApiKeyPanel } from "./api-key-panel";
import { RequireSession } from "./require-session";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass } from "./ui";

export function Dashboard() {
  return (
    <ConsolePage
      eyebrow="Dashboard"
      title="Treasury, then a buyer agent."
      lede="Sandbox mode grants mock USDC to the organization treasury. Move some of it onto a buyer before you hire. Create a second agent if you want to bind a seller on your own listings."
    >
      <RequireSession>
        <DashboardBody />
      </RequireSession>
    </ConsolePage>
  );
}

function DashboardBody() {
  const { session, acknowledge } = useSandboxSession();
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [treasury, setTreasury] = useState<TreasurySnapshot | null>(null);
  const [agents, setAgents] = useState<ConsoleAgent[]>([]);
  const [jobs, setJobs] = useState<ConsoleJob[]>([]);
  const [kyc, setKyc] = useState<KycSnapshot | null>(null);
  const [health, setHealth] = useState<RosterHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    if (!session) return;
    const client = createRosterClient({ apiKey: session.apiKey });
    const [nextAccount, nextTreasury, nextAgents, nextJobs] = await Promise.all([
      client.account(),
      client.treasury(),
      client.listAgents(),
      // Job history is a nice-to-have. A failure here must not blank the dashboard.
      client.listJobs().catch(() => [] as ConsoleJob[]),
    ]);
    setAccount(nextAccount);
    setTreasury(nextTreasury);
    setAgents(nextAgents);
    setJobs(nextJobs);
    // KYC and escrow mode are informational; older APIs may not have them.
    const [nextKyc, nextHealth] = await Promise.all([client.kyc().catch(() => null), client.health().catch(() => null)]);
    setKyc(nextKyc);
    setHealth(nextHealth);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void reload()
      .catch((cause: unknown) => {
        if (!cancelled) setError(rosterErrorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload, session]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const dailySpendLimitUsdc = String(data.get("dailySpendLimitUsdc") ?? "").trim();
    const fundAmount = String(data.get("fundAmount") ?? "").trim();
    if (!name) {
      setError("Name the agent.");
      return;
    }
    if (!isPositiveUsdc(dailySpendLimitUsdc)) {
      setError("Daily spend limit must be a positive USDC amount.");
      return;
    }
    if (fundAmount && !isPositiveUsdc(fundAmount)) {
      setError("Fund amount must be a positive USDC amount, or leave it blank.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    const client = createRosterClient({ apiKey: session.apiKey });
    try {
      const agent = await client.createAgent({ name, dailySpendLimitUsdc });
      if (fundAmount) {
        try {
          await client.fundAgent(agent.id, fundAmount);
        } catch (cause) {
          setNotice(`${rosterErrorMessage(cause)} The agent was still created.`);
          await reload();
          return;
        }
      }
      form.reset();
      setNotice(`${agent.name} is ready${fundAmount ? " and funded from treasury" : ""}.`);
      await reload();
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex flex-col gap-8">
        {session && !session.revealed ? <ApiKeyPanel apiKey={session.apiKey} onHide={acknowledge} /> : null}
        <section className="border border-line/10 bg-panel" aria-labelledby="treasury-title">
          <div className="border-b border-line/10 px-5 py-4">
            <p id="treasury-title" className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
              Treasury
            </p>
            <p className="mt-3 font-serif text-4xl tracking-[-0.03em] text-paper">
              {loading ? "…" : treasury ? `${treasury.balanceUsdc} USDC` : "—"}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              {account ? `${account.displayName} · ${account.email}` : "Sandbox organization"}
            </p>
            {treasury?.address ? (
              <p className="mt-2 font-mono text-xs break-all text-muted">{treasury.address}</p>
            ) : null}
          </div>
          <p className="px-5 py-4 text-sm leading-6 text-muted">
            Mock USDC only. Funding an agent moves balance inside the sandbox ledger. It does not touch a bank or a chain.
          </p>
        </section>

        {kyc || health ? (
          <section className="grid gap-px border border-line/10 bg-line/10 sm:grid-cols-2" aria-label="Limits and custody">
            {kyc ? (
              <div className="bg-panel px-5 py-4">
                <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">KYC · Tier {kyc.tier.toString()}</p>
                <p className="mt-2 text-sm text-paper">
                  {kyc.usedUsdc.replace(/\.?0+$/, "") || "0"} / {kyc.limitUsdc.replace(/\.?0+$/, "")} USDC in {kyc.windowDays.toString()} days
                </p>
                <div className="mt-2 h-1.5 w-full bg-panel-2" aria-hidden="true">
                  <div className="h-full bg-brass" style={{ width: `${kycUsagePercent(kyc).toString()}%` }} />
                </div>
                <Link href="/console/kyc" className="mt-3 inline-block text-sm text-brass underline decoration-brass/40 underline-offset-4">
                  {kyc.tier === 0 ? (kyc.status === "pending" ? "Review pending" : "Raise the cap") : "Verification"}
                </Link>
              </div>
            ) : null}
            {health ? (
              <div className="bg-panel px-5 py-4">
                <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Escrow mode · {health.escrowMode}</p>
                <p className="mt-2 text-sm leading-6 text-muted">{describeEscrowMode(health.escrowMode)}</p>
              </div>
            ) : null}
          </section>
        ) : null}

        {!loading ? <Onboarding agents={agents} jobs={jobs} /> : null}

        <section aria-labelledby="agents-title">
          <h2 id="agents-title" className="font-serif text-3xl tracking-[-0.03em]">
            Agents
          </h2>
          {loading ? <p className="mt-4 text-sm text-muted">Loading agents…</p> : null}
          {!loading && agents.length === 0 ? (
            <p className="mt-4 text-sm leading-6 text-muted">No agents yet. Create a buyer, fund it, then open the marketplace.</p>
          ) : null}
          {agents.length > 0 ? (
            <ul className="mt-4 divide-y divide-line/10 border-y border-line/10">
              {agents.map((agent) => (
                <li key={agent.id} className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline">
                  <div>
                    <p className="text-paper">
                      {agent.name}{" "}
                      <span className="font-mono text-xs text-muted">{agent.status}</span>
                    </p>
                    <p className="mt-1 font-mono text-xs break-all text-muted">{agent.id}</p>
                  </div>
                  <p className="font-mono text-sm text-brass">{agent.balanceUsdc} USDC</p>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <div className="mt-4">
              <StatusLine tone="error">{error}</StatusLine>
            </div>
          ) : null}
          {notice ? (
            <div className="mt-4">
              <StatusLine tone="ok">{notice}</StatusLine>
            </div>
          ) : null}
        </section>

        <RecentJobs jobs={jobs} loading={loading} />
      </div>

      <form onSubmit={onCreate} className="flex h-fit flex-col gap-4 border border-line/10 bg-panel p-6">
        <h2 className="font-serif text-3xl tracking-[-0.03em]">Create an agent</h2>
        <div className="flex flex-col gap-2">
          <label htmlFor="agent-name" className="text-sm text-paper">
            Name
          </label>
          <input id="agent-name" name="name" required maxLength={80} placeholder="buyer" className={fieldClass} />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="daily-limit" className="text-sm text-paper">
            Daily spend limit (USDC)
          </label>
          <input
            id="daily-limit"
            name="dailySpendLimitUsdc"
            required
            inputMode="decimal"
            defaultValue="10.00"
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="fund-amount" className="text-sm text-paper">
            Fund from treasury <span className="text-muted">(optional)</span>
          </label>
          <input id="fund-amount" name="fundAmount" inputMode="decimal" placeholder="5.00" className={fieldClass} />
        </div>
        <button type="submit" className={buttonClass} disabled={pending || !session}>
          {pending ? "Saving…" : "Create agent"}
        </button>
        <p className="text-xs leading-5 text-muted">
          Next:{" "}
          <Link href="/console/marketplace" className="text-brass underline decoration-brass/40 underline-offset-4">
            search the marketplace
          </Link>
          .
        </p>
      </form>
    </div>
  );
}

function Onboarding({ agents, jobs }: { agents: ConsoleAgent[]; jobs: ConsoleJob[] }) {
  const steps = onboardingSteps(agents, jobs);
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;
  return (
    <section className="border border-brass/30 bg-panel p-5" aria-labelledby="onboarding-title">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="onboarding-title" className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">
          Get to your first settled job
        </h2>
        <p className="font-mono text-xs text-muted">
          {done.toString()}/{steps.length.toString()}
        </p>
      </div>
      <div className="mt-3 h-1 w-full bg-line/10" aria-hidden="true">
        <div className="h-1 bg-brass transition-all" style={{ width: `${((done / steps.length) * 100).toString()}%` }} />
      </div>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2">
        {steps.map((step, index) => (
          <li key={step.id} className="flex items-center gap-3 text-sm">
            <span
              className={`inline-flex size-6 shrink-0 items-center justify-center border font-mono text-[11px] ${
                step.done ? "border-sage bg-sage/15 text-sage" : "border-line/20 text-muted"
              }`}
              aria-hidden="true"
            >
              {step.done ? "✓" : (index + 1).toString()}
            </span>
            {step.href && !step.done ? (
              <Link href={step.href} className="text-paper underline decoration-brass/40 underline-offset-4 hover:text-brass">
                {step.label}
              </Link>
            ) : (
              <span className={step.done ? "text-muted line-through" : "text-paper"}>{step.label}</span>
            )}
            <span className="sr-only">{step.done ? "done" : "to do"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const STATUS_TONE: Record<string, string> = {
  held: "border-brass/50 text-brass",
  released: "border-sage/60 text-sage",
  refunded: "border-line/30 text-muted",
  failed: "border-brass-bright/60 text-brass-bright",
  timed_out: "border-line/30 text-muted",
};

function RecentJobs({ jobs, loading }: { jobs: ConsoleJob[]; loading: boolean }) {
  const recent = jobs.slice(0, 8);
  return (
    <section aria-labelledby="jobs-title">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="jobs-title" className="font-serif text-3xl tracking-[-0.03em]">
          Recent jobs
        </h2>
        {jobs.length > recent.length ? (
          <p className="font-mono text-xs text-muted">
            {recent.length.toString()} of {jobs.length.toString()}
          </p>
        ) : null}
      </div>
      {loading ? <p className="mt-4 text-sm text-muted">Loading jobs…</p> : null}
      {!loading && recent.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No jobs yet.{" "}
          <Link href="/console/marketplace" className="text-brass underline decoration-brass/40 underline-offset-4">
            Hire your first agent
          </Link>
          .
        </p>
      ) : null}
      {recent.length > 0 ? (
        <div className="mt-4 overflow-x-auto border-y border-line/10">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead>
              <tr className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">
                <th scope="col" className="py-3 pr-4 font-normal">Listing</th>
                <th scope="col" className="py-3 pr-4 font-normal">Status</th>
                <th scope="col" className="py-3 pr-4 text-right font-normal">Amount</th>
                <th scope="col" className="py-3 pr-4 text-right font-normal">Take-rate</th>
                <th scope="col" className="py-3 text-right font-normal">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/10">
              {recent.map((job) => (
                <tr key={job.id}>
                  <td className="py-3 pr-4">
                    <p className="text-paper">{job.listingName || job.listingId}</p>
                    <p className="font-mono text-[11px] text-muted">{job.id}</p>
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`inline-flex border px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase ${
                        STATUS_TONE[job.status] ?? "border-line/30 text-muted"
                      }`}
                    >
                      {jobStatusLabel(job.status)}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-paper">{job.amountUsdc}</td>
                  <td className="py-3 pr-4 text-right font-mono text-muted">{job.takeRateUsdc}</td>
                  <td className="py-3 text-right font-mono text-xs text-muted">{formatWhen(job.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function formatWhen(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
