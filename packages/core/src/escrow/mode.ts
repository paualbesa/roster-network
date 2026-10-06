import { ESCROW_MODES, type EscrowMode } from "./types.js";

/**
 * `ROSTER_ESCROW_MODE` selects the escrow custody model. Unset is `custodial-mock`.
 * `custodial-mock` / `noncustodial-sim` stay on sandbox rails.
 * `noncustodial-devnet` uses the on-chain program (see docs/ESCROW_NON_CUSTODIAL.md).
 */
export function resolveEscrowMode(env: Record<string, string | undefined> = process.env): EscrowMode {
  const raw = env.ROSTER_ESCROW_MODE?.trim();
  if (!raw) return "custodial-mock";
  if ((ESCROW_MODES as readonly string[]).includes(raw)) return raw as EscrowMode;
  throw new Error(`Unsupported ROSTER_ESCROW_MODE "${raw}". Use ${ESCROW_MODES.join(" or ")}.`);
}
