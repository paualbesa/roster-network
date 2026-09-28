import type { RuntimeMode } from "./types.js";

export function resolveRuntimeMode(
  env: Record<string, string | undefined> = process.env,
): RuntimeMode {
  const raw = env.ALBESA_MODE ?? "sandbox";
  if (raw === "sandbox" || raw === "testnet") return raw;
  if (raw === "mainnet") {
    throw new Error(
      "ALBESA_MODE=mainnet is disabled. This build only runs sandbox and testnet mock rails.",
    );
  }
  throw new Error(`Unsupported ALBESA_MODE "${raw}". Use "sandbox" or "testnet".`);
}
