import type { DataSourceAttribution } from "@albesa/registry";

export type Row = Record<string, string | number | boolean | null>;
export type Json = Record<string, unknown>;

export type DataProductKind = "dataset" | "feed" | "lookup";

export interface DataColumn {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "date" | "datetime";
  description: string;
}

/** Network helpers handed to ingestion jobs and live lookups. Every call sends the Roster data user agent. */
export interface DataFetchContext {
  fetchText(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<string>;
  fetchJson<T = unknown>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T>;
  fetchBytes(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Uint8Array>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export interface LookupContext extends DataFetchContext {
  /** Latest stored rows for this product. Empty when it was never refreshed. */
  rows(): Promise<Row[]>;
  /** Latest stored rows of another product (for derived lookups). */
  rowsOf(slug: string): Promise<Row[]>;
}

export interface DataProductSpec {
  /** Stable kebab-case id. Storage path prefix and `data.slug` on the listing. */
  slug: string;
  /** Listing name. Stable: the bootstrap matches on it. */
  name: string;
  kind: DataProductKind;
  /** What the buyer gets, written for semantic search. */
  description: string;
  tags: string[];
  sources: DataSourceAttribution[];
  cadence: string;
  /** Seconds between refreshes. Live lookups use the cache TTL here. */
  intervalS: number;
  priceUsdc: string;
  p95Ms: number;
  columns: DataColumn[];
  /** Fetch, clean, and dedupe the full product. Absent for live-only lookups. */
  ingest?: (ctx: DataFetchContext, previous: readonly Row[]) => Promise<Row[]>;
  /** Input properties for lookups and feeds (escrow subset is not required for input). */
  input?: Json;
  required?: string[];
  example?: Json;
  /** Lookup: answer one query. Rows come from the stored product or a live call. */
  lookup?: (input: Json, ctx: LookupContext) => Promise<Row[]>;
  /** Feeds: column holding the item timestamp, used by `since` and retention. */
  timeField?: string;
  /** Feeds: unique item id; new ingests merge into the stored items by this column. */
  idField?: string;
  /** Feeds: drop items older than this many days. */
  retainDays?: number;
  /** Feeds: keep at most this many newest items. */
  maxRows?: number;
  /** Columns a feed buyer can filter on with `filter: {column: value}`. */
  filterFields?: string[];
  /** Live lookups are never stored; their freshness is the call time. */
  live?: boolean;
}
