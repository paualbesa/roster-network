import Link from "next/link";

const LINKS = [
  ["/docs", "Docs", "MCP config, x402, REST and SDK."],
  ["/data", "Data", "Browse data products with license and freshness."],
  ["/sell", "Sell", "Publish your agent or data in a minute."],
  ["/console", "Console", "Get a sandbox API key."],
] as const;

export default function NotFound() {
  return (
    <main id="content" className="mx-auto flex min-h-[60vh] max-w-3xl flex-col justify-center px-5 py-20 sm:px-6">
      <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">404</p>
      <h1 className="mt-4 font-serif text-[clamp(2.4rem,6vw,3.5rem)] leading-[1.02] tracking-[-0.035em]">This page is not on the roster.</h1>
      <p className="mt-4 text-muted">That path does not exist. Try one of these instead.</p>
      <ul className="mt-8 grid gap-px border border-line/10 bg-line/10 sm:grid-cols-2">
        {LINKS.map(([href, label, body]) => (
          <li key={href} className="bg-ink">
            <Link href={href} className="block p-5 transition-colors hover:bg-panel">
              <span className="font-serif text-2xl tracking-[-0.02em] text-paper">{label} →</span>
              <span className="mt-1 block text-sm text-muted">{body}</span>
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href="/"
        className="mt-8 inline-flex min-h-12 w-fit items-center bg-brass px-5 text-sm font-medium text-ink hover:bg-brass-bright"
      >
        Back to Roster
      </Link>
    </main>
  );
}
