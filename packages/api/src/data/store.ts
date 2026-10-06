import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { Row } from "./types.js";

/** Private bucket for data product files. Created by the migration. */
export const DATA_BUCKET = "data-products";

export interface DataProductMeta {
  slug: string;
  kind: string;
  name: string;
  status: "ok" | "error" | "pending";
  lastRefreshedAt: string | null;
  lastAttemptAt: string | null;
  rowCount: number;
  bytes: number;
  sha256: string | null;
  durationMs: number | null;
  lastError: string | null;
  sample: Row[];
  columns: string[];
}

export interface DataSignedUrl {
  url: string;
  expiresAt: string;
}

export interface DataStore {
  readonly kind: "memory" | "local" | "supabase";
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array | null>;
  signedUrl(path: string, ttlSeconds: number, downloadName: string): Promise<DataSignedUrl>;
  loadMeta(): Promise<DataProductMeta[]>;
  saveMeta(meta: DataProductMeta): Promise<void>;
}

/** Memory or directory store. Download links are HMAC-signed `/v1/data/download/<token>` paths on this API. */
export class LocalDataStore implements DataStore {
  readonly kind: "memory" | "local";
  private readonly files = new Map<string, { body: Uint8Array; contentType: string }>();
  private readonly metas = new Map<string, DataProductMeta>();
  private readonly secret: Buffer;

  constructor(private readonly options: { directory?: string; now?: () => Date; secret?: string } = {}) {
    this.kind = options.directory ? "local" : "memory";
    this.secret = options.secret ? Buffer.from(options.secret, "utf8") : randomBytes(32);
    if (options.directory) {
      const index = this.file("_meta.json");
      if (existsSync(index)) {
        for (const meta of JSON.parse(readFileSync(index, "utf8")) as DataProductMeta[]) this.metas.set(meta.slug, meta);
      }
    }
  }

  private file(path: string): string {
    const root = resolve(this.options.directory ?? ".");
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new Error("Data path escapes the store.");
    return target;
  }

  async put(path: string, body: Uint8Array, contentType: string): Promise<void> {
    if (this.options.directory) {
      const target = this.file(path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
      writeFileSync(`${target}.type`, contentType);
      return;
    }
    this.files.set(path, { body: Uint8Array.from(body), contentType });
  }

  async get(path: string): Promise<Uint8Array | null> {
    return this.read(path)?.body ?? null;
  }

  private read(path: string): { body: Uint8Array; contentType: string } | null {
    if (this.options.directory) {
      const target = this.file(path);
      if (!existsSync(target)) return null;
      const contentType = existsSync(`${target}.type`) ? readFileSync(`${target}.type`, "utf8") : "application/octet-stream";
      return { body: new Uint8Array(readFileSync(target)), contentType };
    }
    return this.files.get(path) ?? null;
  }

  async signedUrl(path: string, ttlSeconds: number, downloadName: string): Promise<DataSignedUrl> {
    const now = this.options.now?.() ?? new Date();
    const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ p: path, e: expires, n: downloadName }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return { url: `/v1/data/download/${payload}.${signature}`, expiresAt: new Date(expires * 1000).toISOString() };
  }

  /** Resolve a download token. Null when forged, expired, or missing. */
  resolve(token: string): { body: Uint8Array; contentType: string; name: string } | null {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const presented = Buffer.from(signature, "base64url");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    let parsed: { p?: unknown; e?: unknown; n?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
    } catch {
      return null;
    }
    if (typeof parsed.p !== "string" || typeof parsed.e !== "number" || typeof parsed.n !== "string") return null;
    const now = this.options.now?.() ?? new Date();
    if (parsed.e * 1000 < now.getTime()) return null;
    const file = this.read(parsed.p);
    return file ? { ...file, name: parsed.n } : null;
  }

  async loadMeta(): Promise<DataProductMeta[]> {
    return [...this.metas.values()].map((meta) => ({ ...meta }));
  }

  async saveMeta(meta: DataProductMeta): Promise<void> {
    this.metas.set(meta.slug, { ...meta });
    if (this.options.directory) {
      const index = this.file("_meta.json");
      mkdirSync(dirname(index), { recursive: true });
      writeFileSync(index, JSON.stringify([...this.metas.values()], null, 2));
    }
  }
}

/** The subset of supabase-js the data store uses (service role). */
export interface SupabaseDataClientLike {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options: { contentType: string; upsert: boolean; cacheControl?: string },
      ): Promise<{ error: { message: string } | null }>;
      download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
      createSignedUrl(
        path: string,
        expiresIn: number,
        options?: { download?: string | boolean },
      ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
    };
  };
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
  };
}

export class SupabaseDataStore implements DataStore {
  readonly kind = "supabase" as const;

  constructor(
    private readonly client: SupabaseDataClientLike,
    private readonly bucket: string = DATA_BUCKET,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(path: string, body: Uint8Array, contentType: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).upload(path, body, { contentType, upsert: true, cacheControl: "60" });
    if (error) throw new Error(`Data upload failed (${path}): ${error.message}`);
  }

  async get(path: string): Promise<Uint8Array | null> {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }

  async signedUrl(path: string, ttlSeconds: number, downloadName: string): Promise<DataSignedUrl> {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(path, ttlSeconds, { download: downloadName });
    if (error || !data) throw new Error(`Data signed URL failed: ${error?.message ?? "no data"}`);
    return { url: data.signedUrl, expiresAt: new Date(this.now().getTime() + ttlSeconds * 1000).toISOString() };
  }

  async loadMeta(): Promise<DataProductMeta[]> {
    const { data, error } = await this.client.from("data_products").select("*");
    if (error) throw new Error(`data_products read failed: ${error.message}`);
    return (data ?? []).flatMap((raw) => {
      const row = raw as Record<string, unknown>;
      if (typeof row.slug !== "string") return [];
      return [
        {
          slug: row.slug,
          kind: String(row.kind ?? ""),
          name: String(row.name ?? ""),
          status: row.status === "ok" || row.status === "error" ? row.status : "pending",
          lastRefreshedAt: typeof row.last_refreshed_at === "string" ? new Date(row.last_refreshed_at).toISOString() : null,
          lastAttemptAt: typeof row.last_attempt_at === "string" ? new Date(row.last_attempt_at).toISOString() : null,
          rowCount: Number(row.row_count ?? 0),
          bytes: Number(row.bytes ?? 0),
          sha256: typeof row.sha256 === "string" ? row.sha256 : null,
          durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
          lastError: typeof row.last_error === "string" ? row.last_error : null,
          sample: Array.isArray(row.sample) ? (row.sample as Row[]) : [],
          columns: Array.isArray(row.columns) ? (row.columns as string[]) : [],
        },
      ];
    });
  }

  async saveMeta(meta: DataProductMeta): Promise<void> {
    const { error } = await this.client.from("data_products").upsert(
      {
        slug: meta.slug,
        kind: meta.kind,
        name: meta.name,
        status: meta.status,
        last_refreshed_at: meta.lastRefreshedAt,
        last_attempt_at: meta.lastAttemptAt,
        row_count: meta.rowCount,
        bytes: meta.bytes,
        sha256: meta.sha256,
        duration_ms: meta.durationMs,
        last_error: meta.lastError,
        sample: meta.sample,
        columns: meta.columns,
        updated_at: this.now().toISOString(),
      },
      { onConflict: "slug" },
    );
    if (error) throw new Error(`data_products write failed: ${error.message}`);
  }
}
