import type { MockWalletSnapshot } from "./mock.js";

/** In-process sandbox rail that can mint test funds and round-trip balances. */
export interface PersistentSandboxWallet {
  credit(address: string, amountUsdc: string): Promise<void>;
  exportState(): MockWalletSnapshot;
  importState(snapshot: MockWalletSnapshot): void;
}

export function isPersistentSandboxWallet(wallet: object): wallet is PersistentSandboxWallet {
  const candidate = wallet as {
    credit?: unknown;
    exportState?: unknown;
    importState?: unknown;
  };
  return (
    typeof candidate.credit === "function" &&
    typeof candidate.exportState === "function" &&
    typeof candidate.importState === "function"
  );
}
