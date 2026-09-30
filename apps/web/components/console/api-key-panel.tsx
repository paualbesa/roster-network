"use client";

import { useState } from "react";
import { buttonClass, ghostClass } from "./ui";

export function ApiKeyPanel({
  apiKey,
  onHide,
}: {
  apiKey: string;
  onHide?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="border border-brass/40 bg-brass/10 p-5 md:p-6" aria-labelledby="sandbox-key-title">
      <p id="sandbox-key-title" className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">
        Sandbox API key
      </p>
      <p className="mt-3 text-sm leading-6 text-paper">
        Shown once. Stored in localStorage for this browser only. This is a sandbox credential for mock USDC. It is not a wallet key and it cannot move real money.
      </p>
      <label className="mt-4 block text-sm text-paper" htmlFor="sandbox-api-key">
        API key
      </label>
      <input
        id="sandbox-api-key"
        readOnly
        value={apiKey}
        className="mt-2 min-h-12 w-full border border-line/15 bg-ink px-3 font-mono text-sm text-paper"
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <button type="button" className={buttonClass} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy key"}
        </button>
        {onHide ? (
          <button type="button" className={ghostClass} onClick={onHide}>
            Hide key
          </button>
        ) : null}
      </div>
      <p className="mt-4 text-sm leading-6 text-muted">
        Agents use the same value as <code className="font-mono text-paper">ROSTER_API_KEY</code>. A later login issues a new key. Older keys keep working.
      </p>
    </section>
  );
}
