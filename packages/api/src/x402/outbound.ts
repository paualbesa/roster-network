/**
 * Outbound x402: detect a Payment Required response while importing, and pay an
 * exact/solana-devnet requirement from Roster's fee-payer wallet when buying.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { ImportedDraft, SellerEndpoint } from "../sell/import.js";
import type { SafeFetcher } from "../sell/net.js";
import {
  isSolanaDevnet,
  microsToUsdc,
  parsePaymentRequired,
  pickRequirement,
  type PaymentRequirements,
  SOLANA_DEVNET,
  type SettlementResponse,
  X402Error,
} from "./protocol.js";
import { associatedTokenAddress, buildExactSvmPayment } from "./svm.js";

export type X402SellerEndpoint = Extract<SellerEndpoint, { type: "x402" }>;

export function isX402Endpoint(endpoint: SellerEndpoint): endpoint is X402SellerEndpoint {
  return endpoint.type === "x402";
}

export async function detectX402(
  url: string,
  fetcher: SafeFetcher,
  options: { method?: "GET" | "POST"; body?: string } = {},
): Promise<{ required: NonNullable<ReturnType<typeof parsePaymentRequired>>; method: "GET" | "POST" } | null> {
  const method = options.method ?? "GET";
  const response = await fetcher(url, {
    method,
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
    ...(options.body ? { body: options.body } : {}),
    timeoutMs: 12_000,
    maxBytes: 512 * 1024,
    maxRedirects: 1,
  });
  if (response.status !== 402) return null;
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(response.headers ?? {})) headers[key.toLowerCase()] = value;
  const required = parsePaymentRequired(headers, response.body);
  if (!required) return null;
  return { required, method };
}

export function draftFromX402(
  url: string,
  method: "GET" | "POST",
  required: NonNullable<ReturnType<typeof parsePaymentRequired>>,
): ImportedDraft {
  const { requirement, supported } = pickRequirement(required);
  // Never suggest below the Roster minimum listing price (0.01 USDC).
  const priceUsdc = microsToUsdc(BigInt(requirement.amount) < 10_000n ? "10000" : requirement.amount);
  const network = requirement.network;
  const description =
    requirement.description?.trim() ||
    `External x402 resource at ${url}${supported ? "" : ` (network ${network} is not payable from Roster yet)`}`;
  const endpoint: X402SellerEndpoint = {
    type: "x402",
    url,
    method,
    requirement: supported ? requirement : null,
    network,
    supported,
  };
  return {
    name: (requirement.extra && typeof requirement.extra.name === "string" ? requirement.extra.name : new URL(url).hostname).slice(0, 60),
    description: description.slice(0, 500),
    inputSchema: { type: "object", additionalProperties: true, properties: {} },
    outputSchema: { type: "object", required: ["status"], properties: { status: { type: "number" } }, additionalProperties: true },
    suggestedPriceUsdc: priceUsdc,
    priceBasis: supported
      ? `x402 exact on ${SOLANA_DEVNET}: ${requirement.amount} micros of ${requirement.asset}`
      : `x402 external, unsupported network (${network})`,
    similar: [],
    p95Ms: Math.max(5_000, (requirement.maxTimeoutSeconds || 60) * 1_000),
    tags: ["x402", supported ? "solana-devnet" : "external"],
    endpoint,
    warnings: supported
      ? [`Roster will pay this endpoint on ${SOLANA_DEVNET} when a buyer calls roster_buy.`]
      : [`x402 external, unsupported network (${network}). Roster will not attempt to pay it.`],
    example: {},
  };
}

export interface X402Payer {
  /** Build + settle a payment, return the signed X-PAYMENT header value (base64). */
  pay(requirement: PaymentRequirements): Promise<{ header: string; settlement: SettlementResponse }>;
}

/** Devnet payer that holds a Keypair. The resource's facilitator (extra.feePayer) sponsors fees when present. */
export class DevnetX402Payer implements X402Payer {
  private readonly connection: Connection | null;
  constructor(
    private readonly payer: Keypair,
    rpcUrl: string | null,
    private readonly blockhash?: () => Promise<string>,
  ) {
    if (rpcUrl && /mainnet/i.test(rpcUrl)) throw new Error("x402 outbound payments are devnet-only.");
    this.connection = rpcUrl ? new Connection(rpcUrl, "confirmed") : null;
  }

  get address(): string {
    return this.payer.publicKey.toBase58();
  }

  private async recentBlockhash(): Promise<string> {
    if (this.blockhash) return this.blockhash();
    if (!this.connection) throw new X402Error("unsupported_network", "No devnet RPC configured.");
    return (await this.connection.getLatestBlockhash("confirmed")).blockhash;
  }

  async pay(requirement: PaymentRequirements): Promise<{ header: string; settlement: SettlementResponse }> {
    if (requirement.scheme !== "exact" || !isSolanaDevnet(requirement.network)) {
      throw new X402Error("unsupported_network", `x402 external, unsupported network (${requirement.network}).`);
    }
    const txB64 = buildExactSvmPayment({ requirement, payer: this.payer, recentBlockhash: await this.recentBlockhash() });
    const payload = { x402Version: 1, scheme: "exact", network: requirement.network, payload: { transaction: txB64 } };
    return {
      header: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      settlement: { success: false, transaction: "", network: SOLANA_DEVNET, payer: this.address },
    };
  }
}

/** Call an external x402 resource with a signed payment header and return the JSON body. */
export async function callX402Resource(
  fetcher: SafeFetcher,
  endpoint: X402SellerEndpoint,
  input: Record<string, unknown>,
  payer: X402Payer,
): Promise<Record<string, unknown>> {
  if (!endpoint.supported || !endpoint.requirement) {
    throw new Error(`x402 external, unsupported network (${endpoint.network}).`);
  }
  // Refresh requirements (resource may rotate feePayer / memo).
  const probe = await detectX402(endpoint.url, fetcher, endpoint.method === "POST" ? { method: "POST", body: JSON.stringify(input) } : { method: "GET" });
  const requirement = probe?.required.accepts.find((item) => item.scheme === "exact" && isSolanaDevnet(item.network)) ?? endpoint.requirement;
  if (BigInt(requirement.amount) > BigInt(endpoint.requirement.amount)) {
    throw new Error(`External x402 price rose to ${requirement.amount} micros (imported at ${endpoint.requirement.amount}); not paying.`);
  }
  if (requirement.payTo !== endpoint.requirement.payTo || requirement.asset !== endpoint.requirement.asset) {
    throw new Error("External x402 payTo/asset changed since import; not paying.");
  }
  const { header } = await payer.pay(requirement);
  const response = await fetcher(endpoint.url, {
    method: endpoint.method,
    headers: {
      accept: "application/json",
      "x-payment": header,
      "payment-signature": header,
      ...(endpoint.method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(endpoint.method === "POST" ? { body: JSON.stringify(input) } : {}),
    timeoutMs: Math.min(30_000, (requirement.maxTimeoutSeconds || 60) * 1_000),
    maxBytes: 1024 * 1024,
    maxRedirects: 1,
  });
  if (response.status === 402) throw new Error("External x402 resource still returned 402 after payment.");
  if (response.status < 200 || response.status >= 300) throw new Error(`External x402 resource answered HTTP ${response.status.toString()}.`);
  if (!response.body.trim()) return { status: response.status };
  try {
    return { status: response.status, data: JSON.parse(response.body) as unknown };
  } catch {
    return { status: response.status, data: response.body.slice(0, 4_000) };
  }
}

export function ataFor(owner: string, mint: string): string {
  return associatedTokenAddress(new PublicKey(owner), new PublicKey(mint)).toBase58();
}
