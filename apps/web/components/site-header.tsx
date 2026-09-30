"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/#problem", label: "Problem" },
  { href: "/#pillars", label: "Pillars" },
  { href: "/#flow", label: "How it works" },
  { href: "/console", label: "Console" },
  { href: "/docs", label: "Docs" },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-line/10 bg-ink/80 backdrop-blur-md">
      <div className="h-[3px] bg-brass" />
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
        <Link href="/" className="group flex items-center gap-3 rounded-sm" onClick={() => setOpen(false)}>
          <Mark />
          <span className="font-serif text-2xl tracking-[-0.03em] text-paper">Roster</span>
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-sm text-muted transition-colors hover:text-paper">
              {item.label}
            </Link>
          ))}
          <Link
            href="/#developers"
            className="inline-flex min-h-11 items-center bg-brass px-4 text-sm font-medium text-ink transition-colors hover:bg-brass-bright"
          >
            Waitlist
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
                  className="block py-3 text-base text-paper"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/#developers"
                className="mt-2 inline-flex min-h-11 items-center bg-brass px-4 text-sm font-medium text-ink"
                onClick={() => setOpen(false)}
              >
                Waitlist
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
      <rect x="2" y="5" width="14" height="2" fill="#ece6da" />
      <rect x="2" y="12" width="20" height="2" fill="#ece6da" />
      <rect x="2" y="19" width="10" height="2" fill="#c4a36a" />
    </svg>
  );
}
