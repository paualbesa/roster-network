import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SellerEndpoint } from "./import.js";
import type { PayoutWallet } from "./wallets.js";

/** Seller profile: payout address (no custody) and founding-program enrolment. */
export interface SellerProfile {
  organizationId: string;
  payout: PayoutWallet | null;
  /** 1-based founding seller number, or null when the program was full. */
  foundingNumber: number | null;
  foundingUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Private fulfilment endpoint of an imported listing. Never exposed publicly. */
export interface SellerEndpointRecord {
  listingId: string;
  organizationId: string;
  endpoint: SellerEndpoint;
  source: { type: "openapi" | "mcp"; url: string };
  createdAt: string;
}

export interface FoundingConfig {
  limit: number;
  days: number;
}

export function foundingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FoundingConfig {
  const limit = Number.parseInt(env.ROSTER_FOUNDING_SELLERS ?? "", 10);
  const days = Number.parseInt(env.ROSTER_FOUNDING_DAYS ?? "", 10);
  return {
    limit: Number.isFinite(limit) && limit >= 0 ? Math.min(limit, 100_000) : 100,
    days: Number.isFinite(days) && days >= 0 ? Math.min(days, 3650) : 90,
  };
}

export interface SellerRecord {
  id: string;
  kind: "profile" | "endpoint";
  organizationId: string;
  body: SellerProfile | SellerEndpointRecord;
}

export interface SellerPersistence {
  load(): Promise<SellerRecord[]>;
  save(record: SellerRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export class SellerDirectory {
  private readonly profiles = new Map<string, SellerProfile>();
  private readonly endpoints = new Map<string, SellerEndpointRecord>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly persistence: SellerPersistence | null,
    readonly founding: FoundingConfig = { limit: 100, days: 90 },
    private isFirstParty: (organizationId: string) => boolean = () => false,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** First-party orgs are known only after the fleet bootstrap; they never take a founding seat. */
  setFirstPartyCheck(check: (organizationId: string) => boolean): void {
    this.isFirstParty = check;
  }

  init(): Promise<void> {
    this.loaded ??= (this.persistence?.load() ?? Promise.resolve([])).then(
      (records) => {
        for (const record of records) {
          if (record.kind === "profile") this.profiles.set(record.organizationId, record.body as SellerProfile);
          else this.endpoints.set((record.body as SellerEndpointRecord).listingId, record.body as SellerEndpointRecord);
        }
      },
      (error: unknown) => {
        console.error(error);
      },
    );
    return this.loaded;
  }

  /** Synchronous lookups used on the job path; call init() at boot. */
  endpointFor(listingId: string): SellerEndpointRecord | null {
    return this.endpoints.get(listingId) ?? null;
  }

  profile(organizationId: string): SellerProfile | null {
    return this.profiles.get(organizationId) ?? null;
  }

  endpointsFor(organizationId: string): SellerEndpointRecord[] {
    return [...this.endpoints.values()].filter((record) => record.organizationId === organizationId);
  }

  async saveEndpoint(record: SellerEndpointRecord): Promise<void> {
    await this.init();
    this.endpoints.set(record.listingId, record);
    await this.persistence?.save({ id: `endpoint:${record.listingId}`, kind: "endpoint", organizationId: record.organizationId, body: record });
  }

  async removeEndpoint(listingId: string): Promise<void> {
    await this.init();
    if (!this.endpoints.delete(listingId)) return;
    await this.persistence?.remove(`endpoint:${listingId}`);
  }

  /** Drop a seller profile and free its founding seat (if any). */
  async removeProfile(organizationId: string): Promise<SellerProfile | null> {
    await this.init();
    const profile = this.profiles.get(organizationId) ?? null;
    if (!profile) return null;
    this.profiles.delete(organizationId);
    await this.persistence?.remove(`profile:${organizationId}`);
    return { ...profile };
  }

  /** Create or update the profile; enrols the founding program on first publish. */
  async upsertProfile(organizationId: string, patch: { payout?: PayoutWallet | null; enrolFounding?: boolean }): Promise<SellerProfile> {
    await this.init();
    const at = this.now().toISOString();
    const current = this.profiles.get(organizationId);
    let foundingNumber = current?.foundingNumber ?? null;
    let foundingUntil = current?.foundingUntil ?? null;
    if (!current && patch.enrolFounding && !this.isFirstParty(organizationId)) {
      const taken = this.foundingTaken();
      if (taken < this.founding.limit && this.founding.days > 0) {
        foundingNumber = taken + 1;
        foundingUntil = new Date(this.now().getTime() + this.founding.days * 86_400_000).toISOString();
      }
    }
    const profile: SellerProfile = {
      organizationId,
      payout: patch.payout === undefined ? (current?.payout ?? null) : patch.payout,
      foundingNumber,
      foundingUntil,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
    };
    this.profiles.set(organizationId, profile);
    await this.persistence?.save({ id: `profile:${organizationId}`, kind: "profile", organizationId, body: profile });
    return { ...profile };
  }

  foundingTaken(): number {
    let taken = 0;
    for (const profile of this.profiles.values()) if (profile.foundingNumber !== null) taken += 1;
    return taken;
  }

  foundingActive(organizationId: string): boolean {
    const profile = this.profiles.get(organizationId);
    return Boolean(profile?.foundingUntil && Date.parse(profile.foundingUntil) > this.now().getTime());
  }

  /** Take-rate override for escrow: 0 bps while the founding window is open, else the default. */
  takeRateBpsFor(organizationId: string): number | null {
    return this.foundingActive(organizationId) ? 0 : null;
  }

  foundingSummary(): { limit: number; taken: number; remaining: number; days: number; takeRateBps: number } {
    const taken = this.foundingTaken();
    return { limit: this.founding.limit, taken, remaining: Math.max(0, this.founding.limit - taken), days: this.founding.days, takeRateBps: 0 };
  }

  badge(organizationId: string): { number: number; until: string; active: boolean } | null {
    const profile = this.profiles.get(organizationId);
    if (!profile?.foundingNumber || !profile.foundingUntil) return null;
    return { number: profile.foundingNumber, until: profile.foundingUntil, active: this.foundingActive(organizationId) };
  }
}

export class FileSellerPersistence implements SellerPersistence {
  private cache = new Map<string, SellerRecord>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<SellerRecord[]> {
    if (!existsSync(this.filePath)) return [];
    const rows = JSON.parse(readFileSync(this.filePath, "utf8")) as SellerRecord[];
    this.cache = new Map(rows.map((row) => [row.id, row]));
    return rows;
  }

  async save(record: SellerRecord): Promise<void> {
    this.cache.set(record.id, record);
    this.write();
  }

  async remove(id: string): Promise<void> {
    this.cache.delete(id);
    this.write();
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...this.cache.values()], null, 2));
  }
}

export interface SupabaseSellerClientLike {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
    delete(): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }> };
  };
}

/** `seller_records` table (service role only). */
export class SupabaseSellerPersistence implements SellerPersistence {
  constructor(private readonly client: SupabaseSellerClientLike) {}

  async load(): Promise<SellerRecord[]> {
    const { data, error } = await this.client.from("seller_records").select("id,kind,organization_id,body");
    if (error) throw new Error(`seller_records read failed: ${error.message}`);
    return (data ?? []).flatMap((raw) => {
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== "string" || (row.kind !== "profile" && row.kind !== "endpoint") || typeof row.body !== "object" || row.body === null) return [];
      return [{ id: row.id, kind: row.kind, organizationId: String(row.organization_id), body: row.body as SellerProfile }];
    });
  }

  async save(record: SellerRecord): Promise<void> {
    const { error } = await this.client.from("seller_records").upsert(
      { id: record.id, kind: record.kind, organization_id: record.organizationId, body: record.body, updated_at: new Date().toISOString() },
      { onConflict: "id" },
    );
    if (error) throw new Error(`seller_records write failed: ${error.message}`);
  }

  async remove(id: string): Promise<void> {
    const { error } = await this.client.from("seller_records").delete().eq("id", id);
    if (error) throw new Error(`seller_records delete failed: ${error.message}`);
  }
}
