import type { ChainId } from "../types.js";
import { WalletProviderError } from "./errors.js";
import type { TransferRequest, TransferResult, WalletProvider } from "./types.js";

export interface BaseUsdcWalletOptions {
  /**
   * Future Base Sepolia RPC URL. Ignored in v0.
   * Do not pass private keys, mnemonics, or seeds — this type does not accept them.
   */
  rpcUrl?: string;
}

/**
 * Placeholder for USDC on Base (Coinbase L2).
 * v0 does not open a network connection. Callers should keep using {@link MockWalletProvider}.
 * The intended later path is Base Sepolia, not Ethereum L1 and not mainnet.
 */
export class BaseUsdcWalletProvider implements WalletProvider {
  readonly id = "base-usdc" as const;
  readonly chain: ChainId = "base-sepolia";

  constructor(_options: BaseUsdcWalletOptions = {}) {}

  createAddress(_ownerRef: string): Promise<{ address: string }> {
    return Promise.reject(this.unavailable());
  }

  getBalance(_address: string): Promise<string> {
    return Promise.reject(this.unavailable());
  }

  transfer(_request: TransferRequest): Promise<TransferResult> {
    return Promise.reject(this.unavailable());
  }

  private unavailable(): WalletProviderError {
    return new WalletProviderError(
      "Base USDC adapter is not implemented. Use MockWalletProvider. No chain calls are made.",
    );
  }
}
