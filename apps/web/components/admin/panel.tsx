"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { StatusLine, buttonClass, fieldClass, ghostClass } from "@/components/console/ui";
import {
  adminRequest,
  jobStatusLabel,
  type AdminAccount,
  type AdminJob,
  type AdminJobDetail,
  type AdminListing,
  type AdminOverview,
  type AdminReputation,
  type AdminWaitlistEntry,
  type JobFilter,
  AdminClientError,
  formatUptime,
  waitlistCsv,
} from "@/lib/admin-client";
import {
  formatOperatorTime,
  formatPercent,
  formatUsdcDisplay,
  jobActivity,
  jobMatchesFilter,
  summarizeReputation,
} from "@/lib/admin-metrics";
import { ActivityChart, DataTable, MetricCard, Pill, ScoreBar, StatusMix, jobTone } from "./ui";

const FILTERS: { id: JobFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "locked", label: "Locked" },
  { id: "released", label: "Released" },
  { id: "timed_out", label: "Timed out" },
  { id: "failed", label: "Failed" },
];

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "accounts", label: "Accounts" },
  { id: "fleet", label: "Fleet" },
  { id: "jobs", label: "Jobs" },
  { id: "reputation", label: "Reputation" },
  { id: "waitlist", label: "Waitlist" },
  { id: "ops", label: "Ops" },
] as const;

const AUTO_REFRESH_MS = 30_000;

type SectionId = (typeof SECTIONS)[number]["id"];

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

  return (
    <div className="min-h-screen bg-ink">
      <OperatorHeader locked={phase !== "ready"} onLock={() => void lock()} />
      {phase === "checking" ? <Checking /> : null}
      {phase === "gate" ? (
        <Gate token={token} pending={pending} error={gateError} onToken={setToken} onSubmit={unlock} />
      ) : null}
      {phase === "ready" ? <Dashboard onUnauthorized={showGate} /> : null}
    </div>
  );
}

function OperatorHeader({ locked, onLock }: { locked: boolean; onLock: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-line/10 bg-ink/85 backdrop-blur-md">
      <div className="h-[3px] bg-brass" />
      <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-3 rounded-sm">
          <Mark />
          <span className="font-serif text-2xl tracking-[-0.03em] text-paper">Roster</span>
          <span className="hidden font-mono text-[11px] tracking-[0.16em] text-muted uppercase sm:inline">Operator</span>
        </Link>
        {locked ? (
          <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Sandbox</p>
        ) : (
          <button type="button" className={ghostClass} onClick={onLock}>
            Lock panel
          </button>
        )}
      </div>
    </header>
  );
}

function Checking() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <p className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">Admin</p>
      <h1 className="mt-3 font-serif text-4xl tracking-[-0.03em] text-paper">Operator panel</h1>
      <StatusLine tone="muted">Checking the operator session.</StatusLine>
    </div>
  );
}

function Gate({
  token,
  pending,
  error,
  onToken,
  onSubmit,
}: {
  token: string;
  pending: boolean;
  error: string;
  onToken: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <div className="relative mx-auto flex min-h-[calc(100vh-4.5rem)] max-w-lg flex-col justify-center px-4 py-16 sm:px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(ellipse_at_top,rgba(196,163,106,0.16),transparent_68%)]"
      />
      <div className="relative">
        <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">Admin</p>
        <h1 className="mt-4 font-serif text-4xl leading-[1.05] tracking-[-0.03em] text-paper md:text-5xl">Operator panel</h1>
        <p className="mt-4 text-base leading-7 text-muted">
          Sandbox supervision for Roster. Enter the operator token configured as ROSTER_ADMIN_TOKEN on the API. A console API key does not open this page.
        </p>
        <form onSubmit={onSubmit} className="mt-8 space-y-4 border border-line/15 bg-panel p-6">
          <label className="block text-sm text-paper" htmlFor="admin-token">
            Operator token
          </label>
          <input
            id="admin-token"
            name="token"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={(event) => onToken(event.target.value)}
            className={fieldClass}
            required
          />
          <button type="submit" className={buttonClass} disabled={pending}>
            {pending ? "Checking" : "Unlock"}
          </button>
          {error ? <StatusLine tone="error">{error}</StatusLine> : null}
        </form>
      </div>
    </div>
  );
}

function Dashboard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [listings, setListings] = useState<AdminListing[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [reputation, setReputation] = useState<AdminReputation | null>(null);
  const [waitlist, setWaitlist] = useState<AdminWaitlistEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [section, setSection] = useState<SectionId>("overview");
  const [detail, setDetail] = useState<AdminJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [nextOverview, nextAccounts, nextListings, nextJobs, nextReputation, nextWaitlist] = await Promise.all([
      adminRequest<AdminOverview>("/v1/admin/overview"),
      adminRequest<{ accounts: AdminAccount[] }>("/v1/admin/accounts"),
      adminRequest<{ listings: AdminListing[] }>("/v1/admin/listings"),
      adminRequest<{ jobs: AdminJob[] }>("/v1/admin/jobs"),
      adminRequest<AdminReputation>("/v1/admin/reputation"),
      // Older APIs have no waitlist route. Keep the rest of the panel working.
      adminRequest<{ entries: AdminWaitlistEntry[] }>("/v1/admin/waitlist").catch((caught: unknown) => {
        if (caught instanceof AdminClientError && caught.status === 401) throw caught;
        return { entries: [] as AdminWaitlistEntry[] };
      }),
    ]);
    setWaitlist(nextWaitlist.entries);
    setOverview(nextOverview);
    setAccounts(nextAccounts.accounts);
    setListings(nextListings.listings);
    setJobs(nextJobs.jobs);
    setReputation(nextReputation);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof AdminClientError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setError(caught instanceof Error ? caught.message : "Could not load the operator panel.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, onUnauthorized]);

  useEffect(() => {
    const apply = () => setSection(sectionFromHash(window.location.hash));
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load().catch((caught: unknown) => {
        if (caught instanceof AdminClientError && caught.status === 401) onUnauthorized();
      });
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load, onUnauthorized]);

  function selectSection(next: SectionId) {
    setSection(next);
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    window.history.replaceState(null, "", url);
  }

  async function refresh() {
    setRefreshing(true);
    setNotice("");
    try {
      await load();
    } catch (caught) {
      if (caught instanceof AdminClientError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not load the operator panel.");
    } finally {
      setRefreshing(false);
    }
  }

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
      await load();
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

  const openJobs = overview?.counts.jobs.locked ?? jobs.filter((job) => jobMatchesFilter(job.status, "locked")).length;
  const visibleJobs = jobs.filter((job) => jobMatchesFilter(job.status, filter));

  return (
    <div className="lg:grid lg:min-h-[calc(100vh-4.75rem)] lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <aside className="hidden border-r border-line/10 bg-panel lg:flex lg:flex-col">
        <div className="px-5 pt-7 pb-4">
          <p className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">Network</p>
          <p className="mt-2 font-serif text-2xl tracking-[-0.03em] text-paper">Operations</p>
        </div>
        <SectionNav section={section} openJobs={openJobs} variant="sidebar" onSelect={selectSection} />
        <p className="mt-auto border-t border-line/10 px-5 py-4 text-xs leading-5 text-muted">
          Cookie session. Locking clears it in this browser.
        </p>
      </aside>
      <div className="min-w-0">
        <div className="border-b border-line/10 bg-panel/80 lg:hidden">
          <SectionNav section={section} openJobs={openJobs} variant="bar" onSelect={selectSection} />
        </div>
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">Sandbox only. Mock USDC. This panel does not settle mainnet payments.</p>
            <div className="flex items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  className="size-4 accent-[#c4a36a]"
                  checked={autoRefresh}
                  onChange={(event) => setAutoRefresh(event.target.checked)}
                />
                Auto-refresh 30 s
              </label>
              <button type="button" className={ghostClass} onClick={() => void refresh()} disabled={refreshing || loading}>
                {refreshing ? "Refreshing" : "Refresh"}
              </button>
            </div>
          </div>
          {error ? (
            <div className="mb-4">
              <StatusLine tone="error">{error}</StatusLine>
            </div>
          ) : null}
          {notice ? (
            <div className="mb-4">
              <StatusLine tone="ok">{notice}</StatusLine>
            </div>
          ) : null}
          {loading && !overview ? <DashboardSkeleton /> : null}
          {overview ? (
            <SectionBody
              section={section}
              overview={overview}
              accounts={accounts}
              listings={listings}
              jobs={jobs}
              visibleJobs={visibleJobs}
              reputation={reputation}
              waitlist={waitlist}
              filter={filter}
              busy={busy}
              onFilter={(next) => {
                setDetail(null);
                setFilter(next);
              }}
              onOpenJob={(jobId) => void openJob(jobId)}
              onAction={(path, label) => void runAction(path, label)}
              onSection={selectSection}
            />
          ) : null}
        </div>
      </div>
      {detail ? <JobDetail detail={detail} onClose={() => setDetail(null)} /> : null}
      {busy === "job" ? <p className="sr-only">Loading job.</p> : null}
    </div>
  );
}

function SectionNav({
  section,
  openJobs,
  variant,
  onSelect,
}: {
  section: SectionId;
  openJobs: number;
  variant: "sidebar" | "bar";
  onSelect: (id: SectionId) => void;
}) {
  const bar = variant === "bar";
  return (
    <nav aria-label="Operator sections" className={bar ? "flex gap-2 overflow-x-auto px-4 py-3" : "flex flex-col px-3"}>
      {SECTIONS.map((item) => {
        const active = section === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(item.id)}
            className={
              bar
                ? `inline-flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm whitespace-nowrap ${active ? "bg-brass text-ink" : "border border-line/15 text-paper"}`
                : `flex min-h-11 items-center justify-between gap-3 px-3 text-left text-sm ${active ? "bg-brass/15 text-brass" : "text-muted hover:bg-panel-2 hover:text-paper"}`
            }
          >
            <span>{item.label}</span>
            {item.id === "jobs" && openJobs > 0 ? (
              <span className={`font-mono text-[11px] ${active && !bar ? "text-brass" : bar && active ? "text-ink" : "text-muted"}`}>
                {openJobs.toString()}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

function SectionBody({
  section,
  overview,
  accounts,
  listings,
  jobs,
  visibleJobs,
  reputation,
  waitlist,
  filter,
  busy,
  onFilter,
  onOpenJob,
  onAction,
  onSection,
}: {
  section: SectionId;
  overview: AdminOverview;
  accounts: AdminAccount[];
  listings: AdminListing[];
  jobs: AdminJob[];
  visibleJobs: AdminJob[];
  reputation: AdminReputation | null;
  waitlist: AdminWaitlistEntry[];
  filter: JobFilter;
  busy: string;
  onFilter: (filter: JobFilter) => void;
  onOpenJob: (jobId: string) => void;
  onAction: (path: string, label: string) => void;
  onSection: (id: SectionId) => void;
}) {
  if (section === "accounts") return <AccountsSection accounts={accounts} />;
  if (section === "fleet") return <FleetSection listings={listings} />;
  if (section === "jobs") {
    return <JobsSection jobs={jobs} visibleJobs={visibleJobs} filter={filter} onFilter={onFilter} onOpenJob={onOpenJob} />;
  }
  if (section === "reputation") return <ReputationSection reputation={reputation} />;
  if (section === "waitlist") return <WaitlistSection entries={waitlist} />;
  if (section === "ops") return <OpsSection overview={overview} busy={busy} onAction={onAction} />;
  return <OverviewSection overview={overview} jobs={jobs} reputation={reputation} onSection={onSection} />;
}

function OverviewSection({
  overview,
  jobs,
  reputation,
  onSection,
}: {
  overview: AdminOverview;
  jobs: AdminJob[];
  reputation: AdminReputation | null;
  onSection: (id: SectionId) => void;
}) {
  const online = onlineCount(overview);
  const suspended = Math.max(0, overview.counts.agents - online);
  const summary = summarizeReputation(reputation?.agents ?? []);
  const activity = jobActivity(jobs, new Date());
  const failures = reputation?.recentFailures.length ?? 0;
  return (
    <section aria-labelledby="overview-title">
      <SectionIntro
        id="overview-title"
        eyebrow={healthLabel(overview)}
        title="Operations"
        lede="Agents on the network, open work, locked escrow, settled volume, and passport health."
      />
      <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Agents online"
          value={online.toString()}
          hint={`${overview.counts.agents.toString()} registered · ${suspended.toString()} suspended`}
        />
        <MetricCard
          label="Open jobs"
          value={overview.counts.jobs.locked.toString()}
          hint={`${overview.counts.jobs.released.toString()} released · ${overview.counts.jobs.timedOut.toString()} timed out · ${overview.counts.jobs.failed.toString()} failed`}
        />
        <MetricCard
          label="Escrows locked"
          value={formatUsdcDisplay(overview.gmv.lockedUsdc)}
          unit="USDC"
          hint={`${overview.counts.jobs.locked.toString()} jobs still held`}
        />
        <MetricCard
          label="Volume"
          value={formatUsdcDisplay(overview.gmv.releasedUsdc)}
          unit="USDC"
          hint={`${formatUsdcDisplay(overview.gmv.takeRateCollectedUsdc)} take-rate collected`}
        />
        <MetricCard
          label="Reputation"
          value={summary.averageScore ?? "—"}
          hint={
            summary.passports === 0
              ? "No passport events yet"
              : `${formatPercent(summary.successRate)} success · ${summary.passports.toString()} passports`
          }
        />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MiniStat label="Accounts" value={overview.counts.accounts.toString()} hint={`${overview.counts.organizations.toString()} organizations`} />
        <MiniStat label="Listings" value={overview.counts.listings.toString()} hint="Published capabilities" />
        <MiniStat
          label="Waitlist"
          value={(overview.waitlist?.total ?? 0).toString()}
          hint={`+${(overview.waitlist?.last7d ?? 0).toString()} in the last 7 days`}
        />
        <MiniStat label="Rail" value={overview.health.rail} hint={`${overview.health.asset} · ${overview.health.mode}`} />
        <MiniStat
          label="Health"
          value={overview.health.ok ? "Healthy" : "Check"}
          hint={`${overview.health.version ? `API ${overview.health.version}` : overview.health.product} · up ${formatUptime(overview.health.uptimeS)}`}
        />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <ActivityChart points={activity} />
        <StatusMix
          parts={[
            { id: "locked", label: "Locked", value: overview.counts.jobs.locked, bar: "bg-brass" },
            { id: "released", label: "Released", value: overview.counts.jobs.released, bar: "bg-sage" },
            { id: "timed_out", label: "Timed out", value: overview.counts.jobs.timedOut, bar: "bg-muted" },
            { id: "failed", label: "Failed", value: overview.counts.jobs.failed, bar: "bg-brass-bright" },
          ]}
        />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Attention
          title={overview.counts.jobs.locked === 0 ? "No open jobs" : `${overview.counts.jobs.locked.toString()} open job${overview.counts.jobs.locked === 1 ? "" : "s"}`}
          body={overview.counts.jobs.locked === 0 ? "Nothing is sitting in escrow." : "Held jobs are waiting on a result or an SLA sweep."}
          action="View jobs"
          onClick={() => onSection("jobs")}
        />
        <Attention
          title={failures === 0 ? "No recent failures" : `${failures.toString()} recent failure${failures === 1 ? "" : "s"}`}
          body={failures === 0 ? "Passport failures will show up here." : "Latest seller outcomes that did not succeed."}
          action="View reputation"
          onClick={() => onSection("reputation")}
        />
      </div>
    </section>
  );
}

function AccountsSection({ accounts }: { accounts: AdminAccount[] }) {
  return (
    <section aria-labelledby="accounts-title">
      <SectionIntro
        id="accounts-title"
        eyebrow="Directory"
        title="Accounts"
        lede="Emails, organization names, and treasury balances. Password hashes and API keys stay on the API."
      />
      <div className="mt-8">
        <DataTable
          caption="Organizations"
          columns={["Email", "Organization", "Treasury", "Agents", "Created"]}
          rows={accounts.map((account) => ({
            key: account.organizationId,
            cells: [
              account.email ?? "—",
              account.organizationName,
              <Mono key="treasury">{formatUsdcDisplay(account.treasuryBalanceUsdc)}</Mono>,
              String(account.agentCount),
              <span key="created" className="text-muted">
                {formatOperatorTime(account.userCreatedAt ?? account.organizationCreatedAt)}
              </span>,
            ],
          }))}
          empty={{ title: "No organizations yet", body: "Accounts appear after the first sandbox signup or a fleet bootstrap." }}
        />
      </div>
    </section>
  );
}

function FleetSection({ listings }: { listings: AdminListing[] }) {
  return (
    <section aria-labelledby="fleet-title">
      <SectionIntro
        id="fleet-title"
        eyebrow="Catalog"
        title="Fleet and listings"
        lede="First-party Roster Labs listings and third-party capabilities bound to a seller."
      />
      <div className="mt-8">
        <DataTable
          caption="Listings"
          columns={["Listing", "Party", "Status", "Autofill", "Seller", "Price", "SLA"]}
          rows={listings.map((listing) => ({
            key: listing.id,
            cells: [
              listing.name,
              <Pill key="party" tone={listing.party === "first_party" ? "brass" : "muted"}>
                {listing.party === "first_party" ? "First-party" : "Third-party"}
              </Pill>,
              <Pill key="status" tone={listing.status === "active" ? "sage" : "muted"}>
                {listing.status === "active" ? "Active" : listing.status}
              </Pill>,
              <Pill key="fill" tone={listing.autofill ? "sage" : "muted"}>
                {listing.autofill ? "Autofill" : "Manual"}
              </Pill>,
              listing.sellerAgentName ?? listing.sellerAgentId ?? "Unbound",
              <Mono key="price">{`${formatUsdcDisplay(listing.priceUsdc)} ${listing.pricingModel}`}</Mono>,
              <span key="sla" className="text-muted">
                {`${listing.p95Ms.toString()} ms`}
              </span>,
            ],
          }))}
          empty={{ title: "No listings published", body: "Bootstrap the fleet from Ops to publish the Roster Labs catalog." }}
        />
      </div>
    </section>
  );
}

function JobsSection({
  jobs,
  visibleJobs,
  filter,
  onFilter,
  onOpenJob,
}: {
  jobs: AdminJob[];
  visibleJobs: AdminJob[];
  filter: JobFilter;
  onFilter: (filter: JobFilter) => void;
  onOpenJob: (jobId: string) => void;
}) {
  return (
    <section aria-labelledby="jobs-title">
      <SectionIntro id="jobs-title" eyebrow="Settlement" title="Jobs" lede="Every marketplace job. Open a row to read escrow, take-rate, and the result." />
      <div className="mt-6 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Job status">
        {FILTERS.map((item) => {
          const count = jobs.filter((job) => jobMatchesFilter(job.status, item.id)).length;
          const active = filter === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => onFilter(item.id)}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm ${active ? "bg-brass text-ink" : "border border-line/15 text-paper"}`}
            >
              {item.label}
              <span className={`font-mono text-[11px] ${active ? "text-ink" : "text-muted"}`}>{count.toString()}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-4">
        <DataTable
          caption="Jobs"
          columns={["Status", "Listing", "Buyer", "Seller", "Amount", "Created"]}
          rows={visibleJobs.map((job) => ({
            key: job.id,
            cells: [
              <button key="status" type="button" className="rounded-full" onClick={() => onOpenJob(job.id)} aria-label={`Open ${job.listingName}`}>
                <Pill tone={jobTone(job.status)}>{jobStatusLabel(job.status)}</Pill>
              </button>,
              job.listingName,
              job.buyerOrganizationName,
              job.sellerOrganizationName,
              <Mono key="amount">{formatUsdcDisplay(job.amountUsdc)}</Mono>,
              <span key="created" className="text-muted">
                {formatOperatorTime(job.createdAt)}
              </span>,
            ],
          }))}
          empty={{
            title: filter === "all" ? "No jobs yet" : "Nothing in this filter",
            body: filter === "all" ? "Jobs show up after a buyer hires a listing." : "Try another status, or refresh after the next hire.",
          }}
        />
      </div>
    </section>
  );
}

function ReputationSection({ reputation }: { reputation: AdminReputation | null }) {
  const agents = reputation?.agents ?? [];
  const failures = reputation?.recentFailures ?? [];
  const summary = summarizeReputation(agents);
  return (
    <section aria-labelledby="reputation-title">
      <SectionIntro
        id="reputation-title"
        eyebrow="Passports"
        title="Reputation"
        lede="Scores for agents that have passport events, then the newest failures."
      />
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        <MetricCard label="Average score" value={summary.averageScore ?? "—"} hint={`${summary.passports.toString()} agents with events`} />
        <MetricCard label="Success rate" value={formatPercent(summary.successRate)} hint={`${summary.successes.toString()} successes · ${summary.failures.toString()} failures`} />
        <MetricCard label="Recent failures" value={failures.length.toString()} hint="Newest 25 failure events" />
      </div>
      <h3 className="mt-10 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Top agents</h3>
      <div className="mt-3">
        <DataTable
          caption="Top agents"
          columns={["Agent", "Organization", "Score", "Success", "Failures"]}
          rows={agents.map((agent) => ({
            key: agent.agentId,
            cells: [
              agent.agentName,
              agent.organizationName,
              <ScoreBar key="score" score={agent.score} />,
              String(agent.successCount),
              agent.failureCount > 0 ? <Pill tone="alert">{String(agent.failureCount)}</Pill> : "0",
            ],
          }))}
          empty={{ title: "No passport events yet", body: "A released or refunded job writes the first seller score." }}
        />
      </div>
      <h3 className="mt-10 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Recent failures</h3>
      <div className="mt-3">
        <DataTable
          caption="Recent failures"
          columns={["When", "Agent", "Latency", "Source"]}
          rows={failures.map((failure) => ({
            key: failure.id,
            cells: [
              <span key="when" className="text-muted">
                {formatOperatorTime(failure.createdAt)}
              </span>,
              failure.agentName,
              <Mono key="latency">{`${failure.latencyMs.toString()} ms`}</Mono>,
              failure.sourceRef ?? "—",
            ],
          }))}
          empty={{ title: "No recent failures", body: "Timeouts and rejected deliveries land in this list." }}
        />
      </div>
    </section>
  );
}

function WaitlistSection({ entries }: { entries: AdminWaitlistEntry[] }) {
  const [copied, setCopied] = useState(false);
  async function copyEmails() {
    try {
      await navigator.clipboard.writeText(entries.map((entry) => entry.email).join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  function downloadCsv() {
    const blob = new Blob([waitlistCsv(entries)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `roster-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
  const bySource = new Map<string, number>();
  for (const entry of entries) bySource.set(entry.source ?? "unknown", (bySource.get(entry.source ?? "unknown") ?? 0) + 1);
  return (
    <section aria-labelledby="waitlist-title">
      <SectionIntro
        id="waitlist-title"
        eyebrow="Growth"
        title="Waitlist"
        lede="Developer and operator sign-ups from the landing page, newest first."
      />
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button type="button" className={ghostClass} onClick={() => void copyEmails()} disabled={entries.length === 0}>
          {copied ? "Copied" : "Copy emails"}
        </button>
        <button type="button" className={ghostClass} onClick={downloadCsv} disabled={entries.length === 0}>
          Download CSV
        </button>
        {[...bySource.entries()].map(([source, count]) => (
          <Pill key={source} tone="muted">
            {source} · {count.toString()}
          </Pill>
        ))}
      </div>
      <div className="mt-6">
        <DataTable
          caption="Waitlist"
          columns={["Email", "Source", "Joined"]}
          rows={entries.map((entry) => ({
            key: entry.email,
            cells: [
              entry.email,
              <span key="source" className="text-muted">{entry.source ?? "—"}</span>,
              <span key="joined" className="text-muted">{formatOperatorTime(entry.createdAt)}</span>,
            ],
          }))}
          empty={{ title: "No sign-ups yet", body: "Emails from the landing page waitlist show up here." }}
        />
      </div>
    </section>
  );
}

function OpsSection({
  overview,
  busy,
  onAction,
}: {
  overview: AdminOverview;
  busy: string;
  onAction: (path: string, label: string) => void;
}) {
  return (
    <section aria-labelledby="ops-title">
      <SectionIntro
        id="ops-title"
        eyebrow="Sandbox"
        title="Ops"
        lede="The API sweeps expired jobs every 15 seconds on its own. The manual sweep and fleet bootstrap stay here for operators. Both are idempotent."
      />
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        <MiniStat label="API version" value={overview.health.version ?? "—"} hint="Commit deployed on roster-api" />
        <MiniStat label="Uptime" value={formatUptime(overview.health.uptimeS)} hint="Since the last restart" />
        <MiniStat label="Mode" value={overview.health.mode} hint={`${overview.health.rail} rail · ${overview.health.asset}`} />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <article className="border border-line/10 bg-panel p-6">
          <h3 className="font-serif text-3xl tracking-[-0.03em] text-paper">Sweep SLA</h3>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted">
            Refund every held job past its deadline, across organizations. No take-rate. Jobs still inside the window stay locked.
          </p>
          <button type="button" className={`${buttonClass} mt-6`} disabled={busy !== ""} onClick={() => onAction("/v1/admin/jobs/expire", "sweep")}>
            {busy === "sweep" ? "Sweeping" : "Sweep SLA"}
          </button>
        </article>
        <article className="border border-line/10 bg-panel p-6">
          <h3 className="font-serif text-3xl tracking-[-0.03em] text-paper">Re-bootstrap fleet</h3>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted">
            Create Roster Labs if it is missing, then bind the first-party catalog again. Safe to run more than once.
          </p>
          <button
            type="button"
            className={`${ghostClass} mt-6`}
            disabled={busy !== ""}
            onClick={() => onAction("/v1/admin/fleet/bootstrap", "fleet")}
          >
            {busy === "fleet" ? "Bootstrapping" : "Re-bootstrap fleet"}
          </button>
        </article>
      </div>
    </section>
  );
}

function JobDetail({ detail, onClose }: { detail: AdminJobDetail; onClose: () => void }) {
  const errors = detail.escrow.validationErrors?.join("; ");
  return (
    <div className="fixed inset-0 z-50 flex bg-ink/75" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-detail-title"
        className="ml-auto flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-line/15 bg-panel p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] tracking-[0.16em] text-brass uppercase">{detail.job.id}</p>
            <h2 id="job-detail-title" className="mt-2 font-serif text-3xl tracking-[-0.03em] text-paper">
              {detail.job.listingName}
            </h2>
            <div className="mt-3">
              <Pill tone={jobTone(detail.escrow.jobStatus)}>{jobStatusLabel(detail.escrow.jobStatus)}</Pill>
            </div>
          </div>
          <button type="button" className="min-h-11 px-2 text-sm text-muted hover:text-paper" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          <Detail label="Escrow" value={detail.escrow.state} />
          <Detail label="Amount" value={`${formatUsdcDisplay(detail.escrow.amountUsdc)} USDC`} />
          <Detail label="Take-rate quoted" value={formatUsdcDisplay(detail.escrow.takeRateQuotedUsdc)} />
          <Detail label="Take-rate collected" value={formatUsdcDisplay(detail.escrow.takeRateCollectedUsdc)} />
          <Detail label="Seller net" value={formatUsdcDisplay(detail.escrow.sellerNetUsdc)} />
          <Detail label="Settled" value={formatOperatorTime(detail.escrow.settledAt)} />
          <Detail label="Hold" value={detail.escrow.holdAddress} />
        </dl>
        <p className="mt-6 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Result</p>
        <pre className="mt-2 max-h-64 overflow-auto bg-panel-2 p-3 font-mono text-xs text-paper">
          {JSON.stringify(detail.escrow.result, null, 2)}
        </pre>
        {errors ? <p className="mt-3 text-sm text-brass-bright">{errors}</p> : null}
      </div>
    </div>
  );
}

function SectionIntro({ id, eyebrow, title, lede }: { id: string; eyebrow: string; title: string; lede: string }) {
  return (
    <div>
      <p className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">{eyebrow}</p>
      <h1 id={id} className="mt-2 font-serif text-4xl tracking-[-0.03em] text-paper md:text-5xl">
        {title}
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{lede}</p>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="border border-line/10 bg-panel px-4 py-4">
      <p className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</p>
      <p className="mt-2 font-serif text-2xl tracking-[-0.03em] text-paper">{value}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

function Attention({ title, body, action, onClick }: { title: string; body: string; action: string; onClick: () => void }) {
  return (
    <div className="flex flex-col border border-line/10 bg-panel px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-serif text-2xl tracking-[-0.03em] text-paper">{title}</p>
        <p className="mt-1 text-sm text-muted">{body}</p>
      </div>
      <button type="button" className={`${ghostClass} mt-4 sm:mt-0`} onClick={onClick}>
        {action}
      </button>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm break-all text-paper">{value}</dd>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-paper">{children}</span>;
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-hidden="true">
      {["a", "b", "c", "d", "e"].map((id) => (
        <div key={id} className="h-36 animate-pulse border border-line/10 bg-panel motion-reduce:animate-none" />
      ))}
    </div>
  );
}

function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 28 28" className="size-7">
      <rect x="2" y="5" width="14" height="2" fill="#ece6da" />
      <rect x="2" y="12" width="20" height="2" fill="#ece6da" />
      <rect x="2" y="19" width="10" height="2" fill="#c4a36a" />
    </svg>
  );
}

function healthLabel(overview: AdminOverview): string {
  const health = overview.health.ok ? "healthy" : "degraded";
  return `${overview.health.product} · ${overview.health.mode} · ${health}`;
}

function onlineCount(overview: AdminOverview): number {
  return typeof overview.counts.agentsOnline === "number" ? overview.counts.agentsOnline : overview.counts.agents;
}

function sectionFromHash(hash: string): SectionId {
  const id = hash.replace(/^#/, "");
  return SECTIONS.some((section) => section.id === id) ? (id as SectionId) : "overview";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
