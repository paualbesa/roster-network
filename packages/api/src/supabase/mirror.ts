import type { MockWalletSnapshot } from "@albesa/core";
import type { CapabilityRegistry } from "@albesa/registry";
import { MemoryReputationLedger, type ReputationLedger } from "@albesa/reputation";
import type { MemoryJobStore } from "../jobs.js";
import type { MemoryStore } from "../store.js";
import {
  DELETE_ORDER,
  UPSERT_ORDER,
  captureSnapshot,
  snapshotToRows,
  type RosterSnapshot,
} from "./rows.js";

export interface RosterTableClient {
  selectAll(table: string): Promise<Record<string, unknown>[]>;
  upsert(table: string, rows: Record<string, unknown>[]): Promise<void>;
  deleteIds(table: string, column: string, ids: string[]): Promise<void>;
  matchCapabilities(literal: string, limit: number): Promise<{ id: string; similarity: number }[]>;
}

const CHUNK = 40;

/**
 * In-memory stores stay the working set. Postgres is written after each
 * committed mutation when Supabase env is set. JSON files are not touched.
 */
export class SupabaseMirror {
  private wallet: MockWalletSnapshot = { balances: [], sequence: 0 };
  private sandboxDirty = false;
  private jobsDirty = false;
  private reputationDirty = false;
  private registryDirty = false;
  private tail: Promise<void> = Promise.resolve();
  /**
   * Fingerprint of every row this process last wrote, per table and key.
   * `null` until the first successful write, and again after a failed one,
   * so the next flush falls back to a full upsert and a full orphan scan.
   */
  private written: Map<string, Map<string, string>> | null = null;
  /** Rows sent by the last flush. Tests and logs read it. */
  lastWriteStats: { upserted: number; deleted: number; full: boolean } = { upserted: 0, deleted: 0, full: true };

  constructor(
    private readonly io: RosterTableClient,
    private readonly store: MemoryStore,
    private readonly jobs: MemoryJobStore,
    private readonly reputation: MemoryReputationLedger,
    private readonly registry: CapabilityRegistry,
  ) {}

  rememberWallet(wallet: MockWalletSnapshot): void {
    this.wallet = cloneWallet(wallet);
  }

  attach(): void {
    this.store.onCommit = (wallet) => {
      if (wallet) this.wallet = cloneWallet(wallet);
      this.sandboxDirty = true;
    };
    this.jobs.onChange = () => {
      this.jobsDirty = true;
    };
    this.reputation.onAppend = () => {
      this.reputationDirty = true;
    };
    this.registry.onPersist = () => {
      this.registryDirty = true;
    };
  }

  flush(): Promise<void> {
    const run = this.tail.then(() => this.writeDirty());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async matchCapabilities(query: ArrayLike<number>, limit: number): Promise<Map<string, number>> {
    const { toVectorLiteral } = await import("./vector.js");
    const rows = await this.io.matchCapabilities(toVectorLiteral(query), limit);
    const scores = new Map<string, number>();
    for (const row of rows) scores.set(row.id, row.similarity);
    return scores;
  }

  private async writeDirty(): Promise<void> {
    while (this.sandboxDirty || this.jobsDirty || this.reputationDirty || this.registryDirty) {
      const sandbox = this.sandboxDirty;
      const jobs = this.jobsDirty;
      const reputation = this.reputationDirty;
      const registry = this.registryDirty;
      this.sandboxDirty = false;
      this.jobsDirty = false;
      this.reputationDirty = false;
      this.registryDirty = false;
      try {
        if (sandbox || jobs || reputation || registry) {
          await this.writeSnapshot(
            captureSnapshot({
              store: this.store,
              wallet: this.wallet,
              jobs: this.jobs,
              reputation: this.reputation as ReputationLedger,
              registry: this.registry,
            }),
          );
        }
      } catch (error) {
        this.sandboxDirty = this.sandboxDirty || sandbox;
        this.jobsDirty = this.jobsDirty || jobs;
        this.reputationDirty = this.reputationDirty || reputation;
        this.registryDirty = this.registryDirty || registry;
        throw error;
      }
    }
  }

  private async writeSnapshot(snapshot: RosterSnapshot): Promise<void> {
    const rows = snapshotToRows(snapshot);
    const previous = this.written;
    this.written = null;
    const next = new Map<string, Map<string, string>>();
    let upserted = 0;
    let deleted = 0;
    for (const table of UPSERT_ORDER) {
      const column = KEY_COLUMN.get(table);
      const before = previous?.get(table);
      const current = new Map<string, string>();
      const changed: Record<string, unknown>[] = [];
      for (const row of rows[table] ?? []) {
        const fingerprint = JSON.stringify(row);
        const key = column ? String(row[column] ?? "") : fingerprint;
        current.set(key, fingerprint);
        if (!before || before.get(key) !== fingerprint) changed.push(row);
      }
      if (changed.length > 0) await this.io.upsert(table, changed);
      upserted += changed.length;
      next.set(table, current);
    }
    for (const target of DELETE_ORDER) {
      const keep = next.get(target.table) ?? new Map<string, string>();
      const known = previous?.get(target.table);
      const existing = known
        ? [...known.keys()]
        : (await this.io.selectAll(target.table))
            .map((row) => row[target.column])
            .filter((id): id is string => typeof id === "string");
      const orphans = existing.filter((id) => !keep.has(id));
      if (orphans.length > 0) await this.io.deleteIds(target.table, target.column, orphans);
      deleted += orphans.length;
    }
    this.written = next;
    this.lastWriteStats = { upserted, deleted, full: previous === null };
  }
}

const KEY_COLUMN = new Map(DELETE_ORDER.map((target) => [target.table, target.column]));

export function createSupabaseTableClient(client: {
  from: (table: string) => {
    select: (columns: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    upsert: (rows: Record<string, unknown>[]) => PromiseLike<{ error: { message: string } | null }>;
    delete: () => {
      in: (column: string, ids: string[]) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}): RosterTableClient {
  return {
    async selectAll(table) {
      // PostgREST caps a bare select at 1000 rows. A short page would make the
      // next flush treat the missing rows as orphans and delete them.
      const column = orderColumn(table);
      const pageSize = 1000;
      const rows: Record<string, unknown>[] = [];
      const source = client.from(table) as unknown as {
        select: (columns: string) => {
          order: (column: string) => {
            range: (
              from: number,
              to: number,
            ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
          };
        };
      };
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await source.select("*").order(column).range(from, from + pageSize - 1);
        if (error) throw new Error(`Supabase ${table} read failed: ${error.message}`);
        if (!Array.isArray(data) || data.length === 0) break;
        for (const row of data) {
          if (isRecord(row)) rows.push(row);
        }
        if (data.length < pageSize) break;
      }
      return rows;
    },
    async upsert(table, rows) {
      for (let index = 0; index < rows.length; index += CHUNK) {
        const chunk = rows.slice(index, index + CHUNK);
        const { error } = await client.from(table).upsert(chunk);
        if (error) throw new Error(`Supabase ${table} write failed: ${error.message}`);
      }
    },
    async deleteIds(table, column, ids) {
      for (let index = 0; index < ids.length; index += CHUNK) {
        const chunk = ids.slice(index, index + CHUNK);
        const { error } = await client.from(table).delete().in(column, chunk);
        if (error) throw new Error(`Supabase ${table} delete failed: ${error.message}`);
      }
    },
    async matchCapabilities(literal, limit) {
      const { data, error } = await client.rpc("match_capability_listings", {
        query_embedding: literal,
        match_count: limit,
      });
      if (error) throw new Error(`Supabase capability search failed: ${error.message}`);
      if (!Array.isArray(data)) return [];
      const hits: { id: string; similarity: number }[] = [];
      for (const row of data) {
        if (!isRecord(row) || typeof row.id !== "string") continue;
        const similarity = typeof row.similarity === "number" ? row.similarity : Number(row.similarity);
        if (!Number.isFinite(similarity)) continue;
        hits.push({ id: row.id, similarity });
      }
      return hits;
    },
  };
}

function cloneWallet(snapshot: MockWalletSnapshot): MockWalletSnapshot {
  return {
    balances: snapshot.balances.map((entry) => ({ address: entry.address, balanceUsdc: entry.balanceUsdc })),
    sequence: snapshot.sequence,
    ...(snapshot.networkFeesCollectedUsdc !== undefined
      ? { networkFeesCollectedUsdc: snapshot.networkFeesCollectedUsdc }
      : {}),
  };
}

function orderColumn(table: string): string {
  const found = DELETE_ORDER.find((entry) => entry.table === table);
  if (!found) throw new Error(`No primary key for ${table}.`);
  return found.column;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
