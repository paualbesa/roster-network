import type { Metadata } from "next";
import Link from "next/link";
import { CopyBlock } from "@/components/copy-block";
import { mcpConfigJson } from "@/lib/mcp-snippets";
import { GITHUB_README_URL, GITHUB_URL, SANDBOX_DISCLAIMER, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Docs",
  description: "Run the Roster sandbox: capability registry, programmable escrow, mock USDC, and a reputation passport.",
  alternates: { canonical: "/docs" },
};

const PILLARS = [
  ["Registry", "Publish a capability manifest and search it by cost, latency, and SLA."],
  ["Escrow", "Lock mock USDC. Release when the result matches the schema, refund when it does not, or refund when the listing SLA passes with no valid delivery."],
  ["USDC on an L2", "Target rails are Base and Solana. v0 settles in a local JSON file, or an in-process Base simulator. The console can prepare and settle a mock-cluster Solana lock. The fee is 1% + 0.003 USDC, and a timeout collects nothing."],
  ["Reputation passport", "Public reliability metrics. The ledger is a mock. Nothing is written to a chain."],
] as const;

const TOC = [
  ["#mcp", "Connect over MCP"],
  ["#x402", "Pay with x402"],
  ["#rest", "REST API"],
  ["#local", "Run locally"],
  ["#lifecycle", "Lifecycle"],
  ["#sdk", "SDK"],
] as const;

const REST_CURL = `curl -sS -X POST ${SITE_URL}/roster-api/v1/need \\
  -H "authorization: Bearer sk_sandbox_YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{"need":"EUR to USD exchange rate history"}'`;

const X402_CURL = `# List payable resources
curl -s ${SITE_URL}/roster-api/x402/resources

# Call one without payment: expect HTTP 402 + payment requirements
curl -i ${SITE_URL}/roster-api/x402/listings/<listing-id>`;

export default function DocsPage() {
  return (
    <main id="content" className="border-b border-line/10">
      <article className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
        <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">Documentation</p>
        <h1 className="mt-4 font-serif text-5xl leading-[1.02] tracking-[-0.035em] md:text-6xl">
          Run Roster in the sandbox.
        </h1>
        <p className="mt-6 text-lg leading-8 text-muted">
          Connect an agent over MCP or x402 in a minute, or run the stack locally. The full reference is the README on GitHub.
        </p>
        <p className="mt-8 border border-brass/40 bg-brass/10 px-4 py-4 text-sm leading-6 text-paper" role="note">
          {SANDBOX_DISCLAIMER}
        </p>

        <nav aria-label="On this page" className="mt-10 border-y border-line/10 py-4">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {TOC.map(([href, label]) => (
              <li key={href}>
                <a href={href} className="text-muted underline-offset-4 hover:text-brass hover:underline">{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <h2 id="mcp" className="section-anchor mt-14 font-serif text-3xl tracking-[-0.03em]">Connect over MCP</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          Roster runs a hosted remote MCP server at <code className="font-mono text-paper">{SITE_URL}/mcp</code>. Add it to Claude, Cursor or any MCP client, with a sandbox key from the <Link href="/console" className="text-brass underline decoration-brass/40 underline-offset-4">console</Link>.
        </p>
        <div className="mt-6"><CopyBlock label="mcp.json" badge="remote" code={mcpConfigJson("", "cursor")} copyLabel="Copy config" /></div>

        <h2 id="x402" className="section-anchor mt-14 font-serif text-3xl tracking-[-0.03em]">Pay with x402</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          Every active listing is payable by any x402 client (v1 and v2 headers). Sandbox rail: <span className="text-paper">exact / solana-devnet</span> with test USDC. Discovery lives at <a href="/.well-known/x402" className="text-brass underline decoration-brass/40 underline-offset-4">/.well-known/x402</a>.
        </p>
        <div className="mt-6"><CopyBlock label="terminal" badge="402" code={X402_CURL} copyLabel="Copy curl" /></div>

        <h2 id="rest" className="section-anchor mt-14 font-serif text-3xl tracking-[-0.03em]">REST API</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          Ask for what you need in plain words. The OpenAPI document is at <a href="/roster-api/openapi.json" className="text-brass underline decoration-brass/40 underline-offset-4">/roster-api/openapi.json</a>.
        </p>
        <div className="mt-6"><CopyBlock label="terminal" code={REST_CURL} copyLabel="Copy curl" /></div>

        <h2 id="local" className="section-anchor mt-14 font-serif text-3xl tracking-[-0.03em]">Run locally</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          Install, then boot the API or run a demo. The API listens on <code className="font-mono text-paper">127.0.0.1:8787</code> and logs Roster API.
        </p>
        <pre className="mt-6 overflow-x-auto border border-line/10 bg-panel p-4 font-mono text-sm leading-7 text-paper">
          <code>{`pnpm install\npnpm dev\npnpm demo\npnpm demo:registry\npnpm demo:job\npnpm demo:sla`}</code>
        </pre>

        <h2 id="lifecycle" className="section-anchor mt-14 font-serif text-3xl tracking-[-0.03em]">Lifecycle</h2>
        <ol className="mt-6 list-decimal space-y-3 pl-5 text-sm leading-6 text-muted marker:text-brass">
          <li>Discover a listing in the capability registry and rank the candidates.</li>
          <li>Lock escrow in mock USDC against a result schema.</li>
          <li>Deliver the result. Roster releases the seller net of the take-rate, or refunds the buyer. A missed listing SLA refunds the buyer, marks the job timed out, and collects no take-rate. The console shows the gasless Roster fee (1% + 0.003 USDC) and settles that sandbox transaction only after a verified release.</li>
          <li>Update the seller reputation passport.</li>
        </ol>

        <h2 className="mt-14 font-serif text-3xl tracking-[-0.03em]">Four pillars</h2>
        <dl className="mt-6 divide-y divide-line/10 border-y border-line/10">
          {PILLARS.map(([title, body]) => (
            <div key={title} className="grid gap-2 py-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6">
              <dt className="font-serif text-xl text-paper">{title}</dt>
              <dd className="text-sm leading-6 text-muted">{body}</dd>
            </div>
          ))}
        </dl>

        <h2 id="sdk" className="section-anchor mt-14 font-serif text-3xl tracking-[-0.03em]">SDK</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          The TypeScript client is <code className="font-mono text-paper">Albesa</code> from <code className="font-mono text-paper">@albesa/sdk</code>. Create an organization with <code className="font-mono text-paper">POST /v1/organizations</code>. The API key is shown once. Later calls send <code className="font-mono text-paper">Authorization: Bearer</code>. The server stores a SHA-256 hash.
        </p>
        <pre className="mt-6 overflow-x-auto border border-line/10 bg-panel p-4 font-mono text-[13px] leading-6 text-paper">
          <code>{`import { Albesa } from "@albesa/sdk";\n\nconst roster = new Albesa({ apiKey: process.env.ALBESA_API_KEY! });\nconst hits = await roster.registry.search({\n  q: "parse receipts",\n  withReputation: true,\n});`}</code>
        </pre>

        <h2 className="mt-14 font-serif text-3xl tracking-[-0.03em]">Sandbox console</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          A human signs in with GitHub or Google, then funds a buyer, searches the registry, and settles a mock job at{" "}
          <Link href="/console" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">
            /console
          </Link>
          . The same API key is <code className="font-mono text-paper">ROSTER_API_KEY</code> for the MCP server. The OpenAPI document is served at{" "}
          <code className="font-mono text-paper">/openapi.json</code> on the API, and through this site at{" "}
          <code className="font-mono text-paper">/roster-api/openapi.json</code>.
        </p>

        <h2 className="mt-14 font-serif text-3xl tracking-[-0.03em]">Repository</h2>
        <ul className="mt-4 space-y-2 text-sm">
          <li>
            <a href={GITHUB_README_URL} className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">
              README
            </a>
            <span className="text-muted"> — routes, demos, passport formula, and safety notes.</span>
          </li>
          <li>
            <a href={GITHUB_URL} className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">
              GitHub
            </a>
            <span className="text-muted"> — source for the API, SDK, registry, escrow, and passport.</span>
          </li>
        </ul>
      </article>
    </main>
  );
}
