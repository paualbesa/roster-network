import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One unmet need, aggregated by normalized text. */
export interface UnmetNeed {
  id: string;
  need: string;
  normalized: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Best relevance among the weak matches (0 when nothing matched). */
  bestScore: number;
  bestListingName: string | null;
  budgetUsdc: string | null;
  kind: string | null;
  organizationId: string | null;
  /** Most recent request timestamps (capped), for "this week" counts. */
  recentSeenAt: string[];
}

export const MAX_UNMET_NEEDS = 2000;
export const MAX_RECENT_SEEN = 100;

export function normalizeNeed(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 300);
}

export interface DemandPersistence {
  load(): Promise<UnmetNeed[]>;
  save(entry: UnmetNeed): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

/** Unmet-demand log: what agents asked for that Roster could not sell yet. */
export class DemandLog {
  private readonly entries = new Map<string, UnmetNeed>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly persistence: DemandPersistence | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  init(): Promise<void> {
    this.loaded ??= (this.persistence?.load() ?? Promise.resolve([])).then(
      (rows) => {
        for (const row of rows) this.entries.set(row.id, row);
      },
      (error: unknown) => {
        console.error(error);
      },
    );
    return this.loaded;
  }

  async record(input: {
    need: string;
    bestScore: number;
    bestListingName: string | null;
    budgetUsdc: string | null;
    kind: string | null;
    organizationId: string | null;
  }): Promise<UnmetNeed | null> {
    await this.init();
    const normalized = normalizeNeed(input.need);
    if (normalized.length < 3) return null;
    const id = `need_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
    const at = this.now().toISOString();
    const current = this.entries.get(id);
    const entry: UnmetNeed = current
      ? {
          ...current,
          count: current.count + 1,
          lastSeenAt: at,
          need: input.need.slice(0, 500),
          bestScore: Math.max(current.bestScore, round(input.bestScore)),
          bestListingName: input.bestScore >= current.bestScore ? input.bestListingName : current.bestListingName,
          budgetUsdc: input.budgetUsdc ?? current.budgetUsdc,
          kind: input.kind ?? current.kind,
          organizationId: input.organizationId ?? current.organizationId,
          recentSeenAt: [...(current.recentSeenAt ?? []), at].slice(-MAX_RECENT_SEEN),
        }
      : {
          id,
          need: input.need.slice(0, 500),
          normalized,
          count: 1,
          firstSeenAt: at,
          lastSeenAt: at,
          bestScore: round(input.bestScore),
          bestListingName: input.bestListingName,
          budgetUsdc: input.budgetUsdc,
          kind: input.kind,
          organizationId: input.organizationId,
          recentSeenAt: [at],
        };
    this.entries.set(id, entry);
    const evicted = this.evict();
    if (this.persistence) {
      await this.persistence.save(entry).catch((error: unknown) => console.error(error));
      if (evicted.length > 0) await this.persistence.remove(evicted).catch((error: unknown) => console.error(error));
    }
    return entry;
  }

  /** Most-requested first, then most recent. */
  async list(limit = 200): Promise<UnmetNeed[]> {
    await this.init();
    return [...this.entries.values()]
      .sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, limit)
      .map((entry) => ({ ...entry, recentSeenAt: [...(entry.recentSeenAt ?? [])] }));
  }

  async dismiss(id: string): Promise<boolean> {
    await this.init();
    if (!this.entries.delete(id)) return false;
    await this.persistence?.remove([id]).catch((error: unknown) => console.error(error));
    return true;
  }

  async total(): Promise<{ entries: number; requests: number }> {
    await this.init();
    let requests = 0;
    for (const entry of this.entries.values()) requests += entry.count;
    return { entries: this.entries.size, requests };
  }

  private evict(): string[] {
    if (this.entries.size <= MAX_UNMET_NEEDS) return [];
    const oldest = [...this.entries.values()]
      .sort((left, right) => left.count - right.count || left.lastSeenAt.localeCompare(right.lastSeenAt))
      .slice(0, this.entries.size - MAX_UNMET_NEEDS)
      .map((entry) => entry.id);
    for (const id of oldest) this.entries.delete(id);
    return oldest;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** JSON file next to the sandbox data (json storage mode). */
export class FileDemandPersistence implements DemandPersistence {
  private cache = new Map<string, UnmetNeed>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<UnmetNeed[]> {
    if (!existsSync(this.filePath)) return [];
    const rows = (JSON.parse(readFileSync(this.filePath, "utf8")) as UnmetNeed[]).map((row) => ({ ...row, recentSeenAt: Array.isArray(row.recentSeenAt) ? row.recentSeenAt : [] }));
    this.cache = new Map(rows.map((row) => [row.id, row]));
    return rows;
  }

  async save(entry: UnmetNeed): Promise<void> {
    this.cache.set(entry.id, entry);
    this.write();
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.cache.delete(id);
    this.write();
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...this.cache.values()], null, 2));
  }
}

export interface SupabaseDemandClientLike {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
    delete(): { in(column: string, values: string[]): PromiseLike<{ error: { message: string } | null }> };
  };
}

/** `unmet_needs` table (service role only). */
export class SupabaseDemandPersistence implements DemandPersistence {
  constructor(private readonly client: SupabaseDemandClientLike) {}

  async load(): Promise<UnmetNeed[]> {
    const { data, error } = await this.client.from("unmet_needs").select("*");
    if (error) throw new Error(`unmet_needs read failed: ${error.message}`);
    return (data ?? []).flatMap((raw) => {
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.need !== "string") return [];
      return [
        {
          id: row.id,
          need: row.need,
          normalized: String(row.normalized ?? ""),
          count: Number(row.count ?? 1),
          firstSeenAt: new Date(String(row.first_seen_at)).toISOString(),
          lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
          bestScore: Number(row.best_score ?? 0),
          bestListingName: typeof row.best_listing_name === "string" ? row.best_listing_name : null,
          budgetUsdc: typeof row.budget_usdc === "string" ? row.budget_usdc : null,
          kind: typeof row.kind === "string" ? row.kind : null,
          organizationId: typeof row.organization_id === "string" ? row.organization_id : null,
          recentSeenAt: Array.isArray(row.recent_seen) ? row.recent_seen.filter((value): value is string => typeof value === "string") : [],
        },
      ];
    });
  }

  async save(entry: UnmetNeed): Promise<void> {
    const { error } = await this.client.from("unmet_needs").upsert(
      {
        id: entry.id,
        need: entry.need,
        normalized: entry.normalized,
        count: entry.count,
        first_seen_at: entry.firstSeenAt,
        last_seen_at: entry.lastSeenAt,
        best_score: entry.bestScore,
        best_listing_name: entry.bestListingName,
        budget_usdc: entry.budgetUsdc,
        kind: entry.kind,
        organization_id: entry.organizationId,
        recent_seen: entry.recentSeenAt,
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(`unmet_needs write failed: ${error.message}`);
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.client.from("unmet_needs").delete().in("id", ids);
    if (error) throw new Error(`unmet_needs delete failed: ${error.message}`);
  }
}
