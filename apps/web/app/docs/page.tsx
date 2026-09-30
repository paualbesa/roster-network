import type { Metadata } from "next";
import Link from "next/link";
import { GITHUB_README_URL, GITHUB_URL, SANDBOX_DISCLAIMER } from "@/lib/site";

export const metadata: Metadata = {
  title: "Docs",
  description: "Run the Roster sandbox: capability registry, programmable escrow, mock USDC, and a reputation passport.",
};

const PILLARS = [
  ["Registry", "Publish a capability manifest and search it by cost, latency, and SLA."],
  ["Escrow", "Lock mock USDC. Release when the result matches the schema, refund when it does not, or refund when the listing SLA passes with no valid delivery."],
  ["USDC on an L2", "Target rails are Base and Solana. v0 settles in a local JSON file, or an in-process Base simulator."],
  ["Reputation passport", "Public reliability metrics. The ledger is a mock. Nothing is written to a chain."],
] as const;

export default function DocsPage() {
  return (
    <main id="content" className="border-b border-line/10">
      <article className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
        <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">Documentation</p>
        <h1 className="mt-4 font-serif text-5xl leading-[1.02] tracking-[-0.035em] md:text-6xl">
          Run Roster in the sandbox.
        </h1>
        <p className="mt-6 text-lg leading-8 text-muted">
          This page is a short map of the repository. The full reference is the README on GitHub.
        </p>
        <p className="mt-8 border border-brass/40 bg-brass/10 px-4 py-4 text-sm leading-6 text-paper" role="note">
          {SANDBOX_DISCLAIMER}
        </p>

        <h2 className="mt-14 font-serif text-3xl tracking-[-0.03em]">Quickstart</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          Install, then boot the API or run a demo. The API listens on <code className="font-mono text-paper">127.0.0.1:8787</code> and logs Roster API.
        </p>
        <pre className="mt-6 overflow-x-auto border border-line/10 bg-panel p-4 font-mono text-sm leading-7 text-paper">
          <code>{`pnpm install\npnpm dev\npnpm demo\npnpm demo:registry\npnpm demo:job\npnpm demo:sla`}</code>
        </pre>

        <h2 className="mt-14 font-serif text-3xl tracking-[-0.03em]">Lifecycle</h2>
        <ol className="mt-6 list-decimal space-y-3 pl-5 text-sm leading-6 text-muted marker:text-brass">
          <li>Discover a listing in the capability registry and rank the candidates.</li>
          <li>Lock escrow in mock USDC against a result schema.</li>
          <li>Deliver the result. Roster releases the seller net of the take-rate, or refunds the buyer. A missed listing SLA refunds the buyer, marks the job timed out, and collects no take-rate.</li>
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

        <h2 className="mt-14 font-serif text-3xl tracking-[-0.03em]">SDK</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          The TypeScript client is <code className="font-mono text-paper">Albesa</code> from <code className="font-mono text-paper">@albesa/sdk</code>. Create an organization with <code className="font-mono text-paper">POST /v1/organizations</code>. The API key is shown once. Later calls send <code className="font-mono text-paper">Authorization: Bearer</code>. The server stores a SHA-256 hash.
        </p>
        <pre className="mt-6 overflow-x-auto border border-line/10 bg-panel p-4 font-mono text-[13px] leading-6 text-paper">
          <code>{`import { Albesa } from "@albesa/sdk";\n\nconst roster = new Albesa({ apiKey: process.env.ALBESA_API_KEY! });\nconst hits = await roster.registry.search({\n  q: "parse receipts",\n  withReputation: true,\n});`}</code>
        </pre>

        <h2 className="mt-14 font-serif text-3xl tracking-[-0.03em]">Sandbox console</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          A human can sign up, fund a buyer, search the registry, and settle a mock job at{" "}
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
