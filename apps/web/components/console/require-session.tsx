"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useSandboxSession } from "./session";
import { buttonClass, ghostClass } from "./ui";

export function RequireSession({ children }: { children: ReactNode }) {
  const { session, ready } = useSandboxSession();
  if (!ready) {
    return <p className="text-sm text-muted">Loading the sandbox session…</p>;
  }
  if (!session) {
    return (
      <div className="max-w-xl border border-line/10 bg-panel p-6">
        <h2 className="font-serif text-3xl tracking-[-0.03em]">Sign in to continue</h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          Sign in with GitHub or Google. The sandbox key stays in this browser. Agents use that key, not a password on this page.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link href="/console" className={buttonClass}>
            Create account
          </Link>
          <Link href="/console/login" className={ghostClass}>
            Sign in
          </Link>
        </div>
      </div>
    );
  }
  return children;
}
