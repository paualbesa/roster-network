import { formatUsdc, parseUsdc } from "../money.js";
import type { ChainId } from "../types.js";
import { WalletProviderError } from "./errors.js";
import type { TransferRequest, TransferResult, WalletProvider } from "./types.js";

export interface MockWalletProviderOptions {
  /** Label only. Balances stay inside this process; nothing is broadcast. */
  chain?: ChainId;
}

/**
 * In-memory USDC ledger. Addresses are opaque mock ids, not blockchain accounts.
 * There are no keys to export.
 */
export class MockWalletProvider implements WalletProvider {
  readonly id = "mock" as const;
  readonly chain: ChainId;
  private readonly balances = new Map<string, bigint>();
  private sequence = 0;

  constructor(options: MockWalletProviderOptions = {}) {
    this.chain = options.chain ?? "mock";
  }

  async createAddress(ownerRef: string): Promise<{ address: string }> {
    const address = `mock:${ownerRef}`;
    if (!this.balances.has(address)) this.balances.set(address, 0n);
    return { address };
  }

  async getBalance(address: string): Promise<string> {
    return formatUsdc(this.balances.get(address) ?? 0n);
  }

  /** Sandbox-only mint. Not part of {@link WalletProvider}; real rails will not mint. */
  async credit(address: string, amountUsdc: string): Promise<void> {
    const amount = parseUsdc(amountUsdc);
    if (amount <= 0n) throw new WalletProviderError("Credit amount must be greater than zero.");
    const current = this.balances.get(address) ?? 0n;
    this.balances.set(address, current + amount);
  }

  async transfer(request: TransferRequest): Promise<TransferResult> {
    const amount = parseUsdc(request.amountUsdc);
    if (amount <= 0n) throw new WalletProviderError("Transfer amount must be greater than zero.");
    const fromBalance = this.balances.get(request.fromAddress) ?? 0n;
    if (fromBalance < amount) throw new WalletProviderError("Insufficient balance.");
    if (!this.balances.has(request.toAddress)) this.balances.set(request.toAddress, 0n);
    this.balances.set(request.fromAddress, fromBalance - amount);
    const toBalance = this.balances.get(request.toAddress) ?? 0n;
    this.balances.set(request.toAddress, toBalance + amount);
    this.sequence += 1;
    return {
      providerRef: `mock_tx_${this.sequence.toString(10)}`,
      status: "settled",
      chain: this.chain,
    };
  }
}
