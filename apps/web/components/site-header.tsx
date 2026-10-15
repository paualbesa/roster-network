"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/data", label: "Data" },
  { href: "/sell", label: "Sell" },
  { href: "/demand", label: "Demand" },
  { href: "/activity", label: "Activity" },
  { href: "/#flow", label: "How it works" },
  { href: "/console", label: "Console" },
  { href: "/docs", label: "Docs" },
  { href: "/donate", label: "Donate" },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const isCurrent = (href: string) => !href.includes("#") && (pathname === href || pathname.startsWith(`${href}/`));

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-line/15 bg-ink">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-6">
        <Link href="/" className="group flex items-center gap-3 rounded-sm" onClick={() => setOpen(false)}>
          <Mark />
          <span className="font-serif text-xl tracking-[-0.03em] text-paper">Roster</span>
          <span className="hidden font-mono text-[11px] text-muted sm:inline">/ agent settlement · devnet</span>
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-6 lg:gap-7 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={isCurrent(item.href) ? "page" : undefined}
              className="font-mono text-[12px] text-muted transition-colors hover:text-paper aria-[current=page]:text-paper aria-[current=page]:underline aria-[current=page]:decoration-brass aria-[current=page]:underline-offset-[6px]"
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/console"
            className="inline-flex min-h-9 items-center bg-paper px-3 font-mono text-[12px] text-ink transition-colors hover:bg-brass"
          >
            Get a key →
          </Link>
        </nav>
        <button
          type="button"
          className="inline-flex min-h-11 items-center border border-line/20 px-3 text-sm text-paper md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>
      {open ? (
        <nav id="mobile-nav" aria-label="Mobile" className="border-t border-line/10 px-6 py-4 md:hidden">
          <ul className="flex flex-col gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block border-b border-line/10 py-3 font-mono text-sm text-paper"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/console"
                className="mt-2 inline-flex min-h-11 items-center bg-paper px-4 font-mono text-sm text-ink"
                onClick={() => setOpen(false)}
              >
                Get a sandbox key →
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}
    </header>
  );
}

function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 28 28" className="size-7">
      <rect x="2" y="5" width="14" height="2" fill="#eceae4" />
      <rect x="2" y="12" width="20" height="2" fill="#eceae4" />
      <rect x="2" y="19" width="10" height="2" fill="#ff5b1f" />
    </svg>
  );
}
