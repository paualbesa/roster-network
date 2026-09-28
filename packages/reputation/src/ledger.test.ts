import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyReputationEvent, emptyReputationTotals, normalizeReputationEvent, projectPassport } from "./formula.js";
import { JsonReputationLedger } from "./ledger.js";
import type { ReputationEventRecord } from "./types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("JsonReputationLedger", () => {
  it("reloads totals so a reopened ledger returns the same score", () => {
    const directory = mkdtempSync(join(tmpdir(), "roster-reputation-"));
    directories.push(directory);
    const filePath = join(directory, "reputation.json");
    const first = JsonReputationLedger.open(filePath);
    const createdAt = "2026-09-28T12:00:00.000Z";
    const normalized = normalizeReputationEvent({
      outcome: "success",
      latencyMs: 500,
      volumeUsdc: "100",
      sourceRef: "esc_1",
    });
    const totals = applyReputationEvent(emptyReputationTotals("agt_1", "org_1"), normalized, createdAt);
    const event: ReputationEventRecord = {
      id: "rev_1",
      agentId: "agt_1",
      organizationId: "org_1",
      createdAt,
      ...normalized,
    };
    first.append(totals, event);

    const reopened = JsonReputationLedger.open(filePath);
    const loaded = reopened.readTotals("agt_1");
    expect(loaded).toEqual(totals);
    expect(reopened.readEvents("agt_1")).toEqual([event]);
    expect(projectPassport(loaded ?? totals).score).toBe("84.7500");
  });
});
