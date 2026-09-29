import { formatUsdc, parseUsdc } from "../money.js";
import type { ChainId } from "../types.js";
import { WalletProviderError } from "./errors.js";
import type { TransferRequest, TransferResult, WalletProvider } from "./types.js";

export interface MockWalletProviderOptions {
  /** Label only. Nothing is broadcast. */
  chain?: ChainId;
}

/**
 * Balances and the transfer counter. No keys, addresses are opaque ids.
 * `networkFeesCollectedUsdc` is set by the simulated Base rail and ignored by mock.
 */
export interface MockWalletSnapshot {
  balances: { address: string; balanceUsdc: string }[];
  sequence: number;
  networkFeesCollectedUsdc?: string;
}

/**
 * In-memory USDC ledger. Addresses are opaque mock ids, not blockchain accounts.
 * There are no keys to export. A snapshot can be restored after a process restart.
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

  exportState(): MockWalletSnapshot {
    const balances = [...this.balances.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([address, micros]) => ({ address, balanceUsdc: formatUsdc(micros) }));
    return { balances, sequence: this.sequence };
  }

  importState(snapshot: MockWalletSnapshot): void {
    if (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 0) {
      throw new WalletProviderError("Mock wallet sequence must be a non-negative integer.");
    }
    const next = new Map<string, bigint>();
    for (const entry of snapshot.balances) {
      if (!entry.address) throw new WalletProviderError("Mock wallet snapshot has an empty address.");
      next.set(entry.address, parseUsdc(entry.balanceUsdc));
    }
    this.balances.clear();
    for (const [address, amount] of next) this.balances.set(address, amount);
    this.sequence = snapshot.sequence;
  }
}
