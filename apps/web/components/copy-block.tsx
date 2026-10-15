"use client";

import { useState } from "react";

type Props = {
  label: string;
  code: string;
  badge?: string;
  copyLabel?: string;
};

/** Code block with a one-click copy button. Used for the MCP config and the x402 curl. */
export function CopyBlock({ label, code, badge, copyLabel = "Copy" }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <figure className="overflow-hidden border border-line/15 bg-ink shadow-[0_20px_60px_-30px_rgba(0,0,0,0.6)]">
      <figcaption className="flex items-center justify-between gap-3 border-b border-line/10 px-4 py-2.5 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
        <span className="flex items-center gap-2">
          {label}
          {badge ? <span className="border border-brass/50 px-1.5 py-0.5 text-[10px] text-brass">{badge}</span> : null}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex min-h-9 items-center border border-line/20 px-3 text-paper normal-case tracking-normal transition-colors hover:border-brass/70 hover:text-brass"
          aria-label={`${copyLabel}: ${label}`}
        >
          {copied ? "Copied ✓" : copyLabel}
        </button>
      </figcaption>
      <pre className="overflow-x-auto p-4 text-[13px] leading-6 text-paper">
        <code>{code}</code>
      </pre>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </figure>
  );
}
