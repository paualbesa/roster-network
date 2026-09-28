export const PASSPORT_FORMULA_ID = "roster.passport.v1";

export const PASSPORT_WEIGHTS = {
  success: 0.45,
  latency: 0.25,
  reliability: 0.2,
  volume: 0.1,
} as const;

/** Latency at or above this budget contributes nothing to the score. */
export const PASSPORT_LATENCY_BUDGET_MS = 2000;

/** Settled volume at or above this amount fills the volume term. */
export const PASSPORT_VOLUME_REFERENCE_USDC = "1000.000000";

export const PASSPORT_FORMULA_EXPRESSION =
  "score = 100 * (0.45*successRate + 0.25*latencyFactor + 0.20*(1-errorIndex) + 0.10*volumeFactor)";

/**
 * Sandbox reputation score. Not an on-chain value.
 *
 * successRate = successCount / eventCount
 * errorIndex = min(1, (errorCount + hallucinationCount) / eventCount)
 * latencyFactor = max(0, 1 - avgLatencyMs / 2000)
 * volumeFactor = min(1, volumeSettledUsdc / 1000)
 *
 * volumeSettledUsdc grows only when outcome is "success".
 * With zero events every term is 0 and the score is 0.
 * Each rate is floored to 1e-6. The score is floored to 4 decimal places.
 */
export const PASSPORT_FORMULA = {
  id: PASSPORT_FORMULA_ID,
  expression: PASSPORT_FORMULA_EXPRESSION,
  weights: PASSPORT_WEIGHTS,
  latencyBudgetMs: PASSPORT_LATENCY_BUDGET_MS,
  volumeReferenceUsdc: PASSPORT_VOLUME_REFERENCE_USDC,
  rounding: "Rates are floored to 1e-6. The score is floored to 4 decimal places.",
} as const;

export type ReputationOutcome = "success" | "failure";

export interface ReputationEventInput {
  outcome: ReputationOutcome;
  /** Milliseconds from request start to validated delivery. */
  latencyMs: number;
  /** USDC attributed to the job. Added to settled volume only on success. */
  volumeUsdc: string;
  error?: boolean;
  hallucination?: boolean;
  /** Caller or escrow id. Stored, not scored. */
  sourceRef?: string | null;
}

export interface NormalizedReputationEvent {
  outcome: ReputationOutcome;
  latencyMs: number;
  volumeUsdc: string;
  error: boolean;
  hallucination: boolean;
  sourceRef: string | null;
}

export interface ReputationTotals {
  agentId: string;
  organizationId: string;
  eventCount: number;
  successCount: number;
  failureCount: number;
  errorCount: number;
  hallucinationCount: number;
  latencyTotalMs: number;
  volumeSettledUsdc: string;
  updatedAt: string | null;
}

export interface ReputationEventRecord extends NormalizedReputationEvent {
  id: string;
  agentId: string;
  organizationId: string;
  createdAt: string;
}

export interface ReputationPassport {
  agentId: string;
  organizationId: string;
  formula: typeof PASSPORT_FORMULA;
  /** "0.0000" through "100.0000". */
  score: string;
  components: {
    successRate: string;
    latencyFactor: string;
    reliabilityFactor: string;
    volumeFactor: string;
  };
  metrics: {
    eventCount: number;
    successCount: number;
    failureCount: number;
    errorCount: number;
    hallucinationCount: number;
    latencyTotalMs: number;
    volumeSettledUsdc: string;
    avgLatencyMs: string;
    successRate: string;
    errorIndex: string;
  };
  updatedAt: string | null;
}

/**
 * Signal a future escrow package can emit when a job releases or fails.
 * This slice does not settle escrow; it only accepts the completion signal.
 */
export interface EscrowCompletionSignal {
  organizationId: string;
  agentId: string;
  outcome: ReputationOutcome;
  latencyMs: number;
  volumeUsdc: string;
  error?: boolean;
  hallucination?: boolean;
  escrowId?: string;
}

export interface ReputationHook {
  recordEscrowCompletion(signal: EscrowCompletionSignal): Promise<ReputationPassport>;
}
