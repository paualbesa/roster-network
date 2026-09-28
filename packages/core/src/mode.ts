import type { RuntimeMode } from "./types.js";

function readMode(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/**
 * `ROSTER_MODE` is the product name for the runtime switch.
 * `ALBESA_MODE` is the same switch and remains accepted.
 * When both are set they must match. `mainnet` is refused on either name.
 */
export function resolveRuntimeMode(
  env: Record<string, string | undefined> = process.env,
): RuntimeMode {
  const roster = readMode(env, "ROSTER_MODE");
  const albesa = readMode(env, "ALBESA_MODE");
  if (roster !== undefined && albesa !== undefined && roster !== albesa) {
    throw new Error(
      `ROSTER_MODE (${roster}) and ALBESA_MODE (${albesa}) disagree. Set only one, or set them to the same value.`,
    );
  }
  const raw = roster ?? albesa ?? "sandbox";
  if (raw === "sandbox" || raw === "testnet") return raw;
  if (raw === "mainnet") {
    throw new Error(
      "mainnet is disabled. ROSTER_MODE and ALBESA_MODE only accept sandbox and testnet mock rails.",
    );
  }
  throw new Error(
    `Unsupported runtime mode "${raw}". Set ROSTER_MODE or ALBESA_MODE to "sandbox" or "testnet".`,
  );
}
