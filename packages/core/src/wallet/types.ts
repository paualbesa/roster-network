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
}

/**
 * Settlement adapter. v0 ships {@link MockWalletProvider} only.
 * A future Base USDC adapter should implement this same surface and must not
 * require committed keys, mnemonics, or seeds.
 */
export interface WalletProvider {
  readonly id: "mock" | "base-usdc";
  readonly chain: ChainId;
  createAddress(ownerRef: string): Promise<{ address: string }>;
  getBalance(address: string): Promise<string>;
  transfer(request: TransferRequest): Promise<TransferResult>;
}
