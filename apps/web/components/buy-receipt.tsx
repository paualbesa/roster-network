"use client";

import { useState } from "react";
import { formatUsdc, type BuyResponseView } from "@/lib/need";
import { createRosterClient, rosterErrorMessage } from "@/lib/roster-client";

export interface BuyState {
  pending: boolean;
  error: string;
  receipt: BuyResponseView | null;
  run: (listingId: string, input?: Record<string, unknown>) => Promise<void>;
}

export function useBuy(apiKey: string | null): BuyState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<BuyResponseView | null>(null);
  async function run(listingId: string, input?: Record<string, unknown>) {
    if (!apiKey) return;
    setPending(true);
    setError("");
    try {
      const body: { listingId: string; input?: Record<string, unknown> } = { listingId };
      if (input && Object.keys(input).length > 0) body.input = input;
      setReceipt(await createRosterClient({ apiKey }).buy(body));
    } catch (caught) {
      setError(rosterErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }
  return { pending, error, receipt, run };
}

export function BuyReceipt({ state }: { state: BuyState }) {
  if (state.error) return <p role="alert" className="mt-3 text-sm text-brass-bright">{state.error}</p>;
  const receipt = state.receipt;
  if (!receipt) return null;
  const released = receipt.status === "released";
  const preview = previewOf(receipt.result);
  return (
    <div className="mt-4 border border-line/10 bg-panel-2 p-4" role="status">
      <p className={`text-sm ${released ? "text-sage" : "text-muted"}`}>
        {released
          ? `Delivered · paid ${formatUsdc(receipt.amountUsdc)} USDC (sandbox)`
          : receipt.status === "refunded"
            ? "Not delivered · you were refunded"
            : `Job ${receipt.status} · it settles when the seller delivers`}
      </p>
      {receipt.jsonUrl || receipt.csvUrl ? (
        <p className="mt-2 flex flex-wrap gap-3 text-sm">
          {receipt.csvUrl ? (
            <a href={receipt.csvUrl} className="text-brass underline decoration-brass/40 underline-offset-4" rel="noreferrer" target="_blank">
              Download CSV
            </a>
          ) : null}
          {receipt.jsonUrl ? (
            <a href={receipt.jsonUrl} className="text-brass underline decoration-brass/40 underline-offset-4" rel="noreferrer" target="_blank">
              Download JSON
            </a>
          ) : null}
          <span className="text-xs text-muted">Links expire in 1 hour.</span>
        </p>
      ) : null}
      {preview ? <pre className="mt-3 max-h-56 overflow-auto font-mono text-[11px] leading-5 text-paper">{preview}</pre> : null}
      <p className="mt-2 font-mono text-[10px] break-all text-muted">Job {receipt.jobId}</p>
    </div>
  );
}

function previewOf(result: unknown): string {
  if (result === null || result === undefined) return "";
  const json = JSON.stringify(result, null, 2);
  return json.length > 2400 ? `${json.slice(0, 2400)}\n…` : json;
}
