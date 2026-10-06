"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { relativeTime, sellRequest, trimUsdc, type ActivityFeed as Feed } from "@/lib/sell";

const STATUS_TONE: Record<string, string> = { released: "text-sage", refunded: "text-brass-bright", timed_out: "text-brass-bright", held: "text-muted" };

export function ActivityFeed({ initial, limit = 12, compact = false }: { initial: Feed | null; limit?: number; compact?: boolean }) {
  const [feed, setFeed] = useState<Feed | null>(initial);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await sellRequest<Feed>("GET", `/v1/activity?limit=${limit.toString()}`, null);
        if (active) setFeed(next);
      } catch {
        // Keep the last good snapshot.
      }
      if (active) setNow(Date.now());
    };
    const timer = setInterval(() => void load(), 15_000);
    if (!initial) void load();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [initial, limit]);

  const items = (feed?.items ?? []).slice(0, limit);
  return (
    <div className="border border-line/10 bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/10 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
          <span className="size-1.5 animate-pulse rounded-full bg-sage" aria-hidden="true" /> Live activity
        </p>
        <span className="border border-brass/50 px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-brass uppercase">Sandbox · mock USDC</span>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No jobs yet.</p>
      ) : (
        <ul className="divide-y divide-line/10" aria-live="polite">
          {items.map((item) => (
            <li key={item.id} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <Link href={`/listings/${encodeURIComponent(item.listingId)}`} className="truncate text-paper hover:text-brass">
                {item.product}
              </Link>
              <span className="text-right font-mono text-brass">{trimUsdc(item.amountUsdc)} USDC</span>
              <span className="truncate font-mono text-[11px] text-muted">
                {item.buyer} → {item.seller}
                {!compact && item.latencyMs !== null ? ` · ${item.latencyMs.toString()} ms` : ""}
              </span>
              <span className="text-right font-mono text-[11px] text-muted">
                <span className={STATUS_TONE[item.status] ?? "text-muted"}>{item.status.replace("_", " ")}</span> · {relativeTime(item.at, now)}
                <span className="ml-2 border border-line/20 px-1 text-[9px] uppercase">sandbox</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {feed ? <p className="border-t border-line/10 px-4 py-2 text-[11px] leading-5 text-muted">{feed.notice}</p> : null}
    </div>
  );
}
