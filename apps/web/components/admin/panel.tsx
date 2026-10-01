"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  adminRequest,
  jobFilterPath,
  jobStatusLabel,
  type AdminAccount,
  type AdminJob,
  type AdminJobDetail,
  type AdminListing,
  type AdminOverview,
  type AdminReputation,
  type JobFilter,
  AdminClientError,
} from "@/lib/admin-client";
import { ConsolePage, StatusLine, buttonClass, fieldClass, ghostClass } from "@/components/console/ui";

const FILTERS: { id: JobFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "locked", label: "Locked" },
  { id: "released", label: "Released" },
  { id: "timed_out", label: "Timed out" },
  { id: "failed", label: "Failed" },
];

export function AdminPanel() {
  const [phase, setPhase] = useState<"checking" | "gate" | "ready">("checking");
  const [token, setToken] = useState("");
  const [gateError, setGateError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/session", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ signedIn?: boolean }>)
      .then((body) => {
        if (!cancelled) setPhase(body.signedIn ? "ready" : "gate");
      })
      .catch(() => {
        if (!cancelled) setPhase("gate");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setGateError("");
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        setGateError(body?.message ?? "That operator token was rejected.");
        return;
      }
      setToken("");
      setPhase("ready");
    } catch {
      setGateError("Roster API is unreachable from this site.");
    } finally {
      setPending(false);
    }
  }

  const showGate = useCallback(() => setPhase("gate"), []);

  async function lock() {
    await fetch("/api/admin/session", { method: "DELETE" });
    showGate();
  }

  if (phase === "checking") {
    return (
      <ConsolePage eyebrow="Admin" title="Operator panel" lede="Checking the operator session.">
        <StatusLine tone="muted">Loading.</StatusLine>
      </ConsolePage>
    );
  }

  if (phase === "gate") {
    return (
      <ConsolePage
        eyebrow="Admin"
        title="Operator panel"
        lede="Sandbox supervision for Roster. Enter the operator token configured as ROSTER_ADMIN_TOKEN on the API. A console API key does not open this page."
      >
        <form onSubmit={unlock} className="max-w-md space-y-4 border border-line/15 bg-panel p-6">
          <label className="block text-sm text-paper" htmlFor="admin-token">
            Operator token
          </label>
          <input
            id="admin-token"
            name="token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className={fieldClass}
            required
          />
          <button type="submit" className={buttonClass} disabled={pending}>
            {pending ? "Checking" : "Unlock"}
          </button>
          {gateError ? <StatusLine tone="error">{gateError}</StatusLine> : null}
        </form>
      </ConsolePage>
    );
  }

  return <Dashboard onLock={() => void lock()} onUnauthorized={showGate} />;
}

function Dashboard({ onLock, onUnauthorized }: { onLock: () => void; onUnauthorized: () => void }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [listings, setListings] = useState<AdminListing[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [reputation, setReputation] = useState<AdminReputation | null>(null);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [detail, setDetail] = useState<AdminJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(
    async (nextFilter: JobFilter) => {
      setError("");
      try {
        const [nextOverview, nextAccounts, nextListings, nextJobs, nextReputation] = await Promise.all([
          adminRequest<AdminOverview>("/v1/admin/overview"),
          adminRequest<{ accounts: AdminAccount[] }>("/v1/admin/accounts"),
          adminRequest<{ listings: AdminListing[] }>("/v1/admin/listings"),
          adminRequest<{ jobs: AdminJob[] }>(jobFilterPath(nextFilter)),
          adminRequest<AdminReputation>("/v1/admin/reputation"),
        ]);
        setOverview(nextOverview);
        setAccounts(nextAccounts.accounts);
        setListings(nextListings.listings);
        setJobs(nextJobs.jobs);
        setReputation(nextReputation);
      } catch (caught) {
        if (caught instanceof AdminClientError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setError(caught instanceof Error ? caught.message : "Could not load the operator panel.");
      }
    },
    [onUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load(filter).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filter, load]);

  async function openJob(jobId: string) {
    setError("");
    setBusy("job");
    try {
      const next = await adminRequest<AdminJobDetail>(`/v1/admin/jobs/${encodeURIComponent(jobId)}`);
      setDetail(next);
    } catch (caught) {
      if (caught instanceof AdminClientError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not load that job.");
    } finally {
      setBusy("");
    }
  }

  async function runAction(path: string, label: string) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const body = await adminRequest<Record<string, unknown>>(path, { method: "POST" });
      if (label === "sweep") {
        const swept = typeof body.swept === "number" ? body.swept : 0;
        setNotice(swept === 0 ? "No held jobs were past their SLA." : `Swept ${swept.toString()} job${swept === 1 ? "" : "s"}.`);
      } else {
        const fleet = isRecord(body.fleet) ? body.fleet : null;
        const count = Array.isArray(fleet?.listings) ? fleet.listings.length : 0;
        setNotice(`Fleet bootstrap finished. ${count.toString()} first-party listings are bound.`);
      }
      await load(filter);
    } catch (caught) {
      if (caught instanceof AdminClientError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : "The operator action failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <ConsolePage
      eyebrow="Admin"
      title="Operator panel"
      lede="Sandbox view of accounts, the fleet, jobs, and reputation. Mock USDC only. This page does not settle mainnet payments."
    >
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Operator sections" className="flex flex-wrap gap-4 text-sm">
          {["overview", "accounts", "fleet", "jobs", "reputation", "ops"].map((id) => (
            <a key={id} href={`#${id}`} className="text-muted capitalize hover:text-paper">
              {id === "ops" ? "Ops" : id}
            </a>
          ))}
        </nav>
        <button type="button" className={ghostClass} onClick={onLock}>
          Lock panel
        </button>
      </div>
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      {notice ? <StatusLine tone="ok">{notice}</StatusLine> : null}
      {loading && !overview ? <StatusLine tone="muted">Loading the sandbox.</StatusLine> : null}

      <section id="overview" className="mt-8 scroll-mt-24">
        <h2 className="font-serif text-3xl text-paper">Overview</h2>
        {overview ? (
          <>
            <p className="mt-3 font-mono text-xs tracking-wide text-muted uppercase">
              {overview.health.product} · {overview.health.mode} · {overview.health.rail} {overview.health.asset}
              {overview.health.ok ? " · healthy" : ""}
            </p>
            <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Accounts" value={String(overview.counts.accounts)} hint={`${overview.counts.organizations.toString()} orgs`} />
              <Stat label="Agents" value={String(overview.counts.agents)} />
              <Stat label="Listings" value={String(overview.counts.listings)} />
              <Stat label="Locked jobs" value={String(overview.counts.jobs.locked)} />
              <Stat label="Released" value={String(overview.counts.jobs.released)} />
              <Stat label="Timed out" value={String(overview.counts.jobs.timedOut)} />
              <Stat label="Failed" value={String(overview.counts.jobs.failed)} />
              <Stat label="GMV locked" value={overview.gmv.lockedUsdc} />
              <Stat label="GMV released" value={overview.gmv.releasedUsdc} />
              <Stat label="Take-rate collected" value={overview.gmv.takeRateCollectedUsdc} />
            </dl>
          </>
        ) : null}
      </section>

      <section id="accounts" className="mt-14 scroll-mt-24">
        <h2 className="font-serif text-3xl text-paper">Accounts</h2>
        <p className="mt-2 text-sm text-muted">Emails, organization names, and treasury balances. Password hashes and API keys stay on the API.</p>
        <DataTable
          columns={["Email", "Organization", "Treasury", "Agents", "Created"]}
          rows={accounts.map((account) => [
            account.email ?? "—",
            account.organizationName,
            account.treasuryBalanceUsdc,
            String(account.agentCount),
            formatWhen(account.userCreatedAt ?? account.organizationCreatedAt),
          ])}
          empty="No organizations yet."
        />
      </section>

      <section id="fleet" className="mt-14 scroll-mt-24">
        <h2 className="font-serif text-3xl text-paper">Fleet and listings</h2>
        <DataTable
          columns={["Listing", "Party", "Autofill", "Seller", "Price", "SLA p95"]}
          rows={listings.map((listing) => [
            listing.name,
            listing.party === "first_party" ? "First-party" : "Third-party",
            listing.autofill ? "Yes" : "No",
            listing.sellerAgentName ?? listing.sellerAgentId ?? "Unbound",
            `${listing.priceUsdc} ${listing.pricingModel}`,
            `${listing.p95Ms.toString()} ms`,
          ])}
          empty="No listings published."
        />
      </section>

      <section id="jobs" className="mt-14 scroll-mt-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="font-serif text-3xl text-paper">Jobs</h2>
          <label className="text-sm text-muted">
            Status
            <select
              className={`${fieldClass} mt-2 min-w-40`}
              value={filter}
              onChange={(event) => {
                setDetail(null);
                setFilter(event.target.value as JobFilter);
              }}
            >
              {FILTERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 overflow-x-auto border border-line/15">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-panel-2 text-muted">
              <tr>
                {["Status", "Listing", "Buyer", "Seller", "Amount", "Created"].map((column) => (
                  <th key={column} scope="col" className="px-3 py-3 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-muted">
                    No jobs for this filter.
                  </td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id} className="border-t border-line/10">
                    <td className="px-3 py-3">
                      <button type="button" className="text-brass hover:text-brass-bright" onClick={() => void openJob(job.id)}>
                        {jobStatusLabel(job.status)}
                      </button>
                    </td>
                    <td className="px-3 py-3 text-paper">{job.listingName}</td>
                    <td className="px-3 py-3 text-paper">{job.buyerOrganizationName}</td>
                    <td className="px-3 py-3 text-paper">{job.sellerOrganizationName}</td>
                    <td className="px-3 py-3 font-mono text-xs text-paper">{job.amountUsdc}</td>
                    <td className="px-3 py-3 text-muted">{formatWhen(job.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {busy === "job" ? <p className="mt-3 text-sm text-muted">Loading job.</p> : null}
        {detail ? <JobDetail detail={detail} onClose={() => setDetail(null)} /> : null}
      </section>

      <section id="reputation" className="mt-14 scroll-mt-24">
        <h2 className="font-serif text-3xl text-paper">Reputation</h2>
        <h3 className="mt-6 text-sm tracking-wide text-muted uppercase">Top agents</h3>
        <DataTable
          columns={["Agent", "Organization", "Score", "Success", "Failures"]}
          rows={(reputation?.agents ?? []).map((agent) => [
            agent.agentName,
            agent.organizationName,
            agent.score,
            String(agent.successCount),
            String(agent.failureCount),
          ])}
          empty="No passport events yet."
        />
        <h3 className="mt-8 text-sm tracking-wide text-muted uppercase">Recent failures</h3>
        <DataTable
          columns={["When", "Agent", "Latency", "Source"]}
          rows={(reputation?.recentFailures ?? []).map((failure) => [
            formatWhen(failure.createdAt),
            failure.agentName,
            `${failure.latencyMs.toString()} ms`,
            failure.sourceRef ?? "—",
          ])}
          empty="No recent failures."
        />
      </section>

      <section id="ops" className="mt-14 scroll-mt-24">
        <h2 className="font-serif text-3xl text-paper">Ops</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Sandbox only. The SLA sweep refunds held jobs whose listing deadline has passed. Fleet bootstrap is idempotent and republishes the Roster Labs catalog.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== ""}
            onClick={() => void runAction("/v1/admin/jobs/expire", "sweep")}
          >
            {busy === "sweep" ? "Sweeping" : "Sweep SLA"}
          </button>
          <button
            type="button"
            className={ghostClass}
            disabled={busy !== ""}
            onClick={() => void runAction("/v1/admin/fleet/bootstrap", "fleet")}
          >
            {busy === "fleet" ? "Bootstrapping" : "Re-bootstrap fleet"}
          </button>
        </div>
      </section>
    </ConsolePage>
  );
}

function JobDetail({ detail, onClose }: { detail: AdminJobDetail; onClose: () => void }) {
  const errors = detail.escrow.validationErrors?.join("; ");
  return (
    <div className="mt-4 border border-line/15 bg-panel p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] tracking-[0.16em] text-brass uppercase">{detail.job.id}</p>
          <h3 className="mt-2 font-serif text-2xl text-paper">{detail.job.listingName}</h3>
        </div>
        <button type="button" className="text-sm text-muted hover:text-paper" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <Detail label="Job status" value={jobStatusLabel(detail.escrow.jobStatus)} />
        <Detail label="Escrow" value={detail.escrow.state} />
        <Detail label="Amount" value={detail.escrow.amountUsdc} />
        <Detail label="Take-rate quoted" value={detail.escrow.takeRateQuotedUsdc} />
        <Detail label="Take-rate collected" value={detail.escrow.takeRateCollectedUsdc} />
        <Detail label="Seller net" value={detail.escrow.sellerNetUsdc} />
        <Detail label="Settled" value={formatWhen(detail.escrow.settledAt)} />
        <Detail label="Hold" value={detail.escrow.holdAddress} />
      </dl>
      <p className="mt-4 text-sm text-muted">Result</p>
      <pre className="mt-2 overflow-x-auto bg-panel-2 p-3 font-mono text-xs text-paper">
        {JSON.stringify(detail.escrow.result, null, 2)}
      </pre>
      {errors ? <p className="mt-3 text-sm text-brass-bright">{errors}</p> : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-line/15 bg-panel px-4 py-4">
      <dt className="text-xs tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-2 font-mono text-lg text-paper">{value}</dd>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm break-all text-paper">{value}</dd>
    </div>
  );
}

function DataTable({ columns, rows, empty }: { columns: string[]; rows: string[][]; empty: string }) {
  return (
    <div className="mt-4 overflow-x-auto border border-line/15">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-panel-2 text-muted">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="px-3 py-3 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={`${row[0] ?? "row"}-${index.toString()}`} className="border-t border-line/10">
                {row.map((cell, cellIndex) => (
                  <td key={`${columns[cellIndex] ?? "col"}-${cellIndex.toString()}`} className="px-3 py-3 text-paper">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
