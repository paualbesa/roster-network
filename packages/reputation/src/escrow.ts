import type { EscrowCompletionSignal, ReputationEventInput } from "./types.js";

/** Maps an escrow completion onto a reputation event. Escrow itself is out of scope. */
export function reputationEventFromEscrow(signal: EscrowCompletionSignal): ReputationEventInput {
  return {
    outcome: signal.outcome,
    latencyMs: signal.latencyMs,
    volumeUsdc: signal.volumeUsdc,
    ...(signal.error !== undefined ? { error: signal.error } : {}),
    ...(signal.hallucination !== undefined ? { hallucination: signal.hallucination } : {}),
    ...(signal.escrowId !== undefined ? { sourceRef: signal.escrowId } : {}),
  };
}
