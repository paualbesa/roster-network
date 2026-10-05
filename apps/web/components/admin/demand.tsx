"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusLine, ghostClass } from "@/components/console/ui";
import {
  AdminClientError,
  adminRequest,
  demandCsv,
  type AdminDataCatalog,
  type AdminDataProduct,
  type AdminDemand,
} from "@/lib/admin-client";
import { formatOperatorTime } from "@/lib/admin-metrics";
import { DataTable, MetricCard, Pill, type PillTone } from "./ui";

function useAdminHandler(onUnauthorized: () => void, setError: (message: string) => void) {
  return useCallback(
    (caught: unknown, fallback: string) => {
      if (caught instanceof AdminClientError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : fallback);
    },
    [onUnauthorized, setError],
  );
}

/** "Demanda no coberta": needs agents asked for that Roster could not sell yet. */
export function DemandSection({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [demand, setDemand] = useState<AdminDemand | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const handle = useAdminHandler(onUnauthorized, setError);

  const load = useCallback(async () => {
    setDemand(await adminRequest<AdminDemand>("/v1/admin/demand"));
  }, []);

  useEffect(() => {
    void load().catch((caught: unknown) => handle(caught, "Could not load unmet demand."));
  }, [load, handle]);

  async function dismiss(id: string) {
    setBusy(id);
    setError("");
    try {
      await adminRequest(`/v1/admin/demand/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: "{}" });
      await load();
    } catch (caught) {
      handle(caught, "Could not dismiss that need.");
    } finally {
      setBusy("");
    }
  }

  function download() {
    if (!demand) return;
    const blob = new Blob([demandCsv(demand.entries)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "roster-unmet-demand.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const entries = demand?.entries ?? [];
  return (
    <section aria-labelledby="demand-title">
      <p className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">Product</p>
      <h1 id="demand-title" className="mt-2 font-serif text-4xl tracking-[-0.03em] text-paper md:text-5xl">
        Demanda no coberta
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
        What agents and visitors asked for through “What do you need?” that Roster could not answer well. Grouped by normalized text, most
        requested first. Build the top rows next.
      </p>
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        <MetricCard label="Distinct needs" value={(demand?.totals.entries ?? 0).toString()} hint="Unmatched or weak matches" />
        <MetricCard label="Requests" value={(demand?.totals.requests ?? 0).toString()} hint="Total times asked" />
        <MetricCard
          label="Top need"
          value={entries[0] ? `${entries[0].count.toString()}×` : "—"}
          hint={entries[0]?.need.slice(0, 60) ?? "Nothing logged yet"}
        />
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" className={ghostClass} onClick={() => void load().catch((caught: unknown) => handle(caught, "Reload failed."))}>
          Refresh
        </button>
        <button type="button" className={ghostClass} onClick={download} disabled={entries.length === 0}>
          Export CSV
        </button>
      </div>
      {error ? <div className="mt-4"><StatusLine tone="error">{error}</StatusLine></div> : null}
      <div className="mt-6">
        <DataTable
          caption="Unmet needs"
          columns={["Need", "Times", "Last seen", "Closest listing", "Score", "Budget", ""]}
          empty={{ title: "No unmet demand yet", body: "Every need so far matched a listing. New gaps show up here." }}
          rows={entries.map((entry) => ({
            key: entry.id,
            cells: [
              <span key="need" className="text-paper">{entry.need}</span>,
              <span key="count" className="font-mono">{entry.count.toString()}</span>,
              <span key="seen" className="font-mono text-xs">{formatOperatorTime(entry.lastSeenAt)}</span>,
              <span key="best" className="text-muted">{entry.bestListingName ?? "—"}</span>,
              <span key="score" className="font-mono">{entry.bestScore.toFixed(2)}</span>,
              <span key="budget" className="font-mono">{entry.budgetUsdc ?? "—"}</span>,
              <button key="dismiss" type="button" className="text-xs text-brass underline underline-offset-4 disabled:opacity-50" disabled={busy === entry.id} onClick={() => void dismiss(entry.id)}>
                Dismiss
              </button>,
            ],
          }))}
        />
      </div>
    </section>
  );
}

function statusTone(product: AdminDataProduct): PillTone {
  if (product.live || product.status === "ok") return "sage";
  if (product.status === "error") return "alert";
  if (product.status === "pending") return "brass";
  return "muted";
}

/** Data products: freshness, rows, last error, and a manual refresh. */
export function DataProductsSection({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [catalog, setCatalog] = useState<AdminDataCatalog | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const handle = useAdminHandler(onUnauthorized, setError);

  const load = useCallback(async () => {
    setCatalog(await adminRequest<AdminDataCatalog>("/v1/admin/data"));
  }, []);

  useEffect(() => {
    void load().catch((caught: unknown) => handle(caught, "Could not load data products."));
  }, [load, handle]);

  async function refresh(slug: string) {
    setBusy(slug);
    setError("");
    setNotice("");
    try {
      const response = await adminRequest<{ meta: { status: string; rowCount: number; lastError: string | null } }>(
        `/v1/admin/data/${encodeURIComponent(slug)}/refresh`,
        { method: "POST", body: "{}" },
      );
      setNotice(`${slug}: ${response.meta.status} · ${response.meta.rowCount.toString()} rows${response.meta.lastError ? ` · ${response.meta.lastError}` : ""}`);
      await load();
    } catch (caught) {
      handle(caught, "Refresh failed.");
    } finally {
      setBusy("");
    }
  }

  const products = catalog?.products ?? [];
  const healthy = products.filter((product) => product.live || product.status === "ok").length;
  const rows = products.reduce((sum, product) => sum + product.rowCount, 0);
  const failing = products.filter((product) => product.status === "error").length;
  return (
    <section aria-labelledby="data-title">
      <p className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">Supply</p>
      <h1 id="data-title" className="mt-2 font-serif text-4xl tracking-[-0.03em] text-paper md:text-5xl">Roster Data</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
        First-party data products collected from licensed public sources on a schedule. Store: {catalog?.store ?? "—"}.
      </p>
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        <MetricCard label="Healthy" value={`${healthy.toString()}/${products.length.toString()}`} hint="Fresh or live products" />
        <MetricCard label="Rows" value={rows.toLocaleString("en-US")} hint="Across stored products" />
        <MetricCard label="Failing" value={failing.toString()} hint="Last refresh errored; retried in 30 min" />
      </div>
      {error ? <div className="mt-4"><StatusLine tone="error">{error}</StatusLine></div> : null}
      {notice ? <div className="mt-4"><StatusLine tone="ok">{notice}</StatusLine></div> : null}
      <div className="mt-6">
        <DataTable
          caption="Data products"
          columns={["Product", "Kind", "Status", "Rows", "Last refresh", "Cadence", "Source · license", ""]}
          empty={{ title: "No data products", body: "The data catalog is disabled or still booting." }}
          rows={products.map((product) => ({
            key: product.slug,
            cells: [
              <span key="name" className="text-paper" title={product.name}>{product.slug}</span>,
              <span key="kind" className="font-mono text-xs">{product.kind}</span>,
              <span key="status" title={product.lastError ?? ""}><Pill tone={statusTone(product)}>{product.live ? "live" : product.status}</Pill></span>,
              <span key="rows" className="font-mono">{product.live ? "—" : product.rowCount.toLocaleString("en-US")}</span>,
              <span key="last" className="font-mono text-xs">{formatOperatorTime(product.lastRefreshedAt)}</span>,
              <span key="cadence" className="text-xs">{product.refreshCadence}</span>,
              <span key="source" className="text-xs text-muted">{product.source ?? "—"} · {product.license ?? "—"}</span>,
              product.live ? (
                <span key="refresh" />
              ) : (
                <button key="refresh" type="button" className="text-xs text-brass underline underline-offset-4 disabled:opacity-50" disabled={busy !== ""} onClick={() => void refresh(product.slug)}>
                  {busy === product.slug ? "Refreshing…" : "Refresh"}
                </button>
              ),
            ],
          }))}
        />
      </div>
    </section>
  );
}
