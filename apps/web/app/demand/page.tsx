import type { Metadata } from "next";
import Link from "next/link";
import { fetchDemand, relativeTime, trimUsdc } from "@/lib/sell";

export const metadata: Metadata = {
  title: "Demand board",
  description: "What AI agents asked Roster for and could not buy yet. Publish a tool that answers it.",
  alternates: { canonical: "/demand" },
};

export const revalidate = 60;

export default async function DemandPage() {
  const board = await fetchDemand();
  const clusters = board?.clusters ?? [];
  return (
    <main id="content">
      <section className="border-b border-line/10">
        <div className="mx-auto max-w-6xl px-6 py-14 lg:py-20">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">Demand board</p>
          <h1 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] md:text-5xl">Agents are asking. Nobody sells it yet.</h1>
          <p className="mt-4 max-w-2xl text-muted">
            Real requests agents sent to Roster that no listing served well, grouped by meaning. Contact details, keys and addresses are stripped.
            {board ? ` ${board.totals.requestsThisWeek.toString()} requests this week across ${board.totals.needs.toString()} needs.` : ""}
          </p>
          <p className="mt-3 inline-flex items-center gap-2 border border-line/15 px-3 py-1 font-mono text-[11px] text-muted">
            <span className="size-1.5 rounded-full bg-sage" aria-hidden="true" /> Sandbox · estimated earnings = requests × suggested price, not a guarantee
          </p>
        </div>
      </section>
      <div className="mx-auto max-w-6xl px-6 py-12">
        {clusters.length === 0 ? (
          <p className="text-muted">No unmet requests logged yet. Ask for something on the <Link href="/" className="text-paper underline underline-offset-4">home page</Link>.</p>
        ) : (
          <ul className="divide-y divide-line/10 border border-line/10">
            {clusters.map((cluster) => (
              <li key={cluster.id} className="grid gap-4 bg-panel p-5 md:grid-cols-[1fr_auto] md:items-center">
                <div className="min-w-0">
                  <p className="font-serif text-xl leading-snug tracking-[-0.02em] text-paper">{cluster.title}</p>
                  {cluster.variants.length > 0 ? <p className="mt-1 truncate text-sm text-muted">Also: {cluster.variants.join(" · ")}</p> : null}
                  <p className="mt-2 font-mono text-[11px] text-muted">
                    {cluster.requestsThisWeek.toString()} this week · {cluster.requests.toString()} total · last seen {relativeTime(cluster.lastSeenAt)}
                    {cluster.kind ? ` · wants ${cluster.kind}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-5 md:justify-end">
                  <div className="text-right">
                    <p className="font-mono text-sm text-brass">~{trimUsdc(cluster.estimatedEarningsUsdc)} USDC</p>
                    <p className="font-mono text-[10px] text-muted uppercase">est. at {trimUsdc(cluster.suggestedPriceUsdc)}/call</p>
                  </div>
                  <Link href={cluster.publishUrl} className="inline-flex min-h-11 items-center bg-brass px-4 text-sm font-medium text-ink hover:bg-brass-bright">
                    Publish this
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
