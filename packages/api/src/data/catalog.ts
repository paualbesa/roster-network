import { createHash } from "node:crypto";
import type { DataProductInfo } from "@albesa/registry";
import type { SandboxCapabilityDraft } from "../catalog.js";
import { DATA_PRODUCTS } from "./products/index.js";
import type { DataProductMeta, DataStore } from "./store.js";
import type { DataFetchContext, DataProductSpec, Json, LookupContext, Row } from "./types.js";
import { createFetchContext, intIn, str, toCsv } from "./util.js";

/** Appended to every data product description so buyers can tell first-party data from third-party sellers. */
export const DATA_OWNERSHIP_NOTE =
  "Collected, cleaned and deduplicated by Roster Data from a public source whose license allows resale; attribution included in every delivery. You only pay when data is delivered.";

const SIGNED_URL_TTL_S = 3600;
const SAMPLE_ROWS = 5;
const PREVIEW_ROWS = 5;
const MAX_FEED_ITEMS = 500;
const REFRESH_TIMEOUT_MS = 10 * 60_000;
/** After a failed refresh, wait this long before trying again (or the product interval if shorter). */
const ERROR_RETRY_S = 30 * 60;

export interface DataProductPublic {
  slug: string;
  name: string;
  kind: DataProductSpec["kind"];
  description: string;
  priceUsdc: string;
  refreshCadence: string;
  refreshIntervalS: number;
  live: boolean;
  status: DataProductMeta["status"] | "live";
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  rowCount: number;
  bytes: number;
  sha256: string | null;
  lastError: string | null;
  columns: DataProductSpec["columns"];
  sample: Row[];
  sources: DataProductSpec["sources"];
  example: Json | null;
  formats: string[];
  delivery: DataProductInfo["delivery"];
  /** Set when a lookup answers from another product's rows (rowCount is that product's). */
  derivedFrom: string | null;
}

export class DataCatalog {
  readonly specs: readonly DataProductSpec[];
  private readonly bySlug: Map<string, DataProductSpec>;
  private readonly byName: Map<string, DataProductSpec>;
  private readonly metas = new Map<string, DataProductMeta>();
  private readonly cache = new Map<string, Row[]>();
  private readonly loading = new Map<string, Promise<Row[]>>();
  private readonly fetchContext: DataFetchContext;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private initialized: Promise<void> | null = null;

  constructor(
    private readonly store: DataStore,
    options: { specs?: readonly DataProductSpec[]; fetch?: typeof fetch; now?: () => Date; log?: (line: string) => void } = {},
  ) {
    this.specs = options.specs ?? DATA_PRODUCTS;
    this.bySlug = new Map(this.specs.map((spec) => [spec.slug, spec]));
    this.byName = new Map(this.specs.map((spec) => [spec.name, spec]));
    this.now = options.now ?? (() => new Date());
    this.fetchContext = createFetchContext({ ...(options.fetch ? { fetch: options.fetch } : {}), now: this.now });
    this.log = options.log ?? ((line) => console.log(line));
  }

  get storeKind(): DataStore["kind"] {
    return this.store.kind;
  }

  /** Load freshness records. Safe to call more than once. */
  init(): Promise<void> {
    this.initialized ??= this.store.loadMeta().then(
      (metas) => {
        for (const meta of metas) if (this.bySlug.has(meta.slug)) this.metas.set(meta.slug, meta);
      },
      (error: unknown) => {
        this.initialized = null;
        throw error;
      },
    );
    return this.initialized;
  }

  spec(slug: string): DataProductSpec | undefined {
    return this.bySlug.get(slug);
  }

  specForName(name: string): DataProductSpec | undefined {
    return this.byName.get(name);
  }

  handles(listingName: string): boolean {
    return this.byName.has(listingName);
  }

  meta(slug: string): DataProductMeta | undefined {
    return this.metas.get(slug);
  }

  /** Registry drafts for the Roster Data seller. */
  drafts(): SandboxCapabilityDraft[] {
    return this.specs.map((spec) => dataProductDraft(spec));
  }

  info(slug: string): DataProductPublic | null {
    const spec = this.bySlug.get(slug);
    if (!spec) return null;
    const meta = this.metas.get(slug);
    const live = spec.live === true;
    const base = live ? null : this.storedBase(spec);
    const lastRefreshedAt = live ? this.now().toISOString() : (base?.lastRefreshedAt ?? null);
    return {
      slug,
      name: spec.name,
      kind: spec.kind,
      description: spec.description,
      priceUsdc: spec.priceUsdc,
      refreshCadence: spec.cadence,
      refreshIntervalS: spec.intervalS,
      live,
      status: live ? "live" : (base?.status ?? "pending"),
      lastRefreshedAt,
      nextRefreshAt:
        live || !base?.lastRefreshedAt ? null : new Date(Date.parse(base.lastRefreshedAt) + spec.intervalS * 1000).toISOString(),
      rowCount: base?.rowCount ?? 0,
      bytes: base?.bytes ?? 0,
      sha256: base?.sha256 ?? null,
      lastError: meta?.lastError ?? null,
      columns: spec.columns,
      sample: meta?.sample?.length ? meta.sample : (base?.sample ?? []),
      sources: spec.sources,
      example: spec.example ?? null,
      formats: dataFormats(spec),
      delivery: spec.kind === "dataset" ? "signed_url" : "inline",
      derivedFrom: spec.ingest ? null : (LOOKUP_PARENTS[spec.slug] ?? null),
    };
  }

  /** Lookups without their own ingest borrow freshness from the dataset they read. */
  private storedBase(spec: DataProductSpec): DataProductMeta | undefined {
    const own = this.metas.get(spec.slug);
    if (own || spec.ingest) return own;
    const parent = LOOKUP_PARENTS[spec.slug];
    return parent ? this.metas.get(parent) : undefined;
  }

  list(): DataProductPublic[] {
    return this.specs.flatMap((spec) => {
      const info = this.info(spec.slug);
      return info ? [info] : [];
    });
  }

  /** Stored rows for one product, loaded lazily from the store and cached. */
  async rows(slug: string): Promise<Row[]> {
    const cached = this.cache.get(slug);
    if (cached) return cached;
    const pending = this.loading.get(slug);
    if (pending) return pending;
    const load = this.store
      .get(`${slug}/latest.json`)
      .then((body) => {
        const rows = body ? (JSON.parse(new TextDecoder().decode(body)) as Row[]) : [];
        if (rows.length > 0) this.cache.set(slug, rows);
        return rows;
      })
      .finally(() => this.loading.delete(slug));
    this.loading.set(slug, load);
    return load;
  }

  isDue(spec: DataProductSpec, at: Date = this.now()): boolean {
    if (!spec.ingest || spec.live) return false;
    const meta = this.metas.get(spec.slug);
    if (!meta?.lastRefreshedAt) {
      if (!meta?.lastAttemptAt) return true;
      return at.getTime() - Date.parse(meta.lastAttemptAt) >= Math.min(spec.intervalS, ERROR_RETRY_S) * 1000;
    }
    if (meta.status === "error" && meta.lastAttemptAt) {
      const sinceAttempt = at.getTime() - Date.parse(meta.lastAttemptAt);
      if (sinceAttempt < Math.min(spec.intervalS, ERROR_RETRY_S) * 1000) return false;
    }
    return at.getTime() - Date.parse(meta.lastRefreshedAt) >= spec.intervalS * 1000;
  }

  /** Fetch, clean, merge (feeds), and publish one product. Errors are recorded, never thrown. */
  async refresh(slug: string): Promise<DataProductMeta> {
    await this.init();
    const spec = this.bySlug.get(slug);
    if (!spec?.ingest) throw new Error(`Data product ${slug} has no ingestion job.`);
    const started = Date.now();
    const attemptAt = this.now().toISOString();
    const previousMeta = this.metas.get(slug);
    try {
      const previous = this.cache.get(slug) ?? (previousMeta?.rowCount ? await this.rows(slug) : []);
      const fresh = await withTimeout(spec.ingest(this.fetchContext, previous), REFRESH_TIMEOUT_MS, `${slug} refresh timed out`);
      const rows = spec.kind === "feed" ? mergeFeed(spec, previous, fresh, this.now()) : fresh;
      if (rows.length === 0) throw new Error("Upstream returned no rows.");
      const columns = columnNames(spec, rows);
      const json = new TextEncoder().encode(JSON.stringify(rows));
      const csv = new TextEncoder().encode(toCsv(rows, columns));
      const sha256 = createHash("sha256").update(json).digest("hex");
      if (sha256 !== previousMeta?.sha256 || previousMeta.status !== "ok") {
        await this.store.put(`${slug}/latest.json`, json, "application/json");
        await this.store.put(`${slug}/latest.csv`, csv, "text/csv");
      }
      const meta: DataProductMeta = {
        slug,
        kind: spec.kind,
        name: spec.name,
        status: "ok",
        lastRefreshedAt: this.now().toISOString(),
        lastAttemptAt: attemptAt,
        rowCount: rows.length,
        bytes: json.byteLength,
        sha256,
        durationMs: Date.now() - started,
        lastError: null,
        sample: rows.slice(0, SAMPLE_ROWS),
        columns,
      };
      this.metas.set(slug, meta);
      // Keep rows in memory only for products something reads row by row.
      if (this.cache.has(slug) || spec.kind === "feed" || spec.lookup || CACHED_PARENTS.has(slug)) this.cache.set(slug, rows);
      await this.store.saveMeta(meta);
      this.log(`[data] ${slug}: ${rows.length.toString()} rows in ${meta.durationMs?.toString() ?? "?"} ms`);
      return meta;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const meta: DataProductMeta = {
        ...(previousMeta ?? {
          slug,
          kind: spec.kind,
          name: spec.name,
          lastRefreshedAt: null,
          rowCount: 0,
          bytes: 0,
          sha256: null,
          sample: [],
          columns: spec.columns.map((column) => column.name),
        }),
        status: previousMeta?.lastRefreshedAt ? "error" : "error",
        lastAttemptAt: attemptAt,
        durationMs: Date.now() - started,
        lastError: message.slice(0, 500),
      };
      this.metas.set(slug, meta);
      try {
        await this.store.saveMeta(meta);
      } catch (saveError) {
        console.error(saveError);
      }
      this.log(`[data] ${slug}: refresh failed: ${message}`);
      return meta;
    }
  }

  /** Refresh every due product, one at a time. Concurrent calls share one run. */
  refreshDue(): Promise<void> {
    if (this.running) return this.running;
    const run = (async () => {
      await this.init();
      for (const spec of this.specs) {
        if (this.isDue(spec)) await this.refresh(spec.slug);
      }
    })().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  /** Background scheduler: first pass after `initialDelayMs`, then every `intervalMs`. */
  start(options: { intervalMs?: number; initialDelayMs?: number } = {}): void {
    if (this.timer) return;
    const intervalMs = options.intervalMs ?? 5 * 60_000;
    const tick = () => {
      void this.refreshDue().catch((error: unknown) => {
        console.error(error);
      });
    };
    const first = setTimeout(tick, options.initialDelayMs ?? 5000);
    first.unref();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private lookupContext(spec: DataProductSpec): LookupContext {
    return { ...this.fetchContext, rows: () => this.rows(spec.slug), rowsOf: (slug) => this.rows(slug) };
  }

  /**
   * Deliver one purchase. Throws when there is nothing to deliver; the job
   * orchestrator then submits an invalid result and escrow refunds the buyer.
   */
  async fulfill(listingName: string, input: Json): Promise<Record<string, unknown>> {
    await this.init();
    const spec = this.byName.get(listingName);
    if (!spec) throw new Error(`No data product named ${listingName}.`);
    const info = this.info(spec.slug);
    const source = spec.sources[0];
    const attribution = {
      source: spec.sources.map((entry) => entry.name).join("; "),
      license: spec.sources.map((entry) => entry.license).join("; "),
      attribution: spec.sources.map((entry) => entry.attribution).join(" "),
      sourceUrl: source?.url ?? "",
    };
    if (spec.kind === "dataset") {
      const meta = this.metas.get(spec.slug);
      if (!meta?.lastRefreshedAt || meta.rowCount === 0) throw new Error(`${spec.slug} has not been collected yet.`);
      const stamp = meta.lastRefreshedAt.slice(0, 10);
      const [json, csv] = await Promise.all([
        this.store.signedUrl(`${spec.slug}/latest.json`, SIGNED_URL_TTL_S, `${spec.slug}-${stamp}.json`),
        this.store.signedUrl(`${spec.slug}/latest.csv`, SIGNED_URL_TTL_S, `${spec.slug}-${stamp}.csv`),
      ]);
      return {
        product: spec.slug,
        kind: spec.kind,
        name: spec.name,
        rowCount: meta.rowCount,
        bytes: meta.bytes,
        lastRefreshedAt: meta.lastRefreshedAt,
        refreshCadence: spec.cadence,
        downloadUrl: json.url,
        csvUrl: csv.url,
        expiresAt: json.expiresAt,
        sha256: meta.sha256 ?? "",
        columns: meta.columns,
        preview: meta.sample.slice(0, PREVIEW_ROWS),
        ...attribution,
      };
    }
    if (spec.kind === "feed") {
      const all = await this.rows(spec.slug);
      if (all.length === 0) throw new Error(`${spec.slug} has not been collected yet.`);
      const items = filterFeed(spec, all, input);
      return {
        product: spec.slug,
        kind: spec.kind,
        name: spec.name,
        lastRefreshedAt: info?.lastRefreshedAt ?? "",
        refreshCadence: spec.cadence,
        count: items.length,
        totalAvailable: all.length,
        items,
        ...attribution,
      };
    }
    const lookup = spec.lookup;
    if (!lookup) throw new Error(`${spec.slug} cannot answer queries.`);
    const matches = await withTimeout(lookup(input, this.lookupContext(spec)), Math.max(1000, spec.p95Ms - 500), `${spec.slug} lookup timed out`);
    return {
      product: spec.slug,
      kind: spec.kind,
      name: spec.name,
      lastRefreshedAt: spec.live ? this.now().toISOString() : (info?.lastRefreshedAt ?? ""),
      refreshCadence: spec.cadence,
      count: matches.length,
      matches: matches.slice(0, 200),
      ...attribution,
    };
  }
}

/** Lookups that read another product's rows: freshness comes from that parent. */
export const LOOKUP_PARENTS: Record<string, string> = {
  "fx-convert": "fx-history",
  "country-economy-snapshot": "wb-gdp",
  "city-lookup": "world-cities",
  "airport-lookup": "airports",
  "kev-check": "cisa-kev",
};
const CACHED_PARENTS = new Set([...Object.values(LOOKUP_PARENTS), "wb-gdp-per-capita", "wb-population", "wb-inflation"]);

function dataFormats(spec: DataProductSpec): string[] {
  return spec.kind === "dataset" ? ["json", "csv"] : ["json"];
}

function columnNames(spec: DataProductSpec, rows: readonly Row[]): string[] {
  const declared = spec.columns.map((column) => column.name).filter((name) => !name.startsWith("<"));
  const seen = new Set(declared);
  const extra: string[] = [];
  for (const row of rows.slice(0, 50)) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        extra.push(key);
      }
    }
  }
  const present = declared.filter((name) => rows.some((row, index) => index < 50 && name in row));
  return [...present, ...extra];
}

function timeOf(spec: DataProductSpec, row: Row): number {
  const value = spec.timeField ? row[spec.timeField] : null;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeFeed(spec: DataProductSpec, previous: readonly Row[], fresh: readonly Row[], now: Date): Row[] {
  const idField = spec.idField ?? "id";
  const byId = new Map<string, Row>();
  for (const row of previous) byId.set(String(row[idField]), row);
  for (const row of fresh) byId.set(String(row[idField]), row);
  const floor = spec.retainDays ? now.getTime() - spec.retainDays * 86_400_000 : 0;
  return [...byId.values()]
    .filter((row) => !spec.timeField || timeOf(spec, row) === 0 || timeOf(spec, row) >= floor)
    .sort((left, right) => timeOf(spec, right) - timeOf(spec, left))
    .slice(0, spec.maxRows ?? 10_000);
}

function filterFeed(spec: DataProductSpec, rows: readonly Row[], input: Json): Row[] {
  const sinceRaw = str(input, "since", 40);
  const since = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
  const q = str(input, "q", 120).toLowerCase();
  const limit = intIn(input, "limit", 50, 1, MAX_FEED_ITEMS);
  const filter = typeof input.filter === "object" && input.filter !== null && !Array.isArray(input.filter) ? (input.filter as Json) : {};
  const allowed = new Set(spec.filterFields ?? []);
  return rows
    .filter((row) => !Number.isFinite(since) || timeOf(spec, row) > since)
    .filter((row) =>
      Object.entries(filter).every(([key, expected]) => {
        if (!allowed.has(key)) return true;
        const actual = row[key];
        if (typeof expected === "string" && typeof actual === "string") {
          return actual.toLowerCase().split(";").includes(expected.toLowerCase()) || actual.toLowerCase() === expected.toLowerCase();
        }
        return actual === expected;
      }),
    )
    .filter(
      (row) =>
        !q ||
        Object.values(row).some((value) => typeof value === "string" && value.toLowerCase().includes(q)),
    )
    .slice(0, limit);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ATTRIBUTION_PROPS = {
  source: { type: "string", minLength: 1 },
  license: { type: "string", minLength: 1 },
  attribution: { type: "string", minLength: 1 },
  sourceUrl: { type: "string" },
  name: { type: "string" },
  kind: { type: "string" },
  refreshCadence: { type: "string" },
};

/** Result schema escrow validates. Empty deliveries fail it, so the buyer is refunded. */
export function dataOutputSchema(spec: DataProductSpec): Record<string, unknown> {
  if (spec.kind === "dataset") {
    return {
      type: "object",
      required: ["product", "rowCount", "lastRefreshedAt", "downloadUrl", "csvUrl", "expiresAt", "sha256", "license", "attribution", "preview"],
      properties: {
        product: { type: "string", enum: [spec.slug] },
        rowCount: { type: "integer", minimum: 1 },
        bytes: { type: "integer", minimum: 1 },
        lastRefreshedAt: { type: "string", minLength: 10 },
        downloadUrl: { type: "string", minLength: 10 },
        csvUrl: { type: "string", minLength: 10 },
        expiresAt: { type: "string", minLength: 10 },
        sha256: { type: "string", minLength: 64, maxLength: 64 },
        columns: { type: "array", items: { type: "string" }, maxItems: 200 },
        preview: { type: "array", items: { type: "object" }, maxItems: PREVIEW_ROWS },
        ...ATTRIBUTION_PROPS,
      },
    };
  }
  if (spec.kind === "feed") {
    return {
      type: "object",
      required: ["product", "lastRefreshedAt", "count", "items", "license", "attribution"],
      properties: {
        product: { type: "string", enum: [spec.slug] },
        lastRefreshedAt: { type: "string", minLength: 10 },
        count: { type: "integer", minimum: 1 },
        totalAvailable: { type: "integer", minimum: 0 },
        items: { type: "array", items: { type: "object" }, minItems: 1, maxItems: MAX_FEED_ITEMS },
        ...ATTRIBUTION_PROPS,
      },
    };
  }
  return {
    type: "object",
    required: ["product", "lastRefreshedAt", "count", "matches", "license", "attribution"],
    properties: {
      product: { type: "string", enum: [spec.slug] },
      lastRefreshedAt: { type: "string", minLength: 10 },
      count: { type: "integer", minimum: 1 },
      matches: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 200 },
      ...ATTRIBUTION_PROPS,
    },
  };
}

function dataInputSchema(spec: DataProductSpec): Record<string, unknown> {
  if (spec.kind === "dataset") {
    return {
      type: "object",
      additionalProperties: false,
      properties: { format: { type: "string", enum: ["json", "csv"], description: "Both links are always returned." } },
      examples: [{}],
    };
  }
  if (spec.kind === "feed") {
    const filterProps: Record<string, unknown> = {};
    for (const field of spec.filterFields ?? []) filterProps[field] = { type: ["string", "boolean"] };
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        since: { type: "string", description: `Only items with ${spec.timeField ?? "time"} after this ISO 8601 time.` },
        limit: { type: "integer", minimum: 1, maximum: MAX_FEED_ITEMS, description: "Default 50." },
        q: { type: "string", description: "Case-insensitive text match on any text column." },
        filter: { type: "object", additionalProperties: false, properties: filterProps },
      },
      examples: [{ limit: 20 }],
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: spec.required ?? [],
    properties: spec.input ?? {},
    examples: [spec.example ?? {}],
  };
}

export function dataProductInfo(spec: DataProductSpec): DataProductInfo {
  return {
    slug: spec.slug,
    sources: spec.sources,
    refreshCadence: spec.cadence,
    refreshIntervalS: Math.max(60, spec.intervalS),
    formats: dataFormats(spec),
    delivery: spec.kind === "dataset" ? "signed_url" : "inline",
    columns: spec.columns.slice(0, 60).map((column) => ({ ...column, description: column.description.slice(0, 300) })),
  };
}

/** Registry draft for one data product (`kind` + `data` set). */
export function dataProductDraft(spec: DataProductSpec): SandboxCapabilityDraft & { kind: DataProductSpec["kind"]; data: DataProductInfo } {
  const inputSchema = dataInputSchema(spec);
  const outputSchema = dataOutputSchema(spec);
  const description = `${spec.description} ${DATA_OWNERSHIP_NOTE}`;
  const tags = [...new Set([...spec.tags, spec.kind, "data", "roster-data"])].slice(0, 16);
  const slug = spec.slug.replace(/-/g, "_");
  return {
    name: spec.name,
    description,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    pricing: { model: "per_call", amountUsdc: spec.priceUsdc },
    latency: { p95Ms: spec.p95Ms, p50Ms: Math.round(spec.p95Ms / 4) },
    tags,
    kind: spec.kind,
    data: dataProductInfo(spec),
    manifest: {
      mcp: { name: `data_${slug}`, description, inputSchema },
      openapi: {
        openapi: "3.0.3",
        operationId: `data${slug.replace(/(^|_)([a-z0-9])/g, (_m, _s: string, c: string) => c.toUpperCase())}`,
        method: "post",
        path: `/data/${spec.slug}`,
        requestSchema: inputSchema,
        responseSchema: outputSchema,
      },
    },
  };
}
