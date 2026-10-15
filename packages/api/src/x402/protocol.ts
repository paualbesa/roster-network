/**
 * x402 (HTTP 402 Payment Required) wire format, following github.com/coinbase/x402.
 * Supports both protocol versions on the wire:
 * - v1: body `{ x402Version: 1, accepts: [...] }`, request header `X-PAYMENT`, response header `X-PAYMENT-RESPONSE`,
 *   network names like `solana-devnet`, amount field `maxAmountRequired`.
 * - v2: header `PAYMENT-REQUIRED` (base64 JSON), request header `PAYMENT-SIGNATURE`, response header `PAYMENT-RESPONSE`,
 *   CAIP-2 networks like `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, amount field `amount`.
 * Roster emits both shapes at once so v1 and v2 clients can pay the same endpoint.
 */

export const X402_VERSION = 2;
export const SOLANA_DEVNET = "solana-devnet";
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** Circle's public USDC test mint on Solana Devnet (the asset x402 clients expect on solana-devnet). */
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const NETWORK_ALIASES: Record<string, string> = {
  [SOLANA_DEVNET_CAIP2]: SOLANA_DEVNET,
  [SOLANA_MAINNET_CAIP2]: "solana",
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
  "eip155:1": "ethereum",
  "eip155:137": "polygon",
  "eip155:43114": "avalanche",
  "eip155:43113": "avalanche-fuji",
};

/** Map any v1 name or CAIP-2 id to the v1 short name (`solana-devnet`, `base`, ...). Unknown ids pass through. */
export function normalizeNetwork(network: string): string {
  const trimmed = network.trim();
  return NETWORK_ALIASES[trimmed] ?? trimmed.toLowerCase();
}

export function isSolanaDevnet(network: string): boolean {
  return normalizeNetwork(network) === SOLANA_DEVNET;
}

/** One accepted payment option. Carries both `amount` (v2) and `maxAmountRequired` (v1). */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  /** Atomic units (USDC micros). */
  amount: string;
  maxAmountRequired?: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resource?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
  extra?: Record<string, unknown>;
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
  accepted?: PaymentRequirements;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  errorReason?: string;
}

export class X402Error extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "X402Error";
  }
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader(raw: string): unknown {
  const text = Buffer.from(raw.trim(), "base64").toString("utf8");
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an `X-PAYMENT` / `PAYMENT-SIGNATURE` header into a payment payload (v1 or v2). */
export function parsePaymentHeader(raw: string): PaymentPayload {
  if (raw.length > 64 * 1024) throw new X402Error("invalid_payload", "Payment header is too large.");
  let decoded: unknown;
  try {
    decoded = decodeHeader(raw);
  } catch {
    throw new X402Error("invalid_payload", "Payment header is not base64-encoded JSON.");
  }
  if (!isRecord(decoded)) throw new X402Error("invalid_payload", "Payment header must encode a JSON object.");
  const accepted = isRecord(decoded.accepted) ? decoded.accepted : null;
  const scheme = typeof decoded.scheme === "string" ? decoded.scheme : typeof accepted?.scheme === "string" ? accepted.scheme : "";
  const network = typeof decoded.network === "string" ? decoded.network : typeof accepted?.network === "string" ? accepted.network : "";
  const version = typeof decoded.x402Version === "number" ? decoded.x402Version : 1;
  if (!scheme || !network || !isRecord(decoded.payload)) {
    throw new X402Error("invalid_payload", "Payment payload needs scheme, network and payload.");
  }
  return {
    x402Version: version,
    scheme,
    network,
    payload: decoded.payload,
    ...(accepted ? { accepted: accepted as unknown as PaymentRequirements } : {}),
  };
}

function readRequirement(raw: unknown): PaymentRequirements | null {
  if (!isRecord(raw)) return null;
  const amount = typeof raw.amount === "string" ? raw.amount : typeof raw.maxAmountRequired === "string" ? raw.maxAmountRequired : null;
  if (typeof raw.scheme !== "string" || typeof raw.network !== "string" || amount === null || !/^\d{1,20}$/.test(amount)) return null;
  if (typeof raw.payTo !== "string" || typeof raw.asset !== "string") return null;
  return {
    scheme: raw.scheme,
    network: raw.network,
    amount,
    asset: raw.asset,
    payTo: raw.payTo,
    maxTimeoutSeconds: typeof raw.maxTimeoutSeconds === "number" ? raw.maxTimeoutSeconds : 60,
    ...(typeof raw.resource === "string" ? { resource: raw.resource } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 500) } : {}),
    ...(typeof raw.mimeType === "string" ? { mimeType: raw.mimeType } : {}),
    ...(raw.outputSchema !== undefined ? { outputSchema: raw.outputSchema } : {}),
    ...(isRecord(raw.extra) ? { extra: raw.extra } : {}),
  };
}

/**
 * Read the payment requirements of a 402 response: v2 `PAYMENT-REQUIRED` header first, then a v1/v2 JSON body.
 * Returns null when the response does not describe an x402 payment.
 */
export function parsePaymentRequired(headers: Record<string, string | undefined>, body: string): PaymentRequiredBody | null {
  const candidates: unknown[] = [];
  const header = headers["payment-required"];
  if (header) {
    try {
      candidates.push(decodeHeader(header));
    } catch {
      // fall back to the body
    }
  }
  if (body.trim()) {
    try {
      candidates.push(JSON.parse(body) as unknown);
    } catch {
      // not JSON
    }
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !Array.isArray(candidate.accepts)) continue;
    const accepts = candidate.accepts.map(readRequirement).filter((item): item is PaymentRequirements => item !== null);
    if (accepts.length === 0) continue;
    const resource = isRecord(candidate.resource) && typeof candidate.resource.url === "string" ? { url: candidate.resource.url } : undefined;
    return {
      x402Version: typeof candidate.x402Version === "number" ? candidate.x402Version : 1,
      ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
      ...(resource ? { resource } : {}),
      accepts,
    };
  }
  return null;
}

/** Pick the first requirement Roster can pay itself (`exact` on solana-devnet), else the first one. */
export function pickRequirement(required: PaymentRequiredBody): { requirement: PaymentRequirements; supported: boolean } {
  const supported = required.accepts.find((item) => item.scheme === "exact" && isSolanaDevnet(item.network));
  if (supported) return { requirement: supported, supported: true };
  return { requirement: required.accepts[0] as PaymentRequirements, supported: false };
}

export function microsToUsdc(micros: string): string {
  const value = BigInt(micros);
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${frac}`;
}

export function usdcToMicros(usdc: string): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usdc.trim());
  if (!match) throw new X402Error("invalid_amount", `Invalid USDC amount ${usdc}.`);
  const whole = BigInt(match[1] as string);
  const frac = BigInt((match[2] ?? "").padEnd(6, "0"));
  return (whole * 1_000_000n + frac).toString();
}
