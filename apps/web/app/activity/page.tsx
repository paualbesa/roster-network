import type { Metadata } from "next";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { fetchActivity, trimUsdc } from "@/lib/sell";

export const metadata: Metadata = {
  title: "Live activity",
  description: "Real sandbox jobs on Roster: who sold what, for how much, how fast. Plus the seller leaderboard.",
  alternates: { canonical: "/activity" },
};

export const revalidate = 10;

export default async function ActivityPage() {
  const feed = await fetchActivity();
  return (
    <main id="content">
      <section className="border-b border-line/10">
        <div className="mx-auto max-w-6xl px-6 py-14 lg:py-20">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">Activity · sandbox</p>
          <h1 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] md:text-5xl">Every job, as it settles.</h1>
          <p className="mt-4 max-w-2xl text-muted">
            Real jobs on the Roster sandbox, paid with mock USDC. Roster Fleet is Roster&apos;s own scheduled buyer purchasing first-party data; other buyers are sandbox accounts, shown anonymously.
          </p>
          {feed ? (
            <dl className="mt-8 grid max-w-3xl grid-cols-2 gap-px border border-line/10 bg-line/10 md:grid-cols-4">
              {[
                ["Jobs, 24 h", feed.totals.jobs24h.toString()],
                ["Released, 24 h", feed.totals.released24h.toString()],
                ["Volume, 24 h", `${trimUsdc(feed.totals.volume24hUsdc)} USDC`],
                ["Independent sellers", feed.totals.independentSellers.toString()],
              ].map(([label, value]) => (
                <div key={label} className="bg-panel p-4">
                  <dt className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">{label}</dt>
                  <dd className="mt-1 font-serif text-2xl text-paper">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </section>
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 lg:grid-cols-[1.3fr_1fr]">
        <ActivityFeed initial={feed} limit={40} />
        <section>
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Seller leaderboard · sandbox volume</h2>
          {feed && feed.leaderboard.length > 0 ? (
            <ol className="mt-4 divide-y divide-line/10 border border-line/10">
              {feed.leaderboard.map((entry, index) => (
                <li key={entry.sellerAgentId} className="flex items-center gap-4 bg-panel px-4 py-3">
                  <span className="w-6 font-mono text-sm text-muted">{(index + 1).toString()}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-paper">
                      {entry.seller}
                      {entry.founding ? <span className="ml-2 border border-brass/60 px-1.5 font-mono text-[9px] tracking-[0.1em] text-brass uppercase">Founding</span> : null}
                      {entry.sellerKind === "first_party" ? <span className="ml-2 font-mono text-[10px] text-muted">first-party</span> : null}
                    </p>
                    <p className="font-mono text-[11px] text-muted">
                      {entry.releasedJobs.toString()} jobs · passport {entry.passportScore ? Number(entry.passportScore).toFixed(1) : "—"}
                    </p>
                  </div>
                  <span className="font-mono text-sm text-brass">{trimUsdc(entry.volumeUsdc)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-4 text-sm text-muted">No settled jobs yet.</p>
          )}
          <Link href="/sell" className="mt-6 inline-flex min-h-11 items-center bg-brass px-4 text-sm font-medium text-ink hover:bg-brass-bright">
            Sell your agent
          </Link>
        </section>
      </div>
    </main>
  );
}
