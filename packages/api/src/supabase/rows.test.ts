import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Organization, UserAccount, Wallet } from "@albesa/core";
import { SEMANTIC_DIMENSIONS } from "@albesa/registry";
import { projectPassport, type ReputationEventRecord, type ReputationTotals } from "@albesa/reputation";
import { describe, expect, it } from "vitest";
import { emptySnapshot, rowsToSnapshot, snapshotToRows } from "./rows.js";

describe("Supabase row mapping", () => {
  it("round-trips an organization, a linked profile, and the wallet snapshot", () => {
    const organization: Organization = {
      id: "org_1",
      name: "Ada",
      treasuryWalletId: "wal_1",
      mode: "sandbox",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const user: UserAccount = {
      id: "usr_1",
      email: "ada@example.com",
      displayName: "Ada",
      organizationId: organization.id,
      createdAt: organization.createdAt,
    };
    const wallet: Wallet = {
      id: "wal_1",
      organizationId: organization.id,
      ownerType: "organization",
      ownerId: organization.id,
      address: "mock:treasury:org_1",
      chain: "mock",
      asset: "USDC",
      createdAt: organization.createdAt,
    };
    const snapshot = emptySnapshot();
    snapshot.organizations.push(organization);
    snapshot.users.push(user);
    snapshot.authLinks.push({ authUserId: "00000000-0000-4000-8000-000000000001", userId: user.id });
    snapshot.wallets.push(wallet);
    snapshot.wallet = {
      balances: [{ address: wallet.address, balanceUsdc: "1000.000000" }],
      sequence: 3,
      networkFeesCollectedUsdc: "0.000001",
    };
    snapshot.embeddings.cap_1 = `[${new Array(SEMANTIC_DIMENSIONS).fill("0").join(",")}]`;

    const rows = snapshotToRows(snapshot);
    const restored = rowsToSnapshot(rows);
    expect(restored.organizations).toEqual(snapshot.organizations);
    expect(restored.users).toEqual(snapshot.users);
    expect(restored.authLinks).toEqual(snapshot.authLinks);
    expect(restored.wallets).toEqual(snapshot.wallets);
    expect(restored.wallet).toEqual(snapshot.wallet);
    expect(rows.wallet_balances).toEqual([
      { address: wallet.address, organization_id: organization.id, balance_usdc: "1000.000000" },
    ]);
    expect(rows.password_hashes).toEqual([]);
    expect(rows.api_key_hashes).toEqual([]);
  });

  it("stores passport metrics in columns and still reads a body-only row", () => {
    const totals: ReputationTotals = {
      agentId: "agt_seller",
      organizationId: "org_1",
      eventCount: 1,
      successCount: 1,
      failureCount: 0,
      errorCount: 0,
      hallucinationCount: 0,
      latencyTotalMs: 500,
      volumeSettledUsdc: "100.000000",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    const event: ReputationEventRecord = {
      id: "rev_1",
      agentId: totals.agentId,
      organizationId: totals.organizationId,
      outcome: "success",
      latencyMs: 500,
      volumeUsdc: "100.000000",
      error: false,
      hallucination: false,
      sourceRef: "esc_1",
      createdAt: totals.updatedAt ?? "",
    };
    const snapshot = emptySnapshot();
    snapshot.reputationTotals.push(totals);
    snapshot.reputationEvents.push(event);

    const rows = snapshotToRows(snapshot);
    const passport = projectPassport(totals);
    const totalsRow = rows.reputation_totals?.[0];
    const eventRow = rows.reputation_events?.[0];
    expect(totalsRow).toMatchObject({
      agent_id: "agt_seller",
      organization_id: "org_1",
      event_count: 1,
      success_count: 1,
      failure_count: 0,
      volume_settled_usdc: "100.000000",
      success_rate: "1.000000",
      avg_latency_ms: "500.000",
      error_index: "0.000000",
      score: passport.score,
    });
    expect(eventRow).toMatchObject({
      id: "rev_1",
      agent_id: "agt_seller",
      organization_id: "org_1",
      outcome: "success",
      latency_ms: 500,
      volume_usdc: "100.000000",
      is_error: false,
      hallucination: false,
      source_ref: "esc_1",
    });
    expect(passport.score).toBe("84.7500");
    if (!totalsRow || !eventRow) throw new Error("passport rows missing");

    const stale = {
      ...totalsRow,
      body: { ...totals, successCount: 0, volumeSettledUsdc: "0.000000" },
    };
    const restored = rowsToSnapshot({
      reputation_totals: [stale],
      reputation_events: rows.reputation_events ?? [],
    });
    expect(restored.reputationTotals).toEqual([totals]);
    expect(restored.reputationEvents).toEqual([event]);

    const legacy = rowsToSnapshot({
      reputation_totals: [
        {
          agent_id: totals.agentId,
          organization_id: totals.organizationId,
          body: totals,
        },
      ],
      reputation_events: [
        {
          id: event.id,
          organization_id: event.organizationId,
          agent_id: event.agentId,
          body: event,
        },
      ],
    });
    expect(legacy.reputationTotals).toEqual([totals]);
    expect(legacy.reputationEvents).toEqual([event]);
  });
});

describe("reputation passport migration", () => {
  it("adds metric columns without secrets or a chain write", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const sql = readFileSync(join(root, "supabase/migrations/20261002120000_reputation_passport.sql"), "utf8");
    expect(sql).toContain("volume_settled_usdc");
    expect(sql).toContain("success_rate");
    expect(sql).toContain("avg_latency_ms");
    expect(sql).toContain("error_index");
    expect(sql).toContain("reputation_events_outcome_check");
    expect(sql).toContain("reputation_events_agent_outcome_idx");
    expect(sql).not.toContain("disable row level security");
    expect(sql).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(sql).not.toContain("mainnet");
    expect(sql.toLowerCase()).not.toContain("private key");
  });
});
