"use client";

import { useState } from "react";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
      className="inline-flex min-h-9 shrink-0 items-center rounded-md border border-line/20 px-3 text-xs text-paper transition-colors hover:border-brass/70 hover:text-brass"
    >
      <span aria-live="polite">{copied ? "Copied ✓" : "Copy"}</span>
    </button>
  );
}
