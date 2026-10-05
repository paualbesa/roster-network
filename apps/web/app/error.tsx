"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="content" className="mx-auto flex min-h-[60vh] max-w-3xl flex-col justify-center px-6 py-24">
      <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">Error</p>
      <h1 className="mt-4 font-serif text-5xl tracking-[-0.035em]">Something went wrong on this page.</h1>
      <p className="mt-4 text-muted">
        Try again. If it keeps failing, the sandbox API may be restarting.
        {error.digest ? <span className="mt-2 block font-mono text-xs">Reference {error.digest}</span> : null}
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-12 items-center bg-brass px-5 text-sm font-medium text-ink hover:bg-brass-bright"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex min-h-12 items-center border border-line/20 px-5 text-sm text-paper hover:border-brass/70 hover:text-brass"
        >
          Back to Roster
        </Link>
      </div>
    </main>
  );
}
