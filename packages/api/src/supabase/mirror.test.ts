import { MockWalletProvider } from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { MemoryReputationLedger } from "@albesa/reputation";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { MemoryJobStore } from "../jobs.js";
import { AgentFinanceService } from "../service.js";
import { MemoryStore } from "../store.js";
import type { RosterTableClient } from "./mirror.js";
import { SupabaseMirror } from "./mirror.js";
import { DELETE_ORDER, rowsToSnapshot, UPSERT_ORDER } from "./rows.js";

/** Counts rows written so the test can tell a full rewrite from a delta. */
class CountingTables implements RosterTableClient {
  readonly tables = new Map<string, Record<string, unknown>[]>();
  upserted = 0;
  selects = 0;

  async selectAll(table: string): Promise<Record<string, unknown>[]> {
    this.selects += 1;
    return (this.tables.get(table) ?? []).map((row) => structuredClone(row));
  }

  async upsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    this.upserted += rows.length;
    const key = DELETE_ORDER.find((entry) => entry.table === table)?.column ?? "id";
    const current = new Map<string, Record<string, unknown>>();
    for (const row of this.tables.get(table) ?? []) current.set(String(row[key]), row);
    for (const row of rows) current.set(String(row[key]), structuredClone(row));
    this.tables.set(table, [...current.values()]);
  }

  async deleteIds(table: string, column: string, ids: string[]): Promise<void> {
    const drop = new Set(ids);
    this.tables.set(
      table,
      (this.tables.get(table) ?? []).filter((row) => !drop.has(String(row[column]))),
    );
  }

  async matchCapabilities(): Promise<{ id: string; similarity: number }[]> {
    return [];
  }
}

function open() {
  const store = new MemoryStore();
  const jobs = new MemoryJobStore();
  const reputation = new MemoryReputationLedger();
  const registry = new CapabilityRegistry();
  const io = new CountingTables();
  const mirror = new SupabaseMirror(io, store, jobs, reputation, registry);
  mirror.attach();
  const service = new AgentFinanceService({ mode: "sandbox", wallets: new MockWalletProvider(), store, reputation });
  const app = createApp({ mode: "sandbox", service, jobs, registry, supabase: {
    verifyAccessToken: async () => null,
    flush: () => mirror.flush(),
  } });
  return { app, io, mirror, store };
}

describe("incremental Supabase mirror", () => {
  it("writes only changed rows after the first flush and still deletes orphans", async () => {
    const { app, io, mirror } = open();
    for (const name of ["Acme", "Harbor", "Drift"]) {
      const response = await app.request("/v1/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(201);
    }
    const before = io.upserted;
    const selectsBefore = io.selects;

    const login = await app.request("/v1/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    expect(login.status).toBe(202);
    expect(mirror.lastWriteStats.full).toBe(false);
    // One waitlist row, not every organization, wallet, and ledger entry again.
    expect(io.upserted - before).toBe(1);
    expect(io.selects).toBe(selectsBefore);

    const signup = await app.request("/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Temp" }),
    });
    const apiKey = ((await signup.json()) as { apiKey: string }).apiKey;
    const keysBefore = (io.tables.get("api_key_hashes") ?? []).length;
    const revoke = await app.request("/v1/account/api-key", {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(revoke.status).toBe(200);
    expect((io.tables.get("api_key_hashes") ?? []).length).toBe(keysBefore - 1);
    expect(mirror.lastWriteStats.deleted).toBe(1);

    // The tables reload into the same state the process holds.
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of UPSERT_ORDER) tables[table] = io.tables.get(table) ?? [];
    const snapshot = rowsToSnapshot(tables);
    expect(snapshot.organizations).toHaveLength(4);
    expect(snapshot.waitlist.map((entry) => entry.email)).toEqual(["ada@example.com"]);
  });
});
