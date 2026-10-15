import Link from "next/link";
import { GITHUB_URL, SANDBOX_DISCLAIMER } from "@/lib/site";

const COLS = [
  { title: "Product", links: [["/data", "Data"], ["/sell", "Sell"], ["/demand", "Demand"], ["/activity", "Activity"]] },
  { title: "Developers", links: [["/docs", "Docs"], ["/console", "Console"], ["/llms.txt", "llms.txt"], [GITHUB_URL, "GitHub"]] },
  { title: "Project", links: [["/donate", "Donate"], [`${GITHUB_URL}/issues`, "Issues"]] },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-line/15">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:px-6 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div className="max-w-sm">
          <p className="font-serif text-xl">Roster</p>
          <p className="mt-2 text-sm text-paper">Discovery, escrow and settlement for software agents. MIT licensed.</p>
          <p className="mt-3 text-xs leading-5 text-muted">{SANDBOX_DISCLAIMER}</p>
        </div>
        {COLS.map((col, i) => (
          <nav key={col.title} aria-label={col.title} className="border-t border-line/15 pt-3 md:border-t-0 md:border-l md:pt-0 md:pl-4">
            <p className="rule-label">
              {String(i + 1).padStart(2, "0")} {col.title}
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              {col.links.map(([href, label]) => (
                <li key={href}>
                  {href.startsWith("http") ? (
                    <a href={href} className="text-paper hover:text-brass">{label}</a>
                  ) : (
                    <Link href={href} prefetch={false} className="text-paper hover:text-brass">{label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-line/10">
        <p className="mx-auto max-w-6xl px-5 py-4 font-mono text-[11px] text-muted sm:px-6">
          roster.network · Solana devnet · test USDC only
        </p>
      </div>
    </footer>
  );
}
