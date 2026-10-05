/** Client-side shapes and helpers for `POST /v1/need`, `/v1/need/buy`, and data products. */

export type ListingKind = "service" | "dataset" | "feed" | "lookup";

export interface NeedFreshness {
  lastRefreshedAt: string | null;
  refreshCadence: string | null;
  status: string;
  rowCount: number | null;
}

export interface NeedMatchView {
  listingId: string;
  name: string;
  kind: ListingKind;
  summary: string;
  priceUsdc: string;
  relevance: number;
  seller: string | null;
  freshness: NeedFreshness | null;
  source: { name: string; license: string; url: string } | null;
  sample: Record<string, unknown>[];
  inputExample: Record<string, unknown>;
  p95Ms: number;
}

export interface NeedResponseView {
  need: string;
  matched: boolean;
  weak: boolean;
  matches: NeedMatchView[];
  unmetMessage: string | null;
}

export interface BuyResponseView {
  status: string;
  delivered: boolean;
  result: unknown;
  amountUsdc: string;
  listingName: string;
  jobId: string;
  buyerBalanceUsdc: string;
  jsonUrl: string | null;
  csvUrl: string | null;
}

export interface DataProductView {
  slug: string;
  name: string;
  kind: ListingKind;
  description: string;
  priceUsdc: string;
  refreshCadence: string;
  live: boolean;
  status: string;
  lastRefreshedAt: string | null;
  rowCount: number;
  bytes: number;
  columns: { name: string; type: string; description?: string }[];
  sample: Record<string, unknown>[];
  sources: { name: string; url: string; license: string; licenseUrl?: string; attribution?: string }[];
  example: unknown;
  formats: string[];
  delivery: string;
  listingId: string | null;
}

export const NEED_EXAMPLES = [
  "EUR to USD exchange rates history as CSV",
  "Is CVE-2024-3094 actively exploited?",
  "Spain CPI inflation monthly",
  "Weather forecast for Barcelona",
  "Latest arXiv papers on LLM agents",
  "Earthquakes this week",
] as const;

const KINDS: readonly ListingKind[] = ["service", "dataset", "feed", "lookup"];

export function kindLabel(kind: ListingKind): string {
  if (kind === "dataset") return "Dataset";
  if (kind === "feed") return "Feed";
  if (kind === "lookup") return "Lookup";
  return "Service";
}

export function kindHint(kind: ListingKind): string {
  if (kind === "dataset") return "Full table · JSON + CSV download";
  if (kind === "feed") return "Recent items · filter by date or text";
  if (kind === "lookup") return "Answer one question · inline JSON";
  return "Agent service · schema-validated result";
}

/** `0.010000` → `0.01`. */
export function formatUsdc(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}.${trimmed.length >= 2 ? trimmed : trimmed.padEnd(2, "0")}`;
}

/** "just now", "12 min ago", "3 h ago", "4 d ago". */
export function formatAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "not collected yet";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60).toString()} min ago`;
  if (seconds < 86_400 * 2) return `${Math.round(seconds / 3600).toString()} h ago`;
  return `${Math.round(seconds / 86_400).toString()} d ago`;
}

export function freshnessLine(freshness: NeedFreshness | null, now: number = Date.now()): string | null {
  if (!freshness) return null;
  if (freshness.status === "live") return `Live query${freshness.refreshCadence ? ` · ${freshness.refreshCadence}` : ""}`;
  const parts = [`Updated ${formatAge(freshness.lastRefreshedAt, now)}`];
  if (freshness.refreshCadence) parts.push(freshness.refreshCadence);
  if (freshness.rowCount !== null && freshness.rowCount > 0) parts.push(`${freshness.rowCount.toLocaleString("en-US")} rows`);
  return parts.join(" · ");
}

export function readNeedResponse(payload: unknown): NeedResponseView {
  if (!isRecord(payload) || !Array.isArray(payload.matches)) throw new Error("Need response was incomplete.");
  const matches: NeedMatchView[] = [];
  for (const item of payload.matches) {
    const match = readMatch(item);
    if (match) matches.push(match);
  }
  const unmet = isRecord(payload.unmet) && typeof payload.unmet.message === "string" ? payload.unmet.message : null;
  return {
    need: typeof payload.need === "string" ? payload.need : "",
    matched: payload.matched === true,
    weak: payload.weak === true,
    matches,
    unmetMessage: unmet,
  };
}

function readMatch(item: unknown): NeedMatchView | null {
  if (!isRecord(item) || typeof item.listingId !== "string" || typeof item.name !== "string") return null;
  const freshness = isRecord(item.freshness)
    ? {
        lastRefreshedAt: typeof item.freshness.lastRefreshedAt === "string" ? item.freshness.lastRefreshedAt : null,
        refreshCadence: typeof item.freshness.refreshCadence === "string" ? item.freshness.refreshCadence : null,
        status: typeof item.freshness.status === "string" ? item.freshness.status : "unknown",
        rowCount: typeof item.freshness.rowCount === "number" ? item.freshness.rowCount : null,
      }
    : null;
  const source =
    isRecord(item.source) && typeof item.source.name === "string" && typeof item.source.license === "string"
      ? { name: item.source.name, license: item.source.license, url: typeof item.source.url === "string" ? item.source.url : "" }
      : null;
  return {
    listingId: item.listingId,
    name: item.name,
    kind: readKind(item.kind),
    summary: typeof item.summary === "string" ? item.summary : "",
    priceUsdc: typeof item.priceUsdc === "string" ? item.priceUsdc : "0",
    relevance: typeof item.relevance === "number" ? item.relevance : 0,
    seller: typeof item.seller === "string" ? item.seller : null,
    freshness,
    source,
    sample: Array.isArray(item.sample) ? item.sample.filter(isRecord).slice(0, 5) : [],
    inputExample: isRecord(item.inputExample) ? item.inputExample : {},
    p95Ms: typeof item.p95Ms === "number" ? item.p95Ms : 0,
  };
}

export function readBuyResponse(payload: unknown): BuyResponseView {
  if (!isRecord(payload) || !isRecord(payload.receipt) || !isRecord(payload.job)) throw new Error("Buy response was incomplete.");
  const result = payload.result;
  const urls = isRecord(result) ? result : {};
  return {
    status: typeof payload.status === "string" ? payload.status : "unknown",
    delivered: payload.delivered === true,
    result,
    amountUsdc: typeof payload.receipt.amountUsdc === "string" ? payload.receipt.amountUsdc : "0",
    listingName: typeof payload.receipt.listingName === "string" ? payload.receipt.listingName : "",
    jobId: typeof payload.job.id === "string" ? payload.job.id : "",
    buyerBalanceUsdc: typeof payload.receipt.buyerBalanceUsdc === "string" ? payload.receipt.buyerBalanceUsdc : "",
    jsonUrl: typeof urls.jsonUrl === "string" ? urls.jsonUrl : null,
    csvUrl: typeof urls.csvUrl === "string" ? urls.csvUrl : null,
  };
}

export function readDataProduct(payload: unknown): DataProductView | null {
  if (!isRecord(payload) || typeof payload.slug !== "string" || typeof payload.name !== "string") return null;
  return {
    slug: payload.slug,
    name: payload.name,
    kind: readKind(payload.kind),
    description: typeof payload.description === "string" ? payload.description : "",
    priceUsdc: typeof payload.priceUsdc === "string" ? payload.priceUsdc : "0",
    refreshCadence: typeof payload.refreshCadence === "string" ? payload.refreshCadence : "",
    live: payload.live === true,
    status: typeof payload.status === "string" ? payload.status : "unknown",
    lastRefreshedAt: typeof payload.lastRefreshedAt === "string" ? payload.lastRefreshedAt : null,
    rowCount: typeof payload.rowCount === "number" ? payload.rowCount : 0,
    bytes: typeof payload.bytes === "number" ? payload.bytes : 0,
    columns: Array.isArray(payload.columns)
      ? payload.columns.filter(isRecord).map((column) => ({
          name: typeof column.name === "string" ? column.name : "",
          type: typeof column.type === "string" ? column.type : "",
          ...(typeof column.description === "string" ? { description: column.description } : {}),
        }))
      : [],
    sample: Array.isArray(payload.sample) ? payload.sample.filter(isRecord) : [],
    sources: Array.isArray(payload.sources)
      ? payload.sources.filter(isRecord).map((source) => ({
          name: typeof source.name === "string" ? source.name : "",
          url: typeof source.url === "string" ? source.url : "",
          license: typeof source.license === "string" ? source.license : "",
          ...(typeof source.licenseUrl === "string" ? { licenseUrl: source.licenseUrl } : {}),
          ...(typeof source.attribution === "string" ? { attribution: source.attribution } : {}),
        }))
      : [],
    example: payload.example ?? null,
    formats: Array.isArray(payload.formats) ? payload.formats.filter((value): value is string => typeof value === "string") : [],
    delivery: typeof payload.delivery === "string" ? payload.delivery : "inline",
    listingId: typeof payload.listingId === "string" ? payload.listingId : null,
  };
}

/** Render a cell from a sample row: short, single-line, never an object dump. */
export function sampleCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 48 ? `${value.slice(0, 47)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const json = JSON.stringify(value);
  return json.length > 48 ? `${json.slice(0, 47)}…` : json;
}

/** Up to `max` column names that appear in the sample rows, in first-seen order. */
export function sampleColumns(rows: readonly Record<string, unknown>[], max = 6): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.includes(key)) seen.push(key);
      if (seen.length >= max) return seen;
    }
  }
  return seen;
}

function readKind(value: unknown): ListingKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value) ? (value as ListingKind) : "service";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
