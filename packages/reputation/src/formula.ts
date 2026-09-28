import { addUsdc, formatUsdc, parseUsdc } from "@albesa/core";
import {
  PASSPORT_FORMULA,
  PASSPORT_LATENCY_BUDGET_MS,
  PASSPORT_VOLUME_REFERENCE_USDC,
  type NormalizedReputationEvent,
  type ReputationEventInput,
  type ReputationPassport,
  type ReputationTotals,
} from "./types.js";

const MICRO = 1_000_000n;
const MAX_LATENCY_MS = 86_400_000;
const SOURCE_REF_MAX = 128;

export class ReputationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReputationInputError";
  }
}

export function emptyReputationTotals(agentId: string, organizationId: string): ReputationTotals {
  return {
    agentId,
    organizationId,
    eventCount: 0,
    successCount: 0,
    failureCount: 0,
    errorCount: 0,
    hallucinationCount: 0,
    latencyTotalMs: 0,
    volumeSettledUsdc: "0.000000",
    updatedAt: null,
  };
}

export function normalizeReputationEvent(input: ReputationEventInput): NormalizedReputationEvent {
  if (input.outcome !== "success" && input.outcome !== "failure") {
    throw new ReputationInputError('outcome must be "success" or "failure".');
  }
  if (!Number.isInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > MAX_LATENCY_MS) {
    throw new ReputationInputError(`latencyMs must be an integer from 0 to ${MAX_LATENCY_MS.toString()}.`);
  }
  let volumeUsdc: string;
  try {
    const micros = parseUsdc(input.volumeUsdc);
    if (micros < 0n) throw new Error("negative");
    volumeUsdc = formatUsdc(parseUsdc(input.volumeUsdc));
  } catch {
    throw new ReputationInputError("volumeUsdc must be a non-negative USDC amount with up to 6 decimal places.");
  }
  if (input.error !== undefined && typeof input.error !== "boolean") {
    throw new ReputationInputError("error must be a boolean.");
  }
  if (input.hallucination !== undefined && typeof input.hallucination !== "boolean") {
    throw new ReputationInputError("hallucination must be a boolean.");
  }
  return {
    outcome: input.outcome,
    latencyMs: input.latencyMs,
    volumeUsdc,
    error: input.error ?? false,
    hallucination: input.hallucination ?? false,
    sourceRef: normalizeSourceRef(input.sourceRef),
  };
}

export function applyReputationEvent(
  totals: ReputationTotals,
  event: NormalizedReputationEvent,
  updatedAt: string,
): ReputationTotals {
  const success = event.outcome === "success";
  return {
    agentId: totals.agentId,
    organizationId: totals.organizationId,
    eventCount: totals.eventCount + 1,
    successCount: totals.successCount + (success ? 1 : 0),
    failureCount: totals.failureCount + (success ? 0 : 1),
    errorCount: totals.errorCount + (event.error ? 1 : 0),
    hallucinationCount: totals.hallucinationCount + (event.hallucination ? 1 : 0),
    latencyTotalMs: totals.latencyTotalMs + event.latencyMs,
    volumeSettledUsdc: success ? addUsdc(totals.volumeSettledUsdc, event.volumeUsdc) : totals.volumeSettledUsdc,
    updatedAt,
  };
}

export function projectPassport(totals: ReputationTotals): ReputationPassport {
  const parts = scoreParts(totals);
  return {
    agentId: totals.agentId,
    organizationId: totals.organizationId,
    formula: PASSPORT_FORMULA,
    score: formatFixed(parts.scoreUnits, 4),
    components: {
      successRate: formatMicros(parts.successMicros),
      latencyFactor: formatMicros(parts.latencyMicros),
      reliabilityFactor: formatMicros(parts.reliabilityMicros),
      volumeFactor: formatMicros(parts.volumeMicros),
    },
    metrics: {
      eventCount: totals.eventCount,
      successCount: totals.successCount,
      failureCount: totals.failureCount,
      errorCount: totals.errorCount,
      hallucinationCount: totals.hallucinationCount,
      latencyTotalMs: totals.latencyTotalMs,
      volumeSettledUsdc: totals.volumeSettledUsdc,
      avgLatencyMs: formatAvgLatency(totals.latencyTotalMs, totals.eventCount),
      successRate: formatMicros(parts.successMicros),
      errorIndex: formatMicros(parts.errorMicros),
    },
    updatedAt: totals.updatedAt,
  };
}

interface ScoreParts {
  successMicros: bigint;
  latencyMicros: bigint;
  reliabilityMicros: bigint;
  volumeMicros: bigint;
  errorMicros: bigint;
  scoreUnits: bigint;
}

function scoreParts(totals: ReputationTotals): ScoreParts {
  if (totals.eventCount === 0) {
    return {
      successMicros: 0n,
      latencyMicros: 0n,
      reliabilityMicros: 0n,
      volumeMicros: 0n,
      errorMicros: 0n,
      scoreUnits: 0n,
    };
  }
  const count = BigInt(totals.eventCount);
  const successMicros = (BigInt(totals.successCount) * MICRO) / count;
  const budget = BigInt(PASSPORT_LATENCY_BUDGET_MS) * count;
  const latencyTotal = BigInt(totals.latencyTotalMs);
  const latencyMicros = latencyTotal >= budget ? 0n : ((budget - latencyTotal) * MICRO) / budget;
  const errorRaw = (BigInt(totals.errorCount + totals.hallucinationCount) * MICRO) / count;
  const errorMicros = errorRaw > MICRO ? MICRO : errorRaw;
  const reliabilityMicros = MICRO - errorMicros;
  const volume = parseUsdc(totals.volumeSettledUsdc);
  const reference = parseUsdc(PASSPORT_VOLUME_REFERENCE_USDC);
  const volumeMicros = volume >= reference ? MICRO : (volume * MICRO) / reference;
  const weighted =
    successMicros * 45n + latencyMicros * 25n + reliabilityMicros * 20n + volumeMicros * 10n;
  return {
    successMicros,
    latencyMicros,
    reliabilityMicros,
    volumeMicros,
    errorMicros,
    scoreUnits: weighted / 100n,
  };
}

function normalizeSourceRef(sourceRef: string | null | undefined): string | null {
  if (sourceRef === undefined || sourceRef === null) return null;
  if (typeof sourceRef !== "string") {
    throw new ReputationInputError("sourceRef must be a string.");
  }
  const trimmed = sourceRef.trim();
  if (!trimmed) return null;
  if (trimmed.length > SOURCE_REF_MAX) {
    throw new ReputationInputError(`sourceRef must be at most ${SOURCE_REF_MAX.toString()} characters.`);
  }
  return trimmed;
}

function formatMicros(micros: bigint): string {
  return formatFixed(micros, 6);
}

function formatFixed(units: bigint, places: number): string {
  const scale = 10n ** BigInt(places);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(places, "0");
  return `${whole.toString()}.${fraction}`;
}

function formatAvgLatency(totalMs: number, count: number): string {
  if (count === 0) return "0.000";
  const thousandths = (BigInt(totalMs) * 1000n) / BigInt(count);
  return formatFixed(thousandths, 3);
}
