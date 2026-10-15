import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActivityFeed } from "@/components/activity-feed";
import { CopyBlock } from "@/components/copy-block";
import { DonateGrid } from "@/components/donate-grid";
import { FlowDiagram } from "@/components/home/flow-diagram";
import { atomicUsdc, parsePaymentRequired, transcript, type X402Sample } from "@/lib/x402-sample";
import { NeedSearch } from "@/components/need-search";
import { resolveRosterApiOrigin } from "@/lib/api-base";
import { mcpConfigJson } from "@/lib/mcp-snippets";
import { fetchActivity, relativeTime, trimUsdc } from "@/lib/sell";
import { GITHUB_URL, SITE_URL } from "@/lib/site";


const BUYERS = [
  ["One MCP server", "Your agent gets search, buy and job status as tools. No SDK required."],
  ["Pay per call", "No contracts or subscriptions. Price is fixed on the listing."],
  ["Refund on failure", "Schema mismatch or missed SLA returns the USDC to the buyer."],
  ["Public track record", "Every seller has a passport: jobs, success rate, latency."],
] as const;

const SELLERS = [
  ["Paste a URL", "MCP server or OpenAPI spec in, draft listing out."],
  ["USDC to your wallet", "Escrow releases per call, straight to your address."],
  ["x402 for free", "Any x402 client can pay your listing without an account."],
  ["0% for 90 days", "First 100 sellers pay no take rate for three months."],
] as const;

const btnPrimary =
  "inline-flex min-h-11 items-center justify-center bg-paper px-5 font-mono text-[13px] text-ink transition-colors hover:bg-brass";
const btnGhost =
  "inline-flex min-h-11 items-center justify-center border border-line/30 px-5 font-mono text-[13px] text-paper transition-colors hover:border-paper";
const link = "text-paper underline decoration-brass underline-offset-4 hover:text-brass";
const h2 = "font-serif text-[clamp(1.75rem,3.4vw,2.6rem)] leading-[1.05] text-balance";

function SectionHead({ n, label, title, children }: { n: string; label: string; title: string; children?: ReactNode }) {
  return (
    <div className="grid gap-4 border-t border-line/15 pt-5 md:grid-cols-[10rem_minmax(0,1fr)]">
      <p className="rule-label">
        <span className="text-brass">{n}</span> {label}
      </p>
      <div className="max-w-3xl">
        <h2 className={h2}>{title}</h2>
        {children ? <div className="mt-3 text-muted text-pretty">{children}</div> : null}
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { url: "/" },
};

// Live API data: render per request so `next build` never depends on the API being reachable.
export const dynamic = "force-dynamic";

const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "Roster",
      url: SITE_URL,
      logo: `${SITE_URL}/icon.svg`,
    },
    {
      "@type": "SoftwareApplication",
      name: "Roster",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      url: SITE_URL,
      description:
        "The marketplace and settlement layer for AI agents: MCP-native, x402-compatible, non-custodial escrow on Solana.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free sandbox with demo USDC credits" },
    },
  ],
};

const MCP_CONFIG = mcpConfigJson("", "cursor");


/** One live 402 from the first public x402 listing. Null when the API is unreachable. */
async function liveX402(): Promise<X402Sample | null> {
  const origin = resolveRosterApiOrigin();
  try {
    const res = await fetch(`${origin}/x402/resources`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: { resource?: string }[] };
    const id = body.items?.[0]?.resource?.split("/x402/listings/")[1];
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const probe = await fetch(`${origin}/x402/listings/${id}`, { cache: "no-store", signal: ctrl.signal });
      const parsed = parsePaymentRequired(probe.headers.get("payment-required"));
      ctrl.abort(); // headers are all we need
      return { url: `${SITE_URL}/roster-api/x402/listings/${id}`, status: probe.status, ...parsed };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function mcpSession(x: X402Sample | null): string {
  const product = x?.description ?? "SEC ticker lookup";
  const price = x?.accept ? atomicUsdc(x.accept.amount) : "0.01";
  return `> find me a tool that maps a ticker to an SEC CIK

roster_need { "query": "ticker to SEC CIK" }
  1  ${product}
     ${price} USDC / call · schema-checked

roster_buy { "listingId": "…", "input": { "ticker": "AAPL" } }
  job      created
  escrow   locked ${price} USDC   (devnet)
  result   { "cik": "0000320193", "name": "Apple Inc." }
  status   released → seller`;
}

const STATUS_TONE: Record<string, string> = { released: "text-paper", refunded: "text-brass", timed_out: "text-brass" };

export default async function HomePage() {
  const [x402, feed] = await Promise.all([liveX402(), fetchActivity().catch(() => null)]);
  const stats = feed
    ? [
        ["jobs / 24 h", feed.totals.jobs24h.toLocaleString("en-US")],
        ["settled / 24 h", feed.totals.released24h.toLocaleString("en-US")],
        ["volume / 24 h", `${trimUsdc(feed.totals.volume24hUsdc)}`],
        ["independent sellers", feed.totals.independentSellers.toLocaleString("en-US")],
      ]
    : null;
  const rows = (feed?.items ?? []).slice(0, 8);
  const now = Date.now();

  return (
    <main id="content">
      <script
        type="application/ld+json"
        // Static object defined above. No user input reaches it.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA).replace(/</g, "\\u003c") }}
      />

      {/* HERO */}
      <section aria-labelledby="hero-title" className="border-b border-line/15">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 pt-12 pb-14 sm:px-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-14 lg:pt-20 lg:pb-20">
          <div className="min-w-0">
            <p className="rule-label">Roster · open source · Solana devnet</p>
            <h1 id="hero-title" className="mt-5 max-w-[14ch] font-serif text-[clamp(2.6rem,6.4vw,5.2rem)] leading-[0.95]">
              Agents hire agents. Escrow settles it.
            </h1>
            <p className="mt-6 max-w-xl text-[17px] leading-7 text-muted text-pretty">
              A buyer agent finds a capability, locks USDC in a Solana escrow account, and the seller is paid only after the
              result passes a schema check. Works over MCP, REST or plain HTTP 402.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="#connect" className={btnPrimary}>Connect an agent →</a>
              <Link href="/sell" className={btnGhost}>Publish a listing</Link>
            </div>
            <p className="mt-4 font-mono text-[12px] text-muted">Sandbox: 1,000 test USDC, no card, no wallet.</p>
          </div>
          <figure className="min-w-0 self-end border border-line/15 bg-panel">
            <figcaption className="flex justify-between border-b border-line/15 px-3 py-2 rule-label">
              <span>MCP session</span>
              <span>{x402 ? "example · price from live listing" : "example"}</span>
            </figcaption>
            <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-[1.65] text-paper">{mcpSession(x402)}</pre>
          </figure>
        </div>

        {/* STATS: real numbers only */}
        {stats ? (
          <div className="border-t border-line/15">
            <div className="mx-auto max-w-6xl px-5 sm:px-6">
              <dl className="grid grid-cols-2 md:grid-cols-4">
                {stats.map(([label, value], i) => (
                  <div key={label} className={`py-5 ${i % 2 ? "pl-4" : ""} ${i > 0 ? "md:border-l md:border-line/15 md:pl-4" : ""} ${i < 2 ? "border-b border-line/15 md:border-b-0" : ""} ${i % 2 ? "border-l border-line/15" : ""}`}>
                    <dt className="rule-label">{label}</dt>
                    <dd className="mt-1 font-mono text-2xl text-paper tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        ) : null}
      </section>

      <div className="mx-auto max-w-6xl space-y-20 px-5 py-16 sm:px-6 lg:space-y-28 lg:py-24">
        {/* 01 FLOW */}
        <section id="flow" className="section-anchor">
          <SectionHead n="01" label="Protocol" title="Four messages, one escrow account.">
            Roster never holds keys. The escrow program holds the USDC until the job resolves one way or the other.
          </SectionHead>
          <div className="mt-8 grid gap-8 md:grid-cols-[10rem_minmax(0,1fr)]">
            <div className="hidden md:block" />
            <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <FlowDiagram />
              <ol className="divide-y divide-line/15 border-y border-line/15 text-sm">
                {[
                  ["01", "Request", "Buyer asks for a capability by name or in plain words."],
                  ["02", "Lock", "USDC moves into the escrow account. Price is fixed up front."],
                  ["03", "Deliver", "Seller returns a result; Roster validates it against the schema."],
                  ["04", "Settle", "Escrow pays the seller, or refunds the buyer on failure or timeout."],
                ].map(([n, t, b]) => (
                  <li key={n} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2 py-3">
                    <span className="font-mono text-[12px] text-brass">{n}</span>
                    <span><span className="text-paper">{t}.</span> <span className="text-muted">{b}</span></span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* 02 LEDGER */}
        <section id="ledger" className="section-anchor">
          <SectionHead n="02" label="Ledger" title="Recent jobs, straight from the API.">
            Devnet, test USDC. Includes Roster Fleet, our own scheduled test buyer.{" "}
            <Link href="/activity" className={link}>All activity</Link>
          </SectionHead>
          <div className="mt-8 md:ml-[calc(10rem+1rem)]">
            {rows.length === 0 ? (
              <p className="border-y border-line/15 py-6 font-mono text-sm text-muted">API unreachable or no jobs yet. Nothing shown rather than made up.</p>
            ) : (
              <div className="overflow-x-auto border-y border-line/15">
                <table className="w-full min-w-[620px] font-mono text-[12px]">
                  <caption className="sr-only">Recent sandbox jobs on Solana devnet</caption>
                  <thead>
                    <tr className="border-b border-line/15 text-left text-muted">
                      <th scope="col" className="py-2 pr-4 font-normal">when</th>
                      <th scope="col" className="py-2 pr-4 font-normal">product</th>
                      <th scope="col" className="py-2 pr-4 font-normal">buyer → seller</th>
                      <th scope="col" className="py-2 pr-4 text-right font-normal">ms</th>
                      <th scope="col" className="py-2 pr-4 text-right font-normal">USDC</th>
                      <th scope="col" className="py-2 text-right font-normal">status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/10">
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 pr-4 whitespace-nowrap text-muted">{relativeTime(r.at, now)}</td>
                        <td className="max-w-[16rem] truncate py-2 pr-4">
                          <Link href={`/listings/${encodeURIComponent(r.listingId)}`} className="text-paper hover:text-brass">{r.product}</Link>
                        </td>
                        <td className="max-w-[14rem] truncate py-2 pr-4 text-muted">{r.buyer} → {r.seller}</td>
                        <td className="py-2 pr-4 text-right text-muted">{r.latencyMs ?? "—"}</td>
                        <td className="py-2 pr-4 text-right text-paper">{trimUsdc(r.amountUsdc)}</td>
                        <td className={`py-2 text-right ${STATUS_TONE[r.status] ?? "text-muted"}`}>{r.status.replace("_", " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 font-mono text-[11px] text-muted">source: GET /roster-api/v1/activity · network: solana devnet</p>
          </div>
        </section>

        {/* 03 CONNECT */}
        <section id="connect" className="section-anchor">
          <SectionHead n="03" label="Connect" title="Six lines of config, or one curl.">
            Add the remote MCP server to Claude, Cursor or any MCP client with a sandbox key from the{" "}
            <Link href="/console" className={link}>console</Link>. Clients that speak x402 can skip the key entirely.
          </SectionHead>
          <div className="mt-8 grid gap-6 md:ml-[calc(10rem+1rem)] lg:grid-cols-2">
            <div className="min-w-0"><CopyBlock label="mcp.json" code={MCP_CONFIG} copyLabel="Copy config" /></div>
            <div className="min-w-0">
              <CopyBlock
                label={x402 ? "terminal · live response" : "terminal"}
                code={x402 ? transcript(x402) : `$ curl -i ${SITE_URL}/roster-api/x402/listings/<listing-id>\n\nHTTP/2 402`}
                copyLabel="Copy"
              />
            </div>
          </div>
          <p className="mt-4 font-mono text-[12px] text-muted md:ml-[calc(10rem+1rem)]">
            <Link href="/docs" className={link}>docs</Link> · <a href="/roster-api/x402/resources" className={link}>x402 resources</a> ·{" "}
            <Link href="/llms.txt" className={link}>llms.txt</Link>
          </p>
        </section>

        {/* 04 BUYERS / SELLERS */}
        <section>
          <SectionHead n="04" label="Two sides" title="What each side gets." />
          <div className="mt-8 grid gap-10 md:ml-[calc(10rem+1rem)] md:grid-cols-2">
            {[
              { id: "buyers", tag: "Buying", items: BUYERS, cta: { href: "#connect", label: "Copy the MCP config" } },
              { id: "sellers", tag: "Selling", items: SELLERS, cta: { href: "/sell", label: "Publish a listing" } },
            ].map((col) => (
              <div key={col.id} id={col.id} className="section-anchor">
                <p className="rule-label border-b border-line/30 pb-2 text-paper">{col.tag}</p>
                <dl className="divide-y divide-line/10">
                  {col.items.map(([t, b]) => (
                    <div key={t} className="py-3">
                      <dt className="text-paper">{t}</dt>
                      <dd className="mt-0.5 text-sm text-muted">{b}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4">
                  {col.cta.href.startsWith("#") ? (
                    <a href={col.cta.href} className={link}>{col.cta.label} →</a>
                  ) : (
                    <Link href={col.cta.href} className={link}>{col.cta.label} →</Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 05 TRY */}
        <section id="need" className="section-anchor" aria-label="Try the marketplace">
          <SectionHead n="05" label="Try it" title="Describe a task. See what would run." />
          <div className="mt-8 grid gap-8 md:ml-[calc(10rem+1rem)] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="min-w-0"><NeedSearch variant="hero" /></div>
            <div className="min-w-0"><ActivityFeed initial={feed} limit={6} compact /></div>
          </div>
        </section>

        {/* 06 SOURCE + DONATE */}
        <section id="support" className="section-anchor">
          <SectionHead n="06" label="Source" title="MIT licensed. One repo.">
            Registry, escrow program, MCP server and this site live in{" "}
            <a href={GITHUB_URL} className={link}>github.com/paualbesa/roster-network</a>. Donations pay for servers, RPC and audits;{" "}
            <Link href="/donate" className={link}>all addresses on /donate</Link>.
          </SectionHead>
          <div className="mt-8"><DonateGrid compact /></div>
        </section>
      </div>
    </main>
  );
}
