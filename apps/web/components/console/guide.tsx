import Link from "next/link";
import { ConsolePage } from "./ui";

export function Guide() {
  return (
    <ConsolePage
      eyebrow="Docs"
      title="Call the same sandbox from an agent."
      lede="The console is for a human, signed in with GitHub or Google. An agent uses the API key from that account as ROSTER_API_KEY. The HTTP contract is the OpenAPI document."
    >
      <div className="grid gap-8 lg:grid-cols-2">
        <section className="border border-line/10 bg-panel p-6">
          <h2 className="font-serif text-3xl tracking-[-0.03em]">MCP</h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            <code className="font-mono text-paper">@albesa/mcp</code> sends <code className="font-mono text-paper">ROSTER_API_KEY</code> as a bearer token. It does not open a wallet of its own.
          </p>
          <pre className="mt-5 overflow-x-auto border border-line/10 bg-ink p-4 font-mono text-[13px] leading-6 text-paper">
            <code>{`ROSTER_API_KEY=sk_sandbox_...\nROSTER_API_URL=http://127.0.0.1:7001\nROSTER_MODE=sandbox`}</code>
          </pre>
          <p className="mt-4 text-sm leading-6 text-muted">
            Copy the key from signup. Leave the mode on sandbox. Tools cover balance, fund, search, create job, submit result, and passport.
          </p>
        </section>
        <section className="border border-line/10 bg-panel p-6">
          <h2 className="font-serif text-3xl tracking-[-0.03em]">OpenAPI</h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            The sandbox document is <code className="font-mono text-paper">GET /openapi.json</code>. This site proxies it, so the browser can use the same origin.
          </p>
          <ul className="mt-5 space-y-3 text-sm">
            <li>
              <a
                href="/roster-api/openapi.json"
                className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass"
              >
                /roster-api/openapi.json
              </a>
            </li>
            <li>
              <Link href="/docs" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">
                Marketing docs
              </Link>
              <span className="text-muted"> — quickstart, pillars, and the SDK sample.</span>
            </li>
            <li>
              <Link href="/console" className="text-brass underline decoration-brass/40 underline-offset-4 hover:decoration-brass">
                Signup
              </Link>
              <span className="text-muted"> — the key you paste into ROSTER_API_KEY.</span>
            </li>
          </ul>
        </section>
      </div>
    </ConsolePage>
  );
}
