/** Turns a live x402 `payment-required` header into a short, readable transcript. */

export interface X402Accept {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number | undefined;
}

export interface X402Sample {
  url: string;
  status: number;
  version: number | null;
  description: string | null;
  accept: X402Accept | null;
}

function short(value: string, keep = 6): string {
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-4)}` : value;
}

export function parsePaymentRequired(header: string | null): Pick<X402Sample, "version" | "description" | "accept"> {
  if (!header) return { version: null, description: null, accept: null };
  try {
    const json = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      x402Version?: number;
      resource?: { description?: string };
      accepts?: Partial<X402Accept & { maxAmountRequired: string }>[];
    };
    const a = json.accepts?.[0];
    const accept: X402Accept | null =
      a && a.scheme && a.network && a.asset && a.payTo
        ? {
            scheme: a.scheme,
            network: a.network,
            amount: a.amount ?? a.maxAmountRequired ?? "?",
            asset: a.asset,
            payTo: a.payTo,
            maxTimeoutSeconds: a.maxTimeoutSeconds,
          }
        : null;
    const description = json.resource?.description?.split(":")[0]?.trim() ?? null;
    return { version: json.x402Version ?? null, description, accept };
  } catch {
    return { version: null, description: null, accept: null };
  }
}

/** Atomic USDC units (6 decimals) to a plain decimal string. */
export function atomicUsdc(amount: string): string {
  if (!/^\d+$/.test(amount)) return amount;
  const padded = amount.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function transcript(s: X402Sample): string {
  const lines = [`$ curl -i ${s.url}`, "", `HTTP/2 ${s.status.toString()}`];
  if (s.version !== null) lines.push(`payment-required: <base64, x402 v${s.version.toString()}>`);
  if (s.accept) {
    lines.push(
      "",
      "# decoded accepts[0]",
      `scheme     ${s.accept.scheme}`,
      `network    ${s.accept.network}`,
      `amount     ${s.accept.amount}  (${atomicUsdc(s.accept.amount)} USDC)`,
      `asset      ${short(s.accept.asset)}`,
      `payTo      ${short(s.accept.payTo)}`,
    );
    if (s.accept.maxTimeoutSeconds) lines.push(`timeout    ${s.accept.maxTimeoutSeconds.toString()} s`);
  }
  return lines.join("\n");
}
