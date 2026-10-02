import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockWalletProvider } from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { MemoryReputationLedger, projectPassport } from "@albesa/reputation";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { sandboxReceiptListing } from "../catalog.js";
import { MemoryJobStore } from "../jobs.js";
import { AgentFinanceService } from "../service.js";
import { MemoryStore } from "../store.js";
import { readSupabaseConfig } from "./env.js";
import type { RosterTableClient } from "./mirror.js";
import { SupabaseMirror } from "./mirror.js";
import { DELETE_ORDER, rowsToSnapshot } from "./rows.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const totalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["total"],
  properties: { total: { type: "string", minLength: 1 } },
};

class MemoryTables implements RosterTableClient {
  private readonly tables = new Map<string, Record<string, unknown>[]>();

  async selectAll(table: string): Promise<Record<string, unknown>[]> {
    return (this.tables.get(table) ?? []).map((row) => structuredClone(row));
  }

  async upsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    const key = primaryKey(table);
    const current = new Map<string, Record<string, unknown>>();
    for (const row of this.tables.get(table) ?? []) current.set(String(row[key]), row);
    for (const row of rows) {
      const id = row[key];
      if (typeof id !== "string" || id.length === 0) throw new Error(`${table} row is missing ${key}.`);
      current.set(id, structuredClone(row));
    }
    this.tables.set(table, [...current.values()]);
  }

  async deleteIds(table: string, column: string, ids: string[]): Promise<void> {
    const drop = new Set(ids);
    const kept = (this.tables.get(table) ?? []).filter((row) => !drop.has(String(row[column])));
    this.tables.set(table, kept);
  }

  async matchCapabilities(): Promise<{ id: string; similarity: number }[]> {
    return [];
  }
}

function primaryKey(table: string): string {
  const found = DELETE_ORDER.find((entry) => entry.table === table);
  if (!found) throw new Error(`No primary key for ${table}.`);
  return found.column;
}

function openMirroredApp(now: () => Date) {
  const store = new MemoryStore();
  const jobs = new MemoryJobStore();
  const reputation = new MemoryReputationLedger();
  const registry = new CapabilityRegistry();
  const io = new MemoryTables();
  const mirror = new SupabaseMirror(io, store, jobs, reputation, registry);
  mirror.attach();
  const service = new AgentFinanceService({
    mode: "sandbox",
    wallets: new MockWalletProvider(),
    store,
    reputation,
    now,
  });
  const app = createApp({
    mode: "sandbox",
    now,
    service,
    jobs,
    registry,
    supabase: {
      verifyAccessToken: async () => null,
      flush: () => mirror.flush(),
    },
  });
  return { app, io };
}

async function organization(app: ReturnType<typeof createApp>, name: string) {
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { apiKey: string; organization: { id: string } };
  return {
    organizationId: body.organization.id,
    auth: { authorization: `Bearer ${body.apiKey}`, "content-type": "application/json" },
  };
}

describe("reputation passport postgres", () => {
  it("persists settle, validation failure, and timeout, then reloads the passport from columns", async () => {
    let current = Date.parse("2026-10-02T12:00:00.000Z");
    const { app, io } = openMirroredApp(() => new Date(current));
    const org = await organization(app, "Harbor");
    const buyer = await app.request("/v1/agents", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ name: "buyer", dailySpendLimitUsdc: "10.00", vendorAllowlist: [] }),
    });
    const seller = await app.request("/v1/agents", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ name: "seller", dailySpendLimitUsdc: "10.00", vendorAllowlist: [] }),
    });
    const buyerId = ((await buyer.json()) as { agent: { id: string } }).agent.id;
    const sellerId = ((await seller.json()) as { agent: { id: string } }).agent.id;
    const funded = await app.request(`/v1/agents/${buyerId}/fund`, {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ amountUsdc: "3.00" }),
    });
    expect(funded.status).toBe(200);

    const published = await app.request("/v1/registry/listings", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify(sandboxReceiptListing()),
    });
    expect(published.status).toBe(201);
    const listingId = ((await published.json()) as { listing: { id: string } }).listing.id;
    const bound = await app.request(`/v1/jobs/listings/${listingId}/seller`, {
      method: "PUT",
      headers: org.auth,
      body: JSON.stringify({ sellerAgentId: sellerId }),
    });
    expect(bound.status).toBe(200);

    async function lockJob() {
      const created = await app.request("/v1/jobs", {
        method: "POST",
        headers: org.auth,
        body: JSON.stringify({
          buyerAgentId: buyerId,
          query: "parse receipts",
          amountUsdc: "1.00",
          schema: totalSchema,
          tags: ["receipt"],
        }),
      });
      expect(created.status).toBe(201);
      return ((await created.json()) as { job: { id: string } }).job.id;
    }

    const releasedId = await lockJob();
    const released = await app.request(`/v1/jobs/${releasedId}/result`, {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ result: { total: "4.00" }, latencyMs: 500 }),
    });
    expect(released.status).toBe(200);
    expect(((await released.json()) as { job: { status: string } }).job.status).toBe("released");

    const failedId = await lockJob();
    const failed = await app.request(`/v1/jobs/${failedId}/result`, {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ result: { total: 1 }, latencyMs: 900 }),
    });
    expect(failed.status).toBe(200);
    expect(((await failed.json()) as { job: { status: string } }).job.status).toBe("refunded");

    const heldId = await lockJob();
    current += 400;
    const expired = await app.request("/v1/jobs/expire", { method: "POST", headers: org.auth });
    expect(expired.status).toBe(200);
    const timedOut = ((await expired.json()) as { jobs: { id: string; status: string }[] }).jobs;
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({ id: heldId, status: "timed_out" });

    const totals = await io.selectAll("reputation_totals");
    const events = await io.selectAll("reputation_events");
    expect(totals).toHaveLength(1);
    expect(events.map((event) => event.outcome)).toEqual(["success", "failure", "failure"]);
    expect(events.map((event) => event.is_error)).toEqual([false, true, true]);
    expect(events.map((event) => event.latency_ms)).toEqual([500, 900, 400]);
    expect(events.map((event) => event.volume_usdc)).toEqual(["1.000000", "1.000000", "1.000000"]);
    expect(events.every((event) => event.hallucination === false)).toBe(true);
    expect(events.every((event) => event.agent_id === sellerId && event.organization_id === org.organizationId)).toBe(
      true,
    );

    const row = totals[0];
    expect(row).toMatchObject({
      agent_id: sellerId,
      organization_id: org.organizationId,
      event_count: 3,
      success_count: 1,
      failure_count: 2,
      error_count: 2,
      hallucination_count: 0,
      volume_settled_usdc: "1.000000",
    });

    const restored = rowsToSnapshot({
      reputation_totals: totals,
      reputation_events: events,
    });
    const ledger = new MemoryReputationLedger();
    ledger.replaceAll(restored.reputationTotals, restored.reputationEvents);
    const totalsRow = restored.reputationTotals[0];
    expect(totalsRow).toBeTruthy();
    const passport = projectPassport(totalsRow!);
    expect(row?.success_rate).toBe(passport.metrics.successRate);
    expect(row?.avg_latency_ms).toBe(passport.metrics.avgLatencyMs);
    expect(row?.error_index).toBe(passport.metrics.errorIndex);
    expect(row?.score).toBe(passport.score);
    expect(passport.metrics.volumeSettledUsdc).toBe("1.000000");
    expect(passport.metrics.successRate).toBe("0.333333");

    const served = await app.request(`/v1/agents/${sellerId}/passport`, { headers: org.auth });
    expect(served.status).toBe(200);
    expect(((await served.json()) as { passport: { score: string } }).passport.score).toBe(passport.score);
  });

  it("keeps the JSON ledger when Supabase is unset", async () => {
    expect(readSupabaseConfig({})).toBeNull();
    const directory = mkdtempSync(join(tmpdir(), "roster-reputation-fallback-"));
    directories.push(directory);
    const dataFile = join(directory, "sandbox.json");
    const reputationFile = join(directory, "reputation.json");
    const boot = () => createApp({ mode: "sandbox", dataFile, reputationFile });
    const app = boot();
    const org = await organization(app, "Fallback");
    const created = await app.request("/v1/agents", {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ name: "seller", dailySpendLimitUsdc: "10.00", vendorAllowlist: [] }),
    });
    const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
    const recorded = await app.request(`/v1/agents/${agentId}/reputation/events`, {
      method: "POST",
      headers: org.auth,
      body: JSON.stringify({ outcome: "success", latencyMs: 500, volumeUsdc: "100", sourceRef: "job_1" }),
    });
    expect(recorded.status).toBe(201);

    const document = JSON.parse(readFileSync(reputationFile, "utf8")) as {
      version: number;
      totals: { volumeSettledUsdc: string }[];
      events: { outcome: string }[];
    };
    expect(document.version).toBe(1);
    expect(document.totals[0]?.volumeSettledUsdc).toBe("100.000000");
    expect(document.events[0]?.outcome).toBe("success");

    const reloaded = boot();
    const passport = await reloaded.request(`/v1/agents/${agentId}/passport`, { headers: org.auth });
    expect(passport.status).toBe(200);
    expect(((await passport.json()) as { passport: { score: string } }).passport.score).toBe("84.7500");
  });
});
