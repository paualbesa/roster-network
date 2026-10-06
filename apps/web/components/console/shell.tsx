"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { SANDBOX_DISCLAIMER } from "@/lib/site";
import { describeSignedInAccount } from "@/lib/supabase/oauth";
import { SessionProvider, useSandboxSession } from "./session";
import { SupabaseSessionBridge } from "./supabase-bridge";

const LINKS = [
  { href: "/console/keys", label: "Keys" },
  { href: "/console/dashboard", label: "Dashboard" },
  { href: "/console/marketplace", label: "Marketplace" },
  { href: "/console/hire", label: "Hire" },
  { href: "/console/seller", label: "Seller" },
  { href: "/sell", label: "Sell" },
  { href: "/demand", label: "Demand" },
  { href: "/activity", label: "Activity" },
  { href: "/console/kyc", label: "KYC" },
  { href: "/console/guide", label: "Docs" },
] as const;

export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <SupabaseSessionBridge />
      <div className="border-b border-line/10 bg-panel">
        <div className="mx-auto max-w-6xl px-6 py-3">
          <p className="text-sm leading-6 text-muted" role="note">
            {SANDBOX_DISCLAIMER} The console stores its API key in this browser.
          </p>
        </div>
      </div>
      <ConsoleNav />
      {children}
    </SessionProvider>
  );
}

function ConsoleNav() {
  const pathname = usePathname();
  const { session, clear } = useSandboxSession();
  const [open, setOpen] = useState(false);
  const account = session ? describeSignedInAccount(session) : null;

  return (
    <div className="border-b border-line/10">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">Sandbox console</p>
        <button
          type="button"
          className="inline-flex min-h-11 items-center border border-line/20 px-3 text-sm text-paper md:hidden"
          aria-expanded={open}
          aria-controls="console-nav"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Close" : "Sections"}
        </button>
        <nav aria-label="Console" className="hidden items-center gap-6 md:flex">
          {LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? "page" : undefined}
              className={pathname === item.href ? "text-sm text-brass" : "text-sm text-muted hover:text-paper"}
            >
              {item.label}
            </Link>
          ))}
          {account ? (
            <>
              <span className="max-w-48 truncate text-sm text-muted" title={account.headline}>
                {account.email || "Signed in"}
              </span>
              <button type="button" className="text-sm text-paper hover:text-brass" onClick={clear}>
                Sign out
              </button>
            </>
          ) : (
            <Link href="/console/login" className="text-sm text-paper hover:text-brass">
              Sign in
            </Link>
          )}
        </nav>
      </div>
      {open ? (
        <nav id="console-nav" aria-label="Console mobile" className="border-t border-line/10 px-6 py-3 md:hidden">
          <ul className="flex flex-col">
            {LINKS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block py-3 text-base text-paper"
                  aria-current={pathname === item.href ? "page" : undefined}
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              {account ? (
                <div className="py-3">
                  <p className="truncate text-sm text-muted" title={account.headline}>
                    {account.headline}
                  </p>
                  <button
                    type="button"
                    className="mt-2 text-base text-paper"
                    onClick={() => {
                      clear();
                      setOpen(false);
                    }}
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <Link href="/console/login" className="block py-3 text-base text-paper" onClick={() => setOpen(false)}>
                  Sign in
                </Link>
              )}
            </li>
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
