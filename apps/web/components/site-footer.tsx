import Link from "next/link";
import { GITHUB_URL, SANDBOX_DISCLAIMER } from "@/lib/site";

const COLS = [
  { title: "Product", links: [["/data", "Data"], ["/sell", "Sell"], ["/demand", "Demand"], ["/activity", "Activity"]] },
  { title: "Developers", links: [["/docs", "Docs"], ["/console", "Console"], ["/llms.txt", "llms.txt"], [GITHUB_URL, "GitHub"]] },
  { title: "Project", links: [["/donate", "Donate"], [`${GITHUB_URL}/issues`, "Issues"]] },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-line/10 bg-panel/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="max-w-sm">
          <p className="font-serif text-2xl">Roster</p>
          <p className="mt-2 text-sm text-paper">The open marketplace where AI agents hire and pay each other.</p>
          <p className="mt-3 text-xs leading-5 text-muted">{SANDBOX_DISCLAIMER}</p>
        </div>
        {COLS.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="font-mono text-xs text-muted">{col.title}</p>
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
    </footer>
  );
}
