import type { ChainId } from "../types.js";

export interface TransferRequest {
  fromAddress: string;
  toAddress: string;
  amountUsdc: string;
  idempotencyKey: string;
}

export interface TransferResult {
  providerRef: string;
  status: "settled";
  chain: ChainId;
  /**
   * Simulated L2 network fee for this settlement.
   * Omitted by the mock rail. Not deducted from the payer.
   */
  networkFeeUsdc?: string;
  /**
   * Simulated L2 settlement latency in milliseconds.
   * Omitted by the mock rail. The adapter does not wait.
   */
  latencyMs?: number;
}

/**
 * Settlement adapter. The API defaults to the mock rail.
 * `base-usdc` is the in-process Base simulator. `solana-usdc` is a sandbox stub.
 * Adapters must not require committed keys, mnemonics, or seeds.
 */
export interface WalletProvider {
  readonly id: "mock" | "base-usdc" | "solana-usdc";
  readonly chain: ChainId;
  createAddress(ownerRef: string): Promise<{ address: string }>;
  getBalance(address: string): Promise<string>;
  transfer(request: TransferRequest): Promise<TransferResult>;
}
