import Link from "next/link";
import { GITHUB_URL, SANDBOX_DISCLAIMER } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-line/10">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12 md:flex-row md:items-end md:justify-between">
        <div className="max-w-xl">
          <p className="font-serif text-3xl tracking-[-0.03em]">Roster</p>
          <p className="mt-3 text-sm leading-6 text-muted">{SANDBOX_DISCLAIMER}</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
          <Link href="/console" className="text-paper hover:text-brass">
            Console
          </Link>
          <Link href="/docs" className="text-paper hover:text-brass">
            Docs
          </Link>
          <Link href="/#developers" className="text-paper hover:text-brass">
            Waitlist
          </Link>
          <a href={GITHUB_URL} className="text-paper hover:text-brass">
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
