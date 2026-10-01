import { SolanaFeeError } from "./errors.js";

interface RpcBody<T> {
  result?: T;
  error?: { message?: string };
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Solana RPC request failed.";
    throw new SolanaFeeError(502, "rpc_error", message);
  }
  if (!response.ok) {
    throw new SolanaFeeError(502, "rpc_error", `Solana RPC returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as RpcBody<T>;
  if (body.error) {
    throw new SolanaFeeError(502, "rpc_error", body.error.message ?? "Solana RPC error.");
  }
  if (body.result === undefined) {
    throw new SolanaFeeError(502, "rpc_error", "Solana RPC returned an empty result.");
  }
  return body.result;
}

export async function rpcGetLatestBlockhash(rpcUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const result = await rpcCall<{ value?: { blockhash?: string } }>(
    rpcUrl,
    "getLatestBlockhash",
    [{ commitment: "confirmed" }],
    fetchImpl,
  );
  const blockhash = result.value?.blockhash;
  if (!blockhash) {
    throw new SolanaFeeError(502, "rpc_error", "Solana RPC did not return a blockhash.");
  }
  return blockhash;
}

export async function rpcGetBalanceLamports(rpcUrl: string, pubkey: string, fetchImpl: typeof fetch): Promise<bigint> {
  const result = await rpcCall<{ value?: number }>(rpcUrl, "getBalance", [pubkey, { commitment: "confirmed" }], fetchImpl);
  const value = result.value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SolanaFeeError(502, "rpc_error", "Solana RPC did not return a SOL balance.");
  }
  return BigInt(value);
}

export async function rpcSendRawTransaction(rpcUrl: string, bytes: Uint8Array, fetchImpl: typeof fetch): Promise<string> {
  const result = await rpcCall<string>(
    rpcUrl,
    "sendTransaction",
    [Buffer.from(bytes).toString("base64"), { encoding: "base64", skipPreflight: false }],
    fetchImpl,
  );
  if (typeof result !== "string" || result.length === 0) {
    throw new SolanaFeeError(502, "rpc_error", "Solana RPC did not return a signature.");
  }
  return result;
}
