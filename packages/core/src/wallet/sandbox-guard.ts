import { WalletProviderError } from "./errors.js";

const SECRET_FIELD =
  /^(privatekey|private_key|mnemonic|seed|seedphrase|seed_phrase|secret|secretkey|secret_key)$/i;

/**
 * Sandbox adapters never store key material and never dial a chain.
 * The check is runtime because callers often spread a wider config object.
 */
export function assertSandboxWalletOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (SECRET_FIELD.test(key)) {
      throw new WalletProviderError(
        "Sandbox wallets refuse private keys, mnemonics, and seeds. No key material is stored.",
      );
    }
  }
  if (!("rpcUrl" in options)) return;
  const rpcUrl = (options as { rpcUrl?: unknown }).rpcUrl;
  if (rpcUrl === undefined || rpcUrl === "") return;
  throw new WalletProviderError("Sandbox wallets refuse RPC URLs. No chain calls are made.");
}
