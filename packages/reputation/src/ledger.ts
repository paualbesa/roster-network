import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReputationEventRecord, ReputationOutcome, ReputationTotals } from "./types.js";

const FILE_VERSION = 1;

export class ReputationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReputationStoreError";
  }
}

export interface ReputationLedger {
  readTotals(agentId: string): ReputationTotals | null;
  readEvents(agentId: string): ReputationEventRecord[];
  /** Every agent that has at least one stored total. Copies, not live records. */
  listTotals(): ReputationTotals[];
  /** Every stored event, oldest first. Copies, not live records. */
  listEvents(): ReputationEventRecord[];
  append(totals: ReputationTotals, event: ReputationEventRecord): void;
}

/** Process-local metrics. Same lifetime as the in-memory sandbox store. */
export class MemoryReputationLedger implements ReputationLedger {
  protected readonly totals = new Map<string, ReputationTotals>();
  protected readonly events: ReputationEventRecord[] = [];

  readTotals(agentId: string): ReputationTotals | null {
    const found = this.totals.get(agentId);
    return found ? cloneTotals(found) : null;
  }

  readEvents(agentId: string): ReputationEventRecord[] {
    return this.events.filter((event) => event.agentId === agentId).map(cloneEvent);
  }

  listTotals(): ReputationTotals[] {
    return [...this.totals.values()].map(cloneTotals);
  }

  listEvents(): ReputationEventRecord[] {
    return this.events.map(cloneEvent);
  }

  append(totals: ReputationTotals, event: ReputationEventRecord): void {
    if (event.agentId !== totals.agentId) {
      throw new ReputationStoreError("Reputation event agentId does not match totals.");
    }
    this.totals.set(totals.agentId, cloneTotals(totals));
    this.events.push(cloneEvent(event));
  }
}

interface ReputationFile {
  version: typeof FILE_VERSION;
  totals: ReputationTotals[];
  events: ReputationEventRecord[];
}

/**
 * JSON metrics ledger. Writes are atomic (temp file, then rename): one versioned
 * document, reloaded on open. This is the sandbox stand-in for an on-chain passport.
 */
export class JsonReputationLedger extends MemoryReputationLedger {
  private constructor(private readonly filePath: string) {
    super();
  }

  static open(filePath: string): JsonReputationLedger {
    const trimmed = filePath.trim();
    if (!trimmed) throw new ReputationStoreError("Reputation data file path is required.");
    const ledger = new JsonReputationLedger(trimmed);
    ledger.load();
    return ledger;
  }

  override append(totals: ReputationTotals, event: ReputationEventRecord): void {
    super.append(totals, event);
    this.write();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unreadable";
      throw new ReputationStoreError(`Could not read reputation data file: ${message}`);
    }
    const document = parseDocument(parsed);
    for (const totals of document.totals) {
      if (this.totals.has(totals.agentId)) {
        throw new ReputationStoreError(`Duplicate reputation totals for ${totals.agentId}.`);
      }
      this.totals.set(totals.agentId, totals);
    }
    for (const event of document.events) {
      if (!this.totals.has(event.agentId)) {
        throw new ReputationStoreError(`Reputation event ${event.id} has no totals for ${event.agentId}.`);
      }
      this.events.push(event);
    }
  }

  private write(): void {
    const document: ReputationFile = {
      version: FILE_VERSION,
      totals: [...this.totals.values()].map(cloneTotals),
      events: this.events.map(cloneEvent),
    };
    const json = `${JSON.stringify(document, null, 2)}\n`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid.toString()}.tmp`;
    writeFileSync(temporary, json, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

function cloneTotals(totals: ReputationTotals): ReputationTotals {
  return { ...totals };
}

function cloneEvent(event: ReputationEventRecord): ReputationEventRecord {
  return { ...event };
}

function parseDocument(value: unknown): ReputationFile {
  if (!isRecord(value) || value.version !== FILE_VERSION) {
    throw new ReputationStoreError("Reputation data file must be version 1.");
  }
  return {
    version: FILE_VERSION,
    totals: parseTotals(value.totals),
    events: parseEvents(value.events),
  };
}

function parseTotals(value: unknown): ReputationTotals[] {
  if (!Array.isArray(value)) throw new ReputationStoreError("totals must be an array.");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ReputationStoreError(`totals[${index.toString()}] must be an object.`);
    const agentId = requiredString(item.agentId, `totals[${index.toString()}].agentId`);
    const organizationId = requiredString(item.organizationId, `totals[${index.toString()}].organizationId`);
    const updatedAt = item.updatedAt;
    if (updatedAt !== null && typeof updatedAt !== "string") {
      throw new ReputationStoreError(`totals[${index.toString()}].updatedAt must be a string or null.`);
    }
    return {
      agentId,
      organizationId,
      eventCount: requiredCount(item.eventCount, `totals[${index.toString()}].eventCount`),
      successCount: requiredCount(item.successCount, `totals[${index.toString()}].successCount`),
      failureCount: requiredCount(item.failureCount, `totals[${index.toString()}].failureCount`),
      errorCount: requiredCount(item.errorCount, `totals[${index.toString()}].errorCount`),
      hallucinationCount: requiredCount(item.hallucinationCount, `totals[${index.toString()}].hallucinationCount`),
      latencyTotalMs: requiredCount(item.latencyTotalMs, `totals[${index.toString()}].latencyTotalMs`),
      volumeSettledUsdc: requiredString(item.volumeSettledUsdc, `totals[${index.toString()}].volumeSettledUsdc`),
      updatedAt,
    };
  });
}

function parseEvents(value: unknown): ReputationEventRecord[] {
  if (!Array.isArray(value)) throw new ReputationStoreError("events must be an array.");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ReputationStoreError(`events[${index.toString()}] must be an object.`);
    const outcome = item.outcome;
    if (outcome !== "success" && outcome !== "failure") {
      throw new ReputationStoreError(`events[${index.toString()}].outcome is invalid.`);
    }
    const sourceRef = item.sourceRef;
    if (sourceRef !== null && typeof sourceRef !== "string") {
      throw new ReputationStoreError(`events[${index.toString()}].sourceRef must be a string or null.`);
    }
    return {
      id: requiredString(item.id, `events[${index.toString()}].id`),
      agentId: requiredString(item.agentId, `events[${index.toString()}].agentId`),
      organizationId: requiredString(item.organizationId, `events[${index.toString()}].organizationId`),
      outcome: outcome as ReputationOutcome,
      latencyMs: requiredCount(item.latencyMs, `events[${index.toString()}].latencyMs`),
      volumeUsdc: requiredString(item.volumeUsdc, `events[${index.toString()}].volumeUsdc`),
      error: requiredBoolean(item.error, `events[${index.toString()}].error`),
      hallucination: requiredBoolean(item.hallucination, `events[${index.toString()}].hallucination`),
      sourceRef,
      createdAt: requiredString(item.createdAt, `events[${index.toString()}].createdAt`),
    };
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReputationStoreError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ReputationStoreError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ReputationStoreError(`${label} must be a boolean.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
