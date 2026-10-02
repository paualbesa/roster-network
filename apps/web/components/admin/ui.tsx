import type { ReactNode } from "react";
import { jobStatusLabel } from "@/lib/admin-client";
import { weekdayLabel, type ActivityPoint } from "@/lib/admin-metrics";

export type PillTone = "brass" | "sage" | "muted" | "alert";

const PILL: Record<PillTone, string> = {
  brass: "bg-brass/15 text-brass",
  sage: "bg-sage/15 text-sage",
  muted: "bg-line/10 text-muted",
  alert: "bg-brass-bright/15 text-brass-bright",
};

export function jobTone(status: string): PillTone {
  const label = jobStatusLabel(status);
  if (label === "Released") return "sage";
  if (label === "Locked") return "brass";
  if (label === "Failed") return "alert";
  return "muted";
}

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[11px] tracking-wide uppercase ${PILL[tone]}`}>
      {children}
    </span>
  );
}

export function MetricCard({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint: string }) {
  return (
    <article className="relative flex min-h-[9.5rem] flex-col border border-line/10 bg-panel px-5 py-5">
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-brass/80" />
      <h3 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">{label}</h3>
      <p className="mt-3 font-serif text-[2.4rem] leading-none tracking-[-0.03em] text-paper">
        {value}
        {unit ? <span className="ml-2 font-mono text-xs tracking-[0.12em] text-muted uppercase">{unit}</span> : null}
      </p>
      <p className="mt-3 text-sm leading-5 text-muted">{hint}</p>
    </article>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-dashed border-line/20 bg-panel/50 px-6 py-14 text-center">
      <p className="font-serif text-2xl tracking-[-0.03em] text-paper">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{body}</p>
    </div>
  );
}

export function DataTable({
  caption,
  columns,
  rows,
  empty,
}: {
  caption: string;
  columns: string[];
  rows: { key: string; cells: ReactNode[] }[];
  empty: { title: string; body: string };
}) {
  if (rows.length === 0) return <EmptyState title={empty.title} body={empty.body} />;
  return (
    <div className="overflow-x-auto border border-line/10 bg-panel">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-panel-2 text-muted">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="px-4 py-3 font-mono text-[11px] font-medium tracking-[0.14em] uppercase">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-line/10">
              {row.cells.map((cell, index) => (
                <td key={`${row.key}-${columns[index] ?? index.toString()}`} className="px-4 py-3.5 align-middle text-paper">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ActivityChart({ points }: { points: ActivityPoint[] }) {
  const max = Math.max(...points.map((point) => point.jobs), 1);
  const total = points.reduce((sum, point) => sum + point.jobs, 0);
  const label = points.map((point) => `${weekdayLabel(point.day)} ${point.jobs.toString()} jobs`).join(", ");
  return (
    <figure className="border border-line/10 bg-panel p-5">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Jobs, last 7 days</span>
        <span className="font-mono text-xs text-paper">{total.toString()} total</span>
      </figcaption>
      <div className="mt-5 flex h-28 items-end gap-2" role="img" aria-label={label}>
        {points.map((point) => {
          const height = point.jobs === 0 ? 4 : Math.max(12, Math.round((point.jobs / max) * 96));
          return (
            <div key={point.day} className="flex min-w-0 flex-1 flex-col items-center gap-2">
              <div className="flex h-24 w-full items-end">
                <div
                  className={point.jobs === 0 ? "w-full bg-line/10" : "w-full bg-brass/80"}
                  style={{ height }}
                />
              </div>
              <span className="font-mono text-[10px] tracking-wide text-muted uppercase">{weekdayLabel(point.day)}</span>
            </div>
          );
        })}
      </div>
      {total === 0 ? <p className="mt-4 text-sm text-muted">No jobs in this window yet.</p> : null}
    </figure>
  );
}

export function StatusMix({
  parts,
}: {
  parts: { id: string; label: string; value: number; bar: string }[];
}) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const label = parts.map((part) => `${part.label} ${part.value.toString()}`).join(", ");
  return (
    <figure className="border border-line/10 bg-panel p-5">
      <figcaption className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Job mix</figcaption>
      <div className="mt-5 flex h-2 overflow-hidden bg-panel-2" role="img" aria-label={total === 0 ? "No jobs yet" : label}>
        {total === 0 ? (
          <div className="h-full w-full bg-line/10" />
        ) : (
          parts.map((part) =>
            part.value === 0 ? null : (
              <div key={part.id} className={part.bar} style={{ width: `${((part.value / total) * 100).toString()}%` }} />
            ),
          )
        )}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-2 text-sm">
        {parts.map((part) => (
          <li key={part.id} className="flex items-center justify-between gap-3 text-muted">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className={`size-2 ${part.bar}`} />
              {part.label}
            </span>
            <span className="font-mono text-xs text-paper">{part.value.toString()}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function ScoreBar({ score }: { score: string }) {
  const value = Number(score);
  const width = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <span className="inline-flex min-w-28 items-center gap-2">
      <span className="h-1.5 w-16 bg-panel-2" aria-hidden="true">
        <span className="block h-full bg-sage" style={{ width: `${width.toString()}%` }} />
      </span>
      <span className="font-mono text-xs text-paper">{score}</span>
    </span>
  );
}
