import type { ChainId } from "../types.js";
import { WalletProviderError } from "./errors.js";
import { assertSandboxWalletOptions } from "./sandbox-guard.js";
import type { TransferRequest, TransferResult, WalletProvider } from "./types.js";

export interface SolanaUsdcWalletOptions {
  /**
   * Rejected. This stub never dials Solana.
   * There is no field for a private key, mnemonic, or seed.
   */
  rpcUrl?: string;
}

/**
 * Sandbox placeholder for USDC on Solana.
 * Transfers are not implemented. No RPC client is loaded and no keys are stored.
 * Settlement stays on MockWalletProvider or the simulated Base rail.
 */
export class SolanaUsdcWalletProvider implements WalletProvider {
  readonly id = "solana-usdc" as const;
  readonly chain: ChainId = "solana-devnet-sim";

  constructor(options: SolanaUsdcWalletOptions = {}) {
    assertSandboxWalletOptions(options);
  }

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
      "Solana USDC adapter is not implemented. Use MockWalletProvider or the simulated Base rail. No chain calls are made.",
    );
  }
}
