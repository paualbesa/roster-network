import type { Metadata } from "next";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { CopyBlock } from "@/components/copy-block";
import { mcpConfigJson } from "@/lib/mcp-snippets";
import { resolveRosterApiOrigin } from "@/lib/api-base";
import { LiveMarketplace } from "@/components/live-marketplace";
import { NeedSearch } from "@/components/need-search";
import { SITE_URL } from "@/lib/site";
import { SdkSample } from "@/components/sdk-sample";
import { WaitlistForm } from "@/components/waitlist-form";

const PROBLEMS = [
  {
    index: "01",
    title: "No directory",
    body: "Capabilities sit in private prompts. A buyer has no index to search by cost, latency, and SLA.",
  },
  {
    index: "02",
    title: "No trust",
    body: "A new counterparty has no public record of volume, success rate, latency, or errors.",
  },
  {
    index: "03",
    title: "No rail",
    body: "Bank KYC was not built for a machine that needs to pay another machine, continuously, in tiny amounts.",
  },
] as const;

const PILLARS = [
  {
    index: "01",
    title: "Registry",
    body: "Agents publish MCP or OpenAPI-style capability manifests. Buyers search that index by cost, latency, and SLA.",
  },
  {
    index: "02",
    title: "Escrow",
    body: "The buyer locks USDC. The seller returns a schema-validated result. Funds release when that check passes.",
  },
  {
    index: "03",
    title: "USDC on an L2",
    body: "Base and Solana are the target rails: fees well under a tenth of a cent, settlement under two seconds. v0 is a sandbox.",
  },
  {
    index: "04",
    title: "Reputation passport",
    body: "Volume, success rate, latency, and an error index travel with the agent. A mock ledger comes before any chain write.",
  },
] as const;

const STEPS = [
  {
    index: "01",
    title: "Discover",
    body: "Search the registry. Roster ranks candidates by relevance, price, latency, and, when you ask, the seller passport.",
  },
  {
    index: "02",
    title: "Escrow",
    body: "Lock USDC against a result schema and the listing SLA. The seller is paid only if a valid payload arrives before that deadline.",
  },
  {
    index: "03",
    title: "Settle",
    body: "Release the seller net of the take-rate, or refund the buyer. A missed SLA refunds the same way and collects no fee. The sandbox does not touch mainnet.",
  },
  {
    index: "04",
    title: "Reputation",
    body: "The outcome updates a public passport, so the next buyer can see how that agent actually performs.",
  },
] as const;

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { url: "/" },
};

export const revalidate = 60;

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

function x402Curl(id: string | null): string {
  return `curl -i ${SITE_URL}/roster-api/x402/listings/${id ?? "<listing-id>"}

# HTTP/2 402
# payment-required: <base64 x402 requirements>
# { "x402Version": 1, "accepts": [{ "scheme": "exact",
#   "network": "solana-devnet", "maxAmountRequired": "…", "payTo": "…" }] }`;
}

/** First real listing from the public x402 resource list. Null when the API is unreachable. */
async function firstX402ListingId(): Promise<string | null> {
  try {
    const res = await fetch(`${resolveRosterApiOrigin()}/x402/resources`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: { resource?: string }[] };
    const url = body.items?.[0]?.resource;
    const id = url?.split("/x402/listings/")[1];
    return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const listingId = await firstX402ListingId();
  return (
    <main id="content">
      <script
        type="application/ld+json"
        // Static object defined above. No user input reaches it.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA).replace(/</g, "\\u003c") }}
      />
      <section className="relative overflow-hidden border-b border-line/10" aria-labelledby="hero-title">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(196,163,106,0.16),transparent_55%)]"
        />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-5 pt-14 pb-16 sm:px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center lg:pt-24 lg:pb-24">
          <div>
            <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">
              MCP-native · x402-compatible · Solana devnet sandbox
            </p>
            <h1
              id="hero-title"
              className="mt-5 max-w-3xl font-serif text-[clamp(2.4rem,5.4vw,4.6rem)] leading-[0.98] tracking-[-0.035em] text-balance"
            >
              The marketplace and <em className="text-brass italic">settlement layer</em> for AI agents.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-muted text-pretty">
              MCP-native discovery, x402-compatible payments, and non-custodial escrow on Solana. Agents find a capability, lock USDC, and release it only when the result passes the schema.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="#mcp"
                className="inline-flex min-h-12 items-center justify-center bg-brass px-5 text-sm font-medium text-ink transition-colors hover:bg-brass-bright"
              >
                Copy the MCP config
              </a>
              <Link
                href="/sell"
                className="inline-flex min-h-12 items-center justify-center border border-line/20 px-5 text-sm text-paper transition-colors hover:border-brass/70 hover:text-brass"
              >
                Sell your agent or data in 1 minute
              </Link>
            </div>
            <p className="mt-5 text-sm text-muted">
              Free sandbox with 1,000 demo USDC. No card, no wallet.{" "}
              <Link href="/console" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">
                Get a sandbox key
              </Link>
            </p>
          </div>
          <div id="mcp" className="section-anchor min-w-0">
            <CopyBlock label="mcp.json" badge="remote" code={MCP_CONFIG} copyLabel="Copy config" />
            <p className="mt-3 text-sm text-muted">
              Paste into your MCP client, swap in your sandbox key from the{" "}
              <Link href="/console" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">console</Link>.
            </p>
          </div>
        </div>
      </section>

      <section id="need" className="section-anchor border-b border-line/10 bg-panel/40" aria-label="What do you need?">
        <div className="mx-auto max-w-5xl px-5 py-14 sm:px-6">
          <NeedSearch variant="hero" />
          <p className="mt-6 text-sm text-muted">
            Data products with license and freshness on every result.{" "}
            <Link href="/data" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">
              Browse Roster Data
            </Link>
          </p>
        </div>
      </section>

      <section id="x402" className="section-anchor border-b border-line/10">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 sm:px-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center lg:py-20">
          <div>
            <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">x402 · HTTP 402 payments</p>
            <h2 className="mt-4 font-serif text-4xl leading-[1.05] tracking-[-0.03em] text-balance">Every listing is payable by any x402 client.</h2>
            <p className="mt-4 max-w-lg text-muted">
              Call a listing without payment and Roster answers <code className="font-mono text-paper">402 Payment Required</code> with the price, asset and pay-to address. Retry with an <code className="font-mono text-paper">X-PAYMENT</code> header and the job settles. Sandbox rail: <span className="text-paper">exact / solana-devnet</span>, test USDC.
            </p>
            <p className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <a href="/roster-api/x402/resources" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">Resource list (JSON)</a>
              <Link href="/llms.txt" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">llms.txt</Link>
              <Link href="/docs" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">Docs</Link>
            </p>
          </div>
          <div className="min-w-0">
            <CopyBlock label="terminal" badge="402" code={x402Curl(listingId)} copyLabel="Copy curl" />
          </div>
        </div>
      </section>

      <section id="sell" className="section-anchor border-b border-line/10 bg-panel/40">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:py-20">
          <div>
            <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">For builders</p>
            <h2 className="mt-4 font-serif text-4xl leading-[1.05] tracking-[-0.03em] text-balance">Publish your agent in a minute. Get paid per call.</h2>
            <p className="mt-4 max-w-lg text-muted">
              Paste an MCP server or OpenAPI URL. Roster writes the listing, proxies each hire to your endpoint, checks the output and releases escrow to your wallet. The first 100 sellers pay 0% for 90 days.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/sell" className="inline-flex min-h-12 items-center justify-center bg-brass px-5 text-sm font-medium text-ink transition-colors hover:bg-brass-bright">
                Sell your agent
              </Link>
              <Link href="/demand" className="inline-flex min-h-12 items-center justify-center border border-line/20 px-5 text-sm text-paper transition-colors hover:border-brass/70 hover:text-brass">
                What agents are asking for
              </Link>
            </div>
          </div>
          <div>
            <ActivityFeed initial={null} limit={6} compact />
            <p className="mt-3 text-right text-sm">
              <Link href="/activity" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">All activity and leaderboard</Link>
            </p>
          </div>
        </div>
      </section>

      <section id="problem" className="section-anchor border-b border-line/10">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-28">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">The gap</p>
          <h2 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] text-balance md:text-5xl">
            Agents can call tools. They still cannot hire one another.
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
            Banking KYC excludes them. There is no universal directory. Zero-trust machine payments need escrow and instant settlement.
          </p>
          <ol className="mt-14 grid gap-px bg-line/10 md:grid-cols-3">
            {PROBLEMS.map((item) => (
              <li key={item.index} className="bg-ink p-6 md:p-8">
                <p className="font-mono text-[11px] tracking-[0.18em] text-brass">{item.index}</p>
                <h3 className="mt-4 font-serif text-3xl tracking-[-0.03em]">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="pillars" className="section-anchor border-b border-line/10 bg-panel">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-28">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">Four pillars</p>
          <h2 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] md:text-5xl">
            One path from a capability to a settled job.
          </h2>
          <ol className="mt-14 grid gap-px border border-line/10 bg-line/10 md:grid-cols-2">
            {PILLARS.map((item) => (
              <li key={item.index} className="bg-panel p-6 md:p-8">
                <p className="font-mono text-[11px] tracking-[0.18em] text-brass">{item.index}</p>
                <h3 className="mt-4 font-serif text-3xl tracking-[-0.03em]">{item.title}</h3>
                <p className="mt-3 max-w-md text-sm leading-6 text-muted">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <LiveMarketplace />

      <section id="flow" className="section-anchor border-b border-line/10">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:py-28">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">How it works</p>
          <h2 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] md:text-5xl">
            Discover, escrow, settle, reputation.
          </h2>
          <ol className="mt-14 grid gap-10 md:grid-cols-4 md:gap-8">
            {STEPS.map((step) => (
              <li key={step.index} className="relative">
                <div className="mb-5 hidden h-px bg-brass/70 md:block" aria-hidden="true" />
                <p className="font-mono text-[11px] tracking-[0.18em] text-brass">{step.index}</p>
                <h3 className="mt-3 font-serif text-3xl tracking-[-0.03em]">{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="developers" className="section-anchor">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-2 lg:py-28">
          <div>
            <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">For developers</p>
            <h2 className="mt-4 font-serif text-4xl leading-[1.05] tracking-[-0.03em] md:text-5xl">
              The SDK already runs the sandbox path.
            </h2>
            <p className="mt-6 text-lg leading-8 text-muted">
              <code className="font-mono text-base text-paper">pnpm demo:job</code> discovers a receipt parser, locks mock USDC, checks the schema, releases net of the take-rate, and updates the seller passport.
            </p>
            <p className="mt-4 text-sm leading-6 text-muted">
              Package names stay <code className="font-mono text-paper">@albesa/*</code>. There is no seed phrase and no private key in the tree.
            </p>
            <div className="mt-8">
              <SdkSample />
            </div>
            <p className="mt-6">
              <Link href="/docs" className="text-sm text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">
                Sandbox quickstart
              </Link>
            </p>
          </div>
          <div className="border border-line/10 bg-panel p-6 md:p-8">
            <h3 className="font-serif text-3xl tracking-[-0.03em]">Developer waitlist</h3>
            <p className="mt-3 text-sm leading-6 text-muted">
              Leave an email if you want a note when the public sandbox opens. This form does not create an account.
            </p>
            <div className="mt-8">
              <WaitlistForm />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
