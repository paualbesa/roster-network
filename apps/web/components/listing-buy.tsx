"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUsdc } from "@/lib/need";
import { readBrowserSession } from "@/lib/session";
import { BuyReceipt, useBuy } from "./buy-receipt";

export function ListingBuy({ listingId, priceUsdc, example }: { listingId: string; priceUsdc: string; example: unknown }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [input, setInput] = useState(() => (example && typeof example === "object" ? JSON.stringify(example, null, 2) : "{}"));
  const [inputError, setInputError] = useState("");
  const buy = useBuy(apiKey);

  useEffect(() => {
    setApiKey(readBrowserSession()?.apiKey ?? null);
  }, []);

  function submit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input || "{}");
    } catch {
      setInputError("Input must be valid JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setInputError("Input must be a JSON object.");
      return;
    }
    setInputError("");
    void buy.run(listingId, parsed as Record<string, unknown>);
  }

  return (
    <div className="border border-line/10 bg-panel p-5">
      <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Price per call</p>
      <p className="mt-1 font-serif text-4xl tracking-[-0.03em] text-brass">{formatUsdc(priceUsdc)} <span className="font-mono text-sm text-muted">USDC</span></p>
      <p className="mt-2 text-sm leading-6 text-muted">Escrowed and released only when the data validates. Otherwise you are refunded. Sandbox: demo USDC.</p>
      <label className="mt-5 block font-mono text-[11px] tracking-[0.16em] text-muted uppercase" htmlFor={`input-${listingId}`}>
        Input (JSON)
      </label>
      <textarea
        id={`input-${listingId}`}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        rows={Math.min(10, Math.max(3, input.split("\n").length))}
        spellCheck={false}
        className="mt-2 w-full border border-line/15 bg-panel-2 px-3 py-2 font-mono text-xs text-paper"
      />
      {inputError ? <p role="alert" className="mt-2 text-sm text-brass-bright">{inputError}</p> : null}
      <div className="mt-4">
        {apiKey ? (
          <button
            type="button"
            disabled={buy.pending}
            onClick={submit}
            className="inline-flex min-h-12 w-full items-center justify-center bg-brass px-5 text-sm font-medium text-ink transition-colors hover:bg-brass-bright disabled:cursor-wait disabled:opacity-70"
          >
            {buy.pending ? "Buying…" : `Buy · ${formatUsdc(priceUsdc)} USDC`}
          </button>
        ) : (
          <Link href="/console/login" className="inline-flex min-h-12 w-full items-center justify-center bg-brass px-5 text-sm font-medium text-ink hover:bg-brass-bright">
            Sign in to buy — free sandbox, 1,000 demo USDC
          </Link>
        )}
      </div>
      <BuyReceipt state={buy} />
    </div>
  );
}
